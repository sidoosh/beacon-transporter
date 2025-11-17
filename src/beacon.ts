import type {
  BeaconFunc,
  BeaconInit,
  IRetryDBBase,
  RequestNetworkError,
  RequestPersisted,
  RequestResponseError,
  RequestResult,
  RequiredInMemoryRetryConfig,
  RequiredPersistenceRetryConfig,
} from './interfaces';
import { fetchFn, isGlobalFetchSupported } from './network';
import { RetryDB } from './queue';
import { createHeaders, debug, sleep } from './utils';

/**
 * HTTP Status Code constants
 */
const HTTP_STATUS_CODES = {
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
} as const;

/**
 * Constants for error handling
 */
const ERROR_MESSAGES = {
  PARSE_RESPONSE_RETRY_EXHAUSTED: 'parseResponseForRetry exhausted retries'
} as const;

/**
 * 502 Bad Gateway
 * 504 Gateway Timeout
 */
const defaultInMemoryRetryStatusCodes = [
  HTTP_STATUS_CODES.BAD_GATEWAY,
  HTTP_STATUS_CODES.GATEWAY_TIMEOUT
];
/**
 * 429 Too Many Requests
 * 503 Service Unavailable
 */
const defaultPersistRetryStatusCodes = [
  HTTP_STATUS_CODES.TOO_MANY_REQUESTS,
  HTTP_STATUS_CODES.SERVICE_UNAVAILABLE
];

class Beacon<RetryDBType extends IRetryDBBase> {
  private timestamp: number;
  private isClearQueuePending = false;
  private onClearCallback: () => void;

  constructor(
    private url: string,
    private body: string,
    private config: RequiredInMemoryRetryConfig,
    private persistenceConfig: {
      db: RetryDBType;
      disabled: boolean;
      statusCodes: number[];
    },
    private compress: boolean = false,
    private parseResponseForRetry?: (responseBody: string, originalPayload: string) => string | null
  ) {
    this.timestamp = Date.now();
    this.onClearCallback = () => (this.isClearQueuePending = true);
  }

  send(headers: Record<string, string> = {}): Promise<RequestResult> {
    this.persistenceConfig.db.onClear(this.onClearCallback);
    const initialRetryCountLeft = this.retryLimit;
    return this.retry(
      (fetchHeaders: Record<string, string>) =>
        fetchFn(this.url, this.body, fetchHeaders, this.compress),
      initialRetryCountLeft,
      headers
    ).finally(() => {
      debug(() => 'beacon finished');
      this.persistenceConfig.db.removeOnClear(this.onClearCallback);
    });
  }

  private get retryLimit(): number {
    return this.config.attemptLimit;
  }

  private getAttemptCount(retryCountLeft: number): number {
    return this.retryLimit - retryCountLeft + 1;
  }

  /**
   * Retry executing a function
   *
   * @param fn - The function to retry, should return a promise that rejects with error as retry instruction or resolves if finished
   * @returns result of the retry operation, true if fn ever resolved during retry, false if all retry failed
   */
  private async retry(
    fn: (fetchHeaders: Record<string, string>) => ReturnType<typeof fetchFn>,
    retryCountLeft: number,
    headers: Record<string, string>,
    errorCode?: number
  ): Promise<RequestResult> {
    let currentRetryCount = retryCountLeft;
    let currentFn = fn;
    let currentErrorCode = errorCode;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const attemptCount = this.getAttemptCount(currentRetryCount) - 1;
      const fetchResult = await currentFn(
        createHeaders(headers, this.config.headerName, attemptCount, currentErrorCode)
      );

      fetchResult.drop = false;

      if (fetchResult.type === 'unknown' || fetchResult.type === 'success') {
        // Check for partial failures even on successful responses
        if (this.parseResponseForRetry && fetchResult.responseBody) {
          try {
            const retryPayload = this.parseResponseForRetry(fetchResult.responseBody, this.body);
            if (retryPayload && retryPayload.trim()) {
              // Partial failure detected - check if we can retry or should persist
              debug(() => `[IN-MEMORY] Partial failure detected, retrying with filtered payload`);

              if (currentRetryCount > 0) {
                // Still have in-memory retries left
                currentFn = (fetchHeaders: Record<string, string>) => {
                  return fetchFn(this.url, retryPayload, fetchHeaders, this.compress);
                };
                currentErrorCode = fetchResult.statusCode;
                currentRetryCount--; // Decrement retry count for parseResponseForRetry
                const waitMs = this.config.calculateRetryDelay(
                  this.getAttemptCount(currentRetryCount + 1),
                  currentRetryCount + 1
                );
                debug(() => `[IN-MEMORY] parseResponseForRetry in memory retry in ${waitMs}ms`);
                await sleep(waitMs);
                continue; // Continue the retry loop
              } else {
                // In-memory retries exhausted, check if should persist
                debug(() => `[IN-MEMORY] parseResponseForRetry retries exhausted, checking persistence`);

                // Create a synthetic error for shouldPersist check
                const syntheticError: RequestResponseError = {
                  type: 'response',
                  drop: true,
                  statusCode: fetchResult.statusCode as number,
                  rawError: ERROR_MESSAGES.PARSE_RESPONSE_RETRY_EXHAUSTED
                };

                if (this.shouldPersist(currentRetryCount, syntheticError)) {
                  const result: RequestPersisted = {
                    type: 'persisted',
                    drop: false,
                    statusCode: fetchResult.statusCode,
                  };
                  this.persistenceConfig.db.pushToQueue({
                    url: this.url,
                    body: retryPayload, // Use the filtered payload for persistence
                    headers,
                    statusCode: fetchResult.statusCode,
                    timestamp: this.timestamp,
                    attemptCount: 0, // Start fresh - persistence has its own attemptLimit
                  });
                  this.config.onIntermediateResult?.(result, retryPayload);
                  return result;
                } else {
                  // Can't persist, treat as final failure
                  fetchResult.drop = true;
                  this.config.onIntermediateResult?.(fetchResult, this.body);
                  return fetchResult;
                }
              }
            }
          } catch (error) {
            debug(() => `parseResponseForRetry threw error: ${String(error)}, treating as complete success`);
          }
        }

        // Complete success - no partial failures
        if (!this.isClearQueuePending && !this.persistenceConfig.disabled) {
          this.persistenceConfig.db.notifyQueue();
        }
        this.config.onIntermediateResult?.(fetchResult, this.body);
        return fetchResult;
      } else {
        debug(() => 'retry rejected ' + JSON.stringify(fetchResult));
        if (this.shouldPersist(currentRetryCount, fetchResult)) {
          const result: RequestPersisted = {
            type: 'persisted',
            drop: false,
            statusCode: fetchResult.statusCode,
          };
          this.persistenceConfig.db.pushToQueue({
            url: this.url,
            body: this.body,
            headers,
            statusCode: fetchResult.statusCode,
            timestamp: this.timestamp,
            attemptCount: 0, // Start fresh - persistence has its own attemptLimit
          });
          this.config.onIntermediateResult?.(result, this.body);
          return result;
        } else if (currentRetryCount > 0 && this.isRetryableError(fetchResult)) {
          this.config.onIntermediateResult?.(fetchResult, this.body);
          const waitMs = this.config.calculateRetryDelay(
            this.getAttemptCount(currentRetryCount),
            currentRetryCount
          );
          debug(() => `[IN-MEMORY] Regular retry in ${waitMs}ms`);
          await sleep(waitMs);
          currentRetryCount--;
          currentErrorCode = fetchResult.statusCode;
          continue; // Continue the retry loop
        } else {
          fetchResult.drop = true;
          this.config.onIntermediateResult?.(fetchResult, this.body);
          return fetchResult;
        }
      }
    }
  }

  private isRetryableError(
    error: RequestNetworkError | RequestResponseError
  ): boolean {
    if (
      error.type === 'network' ||
      this.config.statusCodes.includes(error.statusCode)
    ) {
      return true;
    }
    return false;
  }

  private shouldPersist(
    retryCountLeft: number,
    error: RequestNetworkError | RequestResponseError
  ): boolean {
    if (this.isClearQueuePending || this.persistenceConfig.disabled) {
      return false;
    }
    // Short-circuit if apparently offline or all back-off retries fail
    if (
      !navigator.onLine ||
      (retryCountLeft === 0 && error.type === 'network')
    ) {
      return true;
    }
    // Handle parseResponseForRetry exhausted retries
    if (
      retryCountLeft === 0 &&
      error.type === 'response' &&
      error.rawError === ERROR_MESSAGES.PARSE_RESPONSE_RETRY_EXHAUSTED
    ) {
      return true;
    }
    const fromStatusCode =
      error.type === 'response' &&
      this.persistenceConfig.statusCodes.includes(error.statusCode);
    if (fromStatusCode) {
      return true;
    }
    return false;
  }
}

/**
 * @public
 */
export function createBeacon(init?: BeaconInit): {
  beacon: BeaconFunc;
  database: RetryDB;
};
/**
 * @public
 */
export function createBeacon<CustomRetryDBType extends IRetryDBBase>(
  init?: BeaconInit<CustomRetryDBType>
): {
  beacon: BeaconFunc;
  database: CustomRetryDBType;
};
/**
 * @public
 */
export function createBeacon<CustomRetryDB extends IRetryDBBase = IRetryDBBase>(
  init: BeaconInit<CustomRetryDB> = {}
): {
  beacon: BeaconFunc;
  database: RetryDB | CustomRetryDB;
} {
  const compress = Boolean(init.compress);
  const inMemoryRetryConfig: RequiredInMemoryRetryConfig = Object.assign(
    {
      attemptLimit: 0,
      statusCodes: defaultInMemoryRetryStatusCodes,
      calculateRetryDelay: (_retryCountLeft: number, attemptCount: number) =>
        attemptCount * 2000,
    },
    init.inMemoryRetry
  );
  let retryDB: CustomRetryDB | RetryDB;
  if (init.retryDB) {
    retryDB = init.retryDB;
  } else {
    const retryDBConfig: RequiredPersistenceRetryConfig = Object.assign(
      {
        idbName: 'beacon-transporter',
        attemptLimit: 3,
        statusCodes: defaultPersistRetryStatusCodes,
        maxNumber: 1000,
        batchEvictionNumber: 300,
        throttleWait: 5 * 60 * 1000,
      },
      init.persistenceRetry
    );
    retryDBConfig.headerName =
      retryDBConfig.headerName || inMemoryRetryConfig.headerName;
    retryDBConfig.parseResponseForRetry = init.parseResponseForRetry;
    retryDB = new RetryDB(retryDBConfig, {
      compress: init.compress,
      disablePersistenceRetry: init.disablePersistenceRetry,
    });
  }

  const beacon: BeaconFunc = (url, body, headers) => {
    if (!isGlobalFetchSupported()) {
      return Promise.resolve({ type: 'unknown', drop: true });
    }
    return new Beacon(
      url,
      body,
      inMemoryRetryConfig,
      {
        db: retryDB,
        disabled: Boolean(init.disablePersistenceRetry),
        statusCodes:
          init.persistenceRetry?.statusCodes || defaultPersistRetryStatusCodes,
      },
      compress,
      init.parseResponseForRetry
    ).send(headers);
  };
  return { beacon, database: retryDB };
}
