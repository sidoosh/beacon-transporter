import type { WithStore } from 'idb-queue';
import {
  clear,
  createStore,
  peek,
  peekBack,
  pushIfNotClearing,
  shift,
} from 'idb-queue';

import type {
  BeaconInit,
  IRetryDB,
  RequiredPersistenceRetryConfig,
  RetryEntry,
} from './interfaces';
import { fetchFn } from './network';
import {
  createHeaders,
  debug,
  logError,
  scheduleTask,
  throttle,
  ThrottleControl,
} from './utils';

interface IQueue {
  onNotify(): void;
  push(entry: RetryEntry): void;
  clear(): Promise<void>;
  peek(count: number): Promise<RetryEntry[]>;
  peekBack(count: number): Promise<RetryEntry[]>;
}

class Queue implements IQueue {
  private throttleControl: ThrottleControl;
  private withStore: WithStore;
  private disablePersistence = false;

  constructor(
    private config: RequiredPersistenceRetryConfig,
    private compress = false
  ) {
    const measureMarks = config.measureIDB;
    if (measureMarks) {
      performance.mark(measureMarks.createStartMark);
    }
    this.withStore = createStore(config.idbName, 'beacons', 'timestamp', {
      onSuccess: () => {
        if (measureMarks) {
          performance.measure(
            measureMarks.createSuccessMeasure,
            measureMarks.createStartMark
          );
        }
      },
      onError: () => {
        if (measureMarks) {
          performance.measure(
            measureMarks.createFailMeasure,
            measureMarks.createStartMark
          );
        }
        this.disablePersistence = true;
      },
    });
    this.throttleControl = throttle(
      this.replayEntries.bind(this),
      config.throttleWait
    );
  }

  public onNotify(): void {
    debug(() => '[IndexedDB Queue] onNotify() called');
    if (this.disablePersistence) {
      debug(() => '[IndexedDB Queue] Persistence disabled, skipping');
      return;
    }
    debug(() => '[IndexedDB Queue] Calling throttledFn()');
    this.throttleControl.throttledFn();
  }

  public push(entry: RetryEntry): void {
    if (this.disablePersistence) {
      return;
    }
    const runPushTask = (): void => {
      debug(() => 'Persisting to DB ' + entry.url);
      pushIfNotClearing(entry, this.config, this.withStore)
        .then(() => {
          this.throttleControl.resetThrottle();
          debug(() => 'push completed');
        })
        .catch(() => {
          this.disablePersistence = true;
          logError(() => 'push failed');
        });
    };
    this.config.useIdle ? scheduleTask(runPushTask) : runPushTask();
  }

  public clear(): Promise<void> {
    if (this.disablePersistence) {
      return Promise.resolve();
    }
    return clear(this.withStore).catch(() => {
      this.disablePersistence = true;
      logError(() => 'clear failed');
    });
  }

  public peek(count = 1): Promise<RetryEntry[]> {
    if (this.disablePersistence) {
      return Promise.resolve([]);
    }
    return peek<RetryEntry>(count, this.withStore).catch(() => {
      this.disablePersistence = true;
      logError(() => 'peek failed');
      return [];
    });
  }

  public peekBack(count = 1): Promise<RetryEntry[]> {
    if (this.disablePersistence) {
      return Promise.resolve([]);
    }
    return peekBack<RetryEntry>(count, this.withStore).catch(() => {
      this.disablePersistence = true;
      logError(() => 'peekBack failed');
      return [];
    });
  }

  private replayEntries(): void {
    if (this.disablePersistence) {
      return;
    }
    const runReplayEntriesTask = (): void => {
      debug(() => '[IndexedDB Replay] Starting replayEntries task');
      shift<RetryEntry>(1, this.withStore)
        .then((entries) => {
          debug(() => `[IndexedDB Replay] Retrieved ${entries.length} entries from IndexedDB`);
          if (entries.length > 0) {
            const { url, body, headers, timestamp, statusCode, attemptCount } =
              entries[0];
            debug(() => `[IndexedDB Replay] Processing entry: ${JSON.stringify({ url, body, timestamp, statusCode, attemptCount })}`);
            debug(
              () =>
                `[IndexedDB Replay] header: ${String(
                  this.config.headerName
                )}; attemptCount: ${attemptCount}`
            );
            this.config.onBeforeRetry?.(body);
            return fetchFn(
              url,
              body,
              createHeaders(
                headers,
                this.config.headerName,
                attemptCount,
                statusCode
              ),
              this.compress
            ).then((fetchResult) => {
              if (
                fetchResult.type === 'unknown' ||
                fetchResult.type === 'success'
              ) {
                // Check for partial failures even on successful responses
                if (this.config.parseResponseForRetry && fetchResult.responseBody) {
                  debug(() => `[PERSISTENCE] Checking parseResponseForRetry for successful response`);
                  debug(() => `[PERSISTENCE] Response body: ${fetchResult.responseBody}`);
                  debug(() => `[PERSISTENCE] Original body: ${body}`);
                  try {
                    const retryPayload = this.config.parseResponseForRetry(fetchResult.responseBody, body);
                    debug(() => `[PERSISTENCE] parseResponseForRetry returned: ${retryPayload}`);
                    if (retryPayload && retryPayload.trim()) {
                      // Partial failure detected - re-store with filtered payload
                      debug(() => `[PERSISTENCE] Partial failure detected, re-storing filtered payload`);
                      debug(() => `[PERSISTENCE] Current attemptCount: ${attemptCount}, attemptLimit: ${this.config.attemptLimit}`);

                      if (attemptCount >= this.config.attemptLimit) {
                        debug(() => `[PERSISTENCE] Exceeded attempt count (${attemptCount} >= ${this.config.attemptLimit}), dropping entry`);
                        fetchResult.drop = true;
                        this.config.onResult?.(fetchResult, body);
                        debug(() => `[PERSISTENCE] Entry dropped, continuing to process remaining entries`);
                        // Continue processing remaining entries immediately
                        this.replayEntries();
                        return;
                      }

                      // Re-store with filtered payload and incremented attempt count
                      // Use original timestamp to maintain entry identity and prevent duplicates
                      const newEntry = {
                        url,
                        body: retryPayload, // Use filtered payload
                        headers,
                        statusCode: fetchResult.statusCode, // Update to actual response status
                        timestamp, // Keep original timestamp to prevent duplicates
                        attemptCount: attemptCount + 1,
                      };
                      debug(() => `[PERSISTENCE] Re-storing entry with same timestamp: ${JSON.stringify(newEntry)}`);

                      return pushIfNotClearing(
                        newEntry,
                        this.config,
                        this.withStore
                      ).then(() => {
                        debug(() => `[PERSISTENCE] Entry re-stored successfully, will be retried when throttle allows`);
                        // Don't trigger immediate processing - let natural throttle cycle handle it
                        // The onNotify() from pushIfNotClearing will be throttled naturally
                      }).catch((error) => {
                        debug(() => `[PERSISTENCE] Failed to re-store entry: ${String(error)}`);
                      });
                    } else {
                      debug(() => `[PERSISTENCE] No retry payload returned, treating as complete success`);
                    }
                  } catch (error) {
                    debug(() => `[PERSISTENCE] parseResponseForRetry threw error: ${String(error)}, treating as success`);
                  }
                } else {
                  debug(() => `[PERSISTENCE] No parseResponseForRetry function or no response body`);
                }

                // Complete success - no partial failures
                debug(() => `[PERSISTENCE] Complete success, continuing to process remaining entries`);
                this.config.onResult?.(fetchResult, body);
                // Continue processing remaining entries immediately
                this.replayEntries();
              } else {
                if (attemptCount >= this.config.attemptLimit) {
                  debug(
                    () =>
                      'Exceeded attempt count, dropping the entry: ' +
                      JSON.stringify(
                        {
                          url,
                          timestamp,
                          statusCode,
                        },
                        null,
                        2
                      )
                  );
                  fetchResult.drop = true;
                  this.config.onResult?.(fetchResult, body);
                  debug(() => `[PERSISTENCE] Regular retry entry dropped, continuing to process remaining entries`);
                  // Continue processing remaining entries immediately
                  this.replayEntries();
                  return;
                }
                if (
                  fetchResult.type === 'network' ||
                  this.config.statusCodes.includes(fetchResult.statusCode)
                ) {
                  fetchResult.drop = false;
                  this.config.onResult?.(fetchResult, body);
                  debug(
                    () =>
                      'Replaying the entry failed, pushing back to IDB: ' +
                      JSON.stringify(
                        {
                          url,
                          timestamp,
                          statusCode,
                        },
                        null,
                        2
                      )
                  );
                  return pushIfNotClearing(
                    {
                      url,
                      body,
                      timestamp,
                      statusCode,
                      attemptCount: attemptCount + 1,
                    },
                    this.config,
                    this.withStore
                  );
                } else {
                  fetchResult.drop = true;
                  this.config.onResult?.(fetchResult, body);
                }
              }
            });
          } else {
            debug(() => `[IndexedDB Replay] No more entries in IndexedDB queue`);
          }
        })
        .catch((reason: DOMException) => {
          this.disablePersistence = true;
          if (reason && reason.message) {
            logError(() => `Replay entry failed: ${reason.message}`);
          }
        });
    };
    this.config.useIdle
      ? scheduleTask(runReplayEntriesTask)
      : runReplayEntriesTask();
  }
}

class NoopQueue implements IQueue {
  onNotify(): void {
    // noop
  }
  push(): void {
    // noop
  }
  clear(): Promise<void> {
    return Promise.resolve();
  }
  peek(): Promise<RetryEntry[]> {
    return Promise.resolve([]);
  }
  peekBack(): Promise<RetryEntry[]> {
    return Promise.resolve([]);
  }
}

/**
 * @public
 */
export class RetryDB implements IRetryDB {
  static hasSupport =
    typeof globalThis !== 'undefined' && !!globalThis.indexedDB;

  private queue: IQueue;
  private beaconListeners = new Set<() => void>();

  constructor(
    config: RequiredPersistenceRetryConfig,
    extraConfig: Pick<BeaconInit, 'compress' | 'disablePersistenceRetry'>
  ) {
    this.queue =
      RetryDB.hasSupport && !extraConfig.disablePersistenceRetry
        ? new Queue(config, extraConfig.compress)
        : new NoopQueue();
  }

  pushToQueue(entry: RetryEntry): void {
    this.queue.push(entry);
  }

  notifyQueue(): void {
    this.queue.onNotify();
  }

  clearQueue(): Promise<void> {
    this.beaconListeners.forEach((cb) => cb());
    return this.queue.clear();
  }

  peekQueue(count: number): Promise<RetryEntry[]> {
    return this.queue.peek(count);
  }

  peekBackQueue(count: number): Promise<RetryEntry[]> {
    return this.queue.peekBack(count);
  }

  onClear(cb: () => void): void {
    this.beaconListeners.add(cb);
  }
  removeOnClear(cb: () => void): void {
    this.beaconListeners.delete(cb);
  }
}
