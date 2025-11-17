import createTestServer, { Server } from '@xg-wang/create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';
import waitForExpect from 'wait-for-expect';

import type { createBeacon } from '../dist/';
import { log } from './utils';

expect.extend({
  toBeAround(actual, expected, range = 400) {
    const pass = Math.abs(expected - actual) < range / 2;
    if (pass) {
      return {
        message: () => `expected ${actual} not to be close to ${expected}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${actual} to be close to ${expected}`,
        pass: false,
      };
    }
  },
});

declare global {
  interface Window {
    createBeacon: typeof createBeacon;
    __DEBUG_BEACON_TRANSPORTER: boolean;
  }
  namespace jest {
    interface Matchers<R> {
      toBeAround(expected: number, delta?: number): R;
    }
  }
}

const script = {
  type: 'module',
  content: `
${fs.readFileSync(path.join(__dirname, '..', 'dist', 'bundle.esm.js'), 'utf8')}
self.createBeacon = createBeacon;
self.__DEBUG_BEACON_TRANSPORTER = true;
`,
};

const browsers = process.env.TEST_CHROME_ONLY
  ? ['chromium']
  : ['chromium', 'webkit', 'firefox'];

describe.each(browsers.map((t) => [t]))('[%s] beacon', (name) => {
  const browserType: BrowserType<Browser> = playwright[name];
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let server: Server;

  function closePage(p: Page): Promise<void> {
    return p.close({ runBeforeUnload: true });
  }

  beforeAll(async () => {
    log(`Launch ${name}`);
    browser = await browserType.launch({});
  });

  afterAll(async () => {
    log(`Close ${name}`);
    await browser.close();
  });

  beforeEach(async () => {
    log(expect.getState().currentTestName);
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
    server = await createTestServer();
    server.get('/', (_request, response) => {
      response.end('hello!');
    });
    page.on('console', async (msg) => {
      log(`[console.${msg.type()}]\t=> ${msg.text()}`);
    });
    await page.goto(server.url);
    await page.addScriptTag(script);
    await page.waitForFunction(
      () => window.__DEBUG_BEACON_TRANSPORTER === true
    );
  });

  afterEach(async () => {
    await context.close();
    await server.close();
  });

  it('should resolve to success type object', async () => {
    const results = [];
    server.post('/api', (request, response) => {
      results.push(request.body);
      response.end('hello');
    });
    const result = await page.evaluate((url) => {
      const { beacon } = window.createBeacon();
      return beacon(`${url}/api`, 'hello');
    }, server.url);
    if (name === 'firefox') {
      expect(result).toEqual({
        type: 'unknown',
        drop: false,
      });
    } else {
      expect(result).toEqual({
        type: 'success',
        drop: false,
        statusCode: 200,
        responseBody: 'hello',
      });
    }
    await waitForExpect(() => {
      expect(results).toEqual(['hello']);
    });
  });

  it('should resolve to rejection reason type object', async () => {
    const results = [];
    server.post('/api', (request, response) => {
      results.push(request.body);
      response.status(429).end('hello');
    });
    const result = await page.evaluate((url) => {
      const { beacon } = window.createBeacon();
      return beacon(`${url}/api`, 'hello');
    }, server.url);
    if (name === 'firefox') {
      expect(result).toEqual({
        type: 'unknown',
        drop: false,
      });
    } else {
      expect(result).toEqual({
        type: 'persisted',
        drop: false,
        statusCode: 429,
      });
    }
    await waitForExpect(() => {
      expect(results).toEqual(['hello']);
    });

    await page.route('**/api', (route) => {
      return route.abort('failed');
    });
    const networkResult = await page.evaluate((url) => {
      const { beacon } = window.createBeacon();
      return beacon(`${url}/api`, 'hello');
    }, server.url);
    if (name === 'firefox') {
      expect(result).toEqual({
        type: 'unknown',
        drop: false,
      });
    } else {
      expect(networkResult).toEqual({
        type: 'persisted',
        drop: false,
      });
    }
  });

  it('should send payload larger than 64kb', async () => {
    const results = [];
    server.post('/api', (request, response) => {
      results.push(request.body);
      response.end('hello');
    });
    await page.evaluate((url) => {
      return window.createBeacon().beacon(`${url}/api`, 's'.repeat(64_100));
    }, server.url);

    await waitForExpect(() => {
      expect(results[0].length).toEqual(64_100);
    });
  });

  if (
    name !== 'webkit' &&
    !(process.platform === 'linux' && name === 'chromium') &&
    !(process.platform === 'win32' && name === 'chromium')
  ) {
    // see https://bugs.webkit.org/show_bug.cgi?id=194897
    // navigator.sendBeacon does not work on visibilitychange callback for document unload
    // Possibly also playwright bug beforeunload / pagehide aren't firing

    it('should send payload on closing tab', async () => {
      const results = [];
      server.post('/api', (request, response) => {
        results.push(request.body);
        response.end('hello');
      });
      await page.evaluate(
        ([url, eventName]) => {
          document.addEventListener(eventName, function () {
            window.createBeacon().beacon(`${url}/api`, 'closing');
          });
        },
        [server.url, getCloseTabEvent(name)]
      );
      await closePage(page);

      await waitForExpect(() => {
        expect(results).toEqual(['closing']);
      });
    });
  }

  it('may not send payload larger than 64kb on closing tab', async () => {
    const results = [];
    server.post('/api', (request, response) => {
      results.push(request.body);
      response.end('hello');
    });
    await page.evaluate(
      ([url, eventName]) => {
        document.addEventListener(eventName, function () {
          window.createBeacon().beacon(`${url}/api`, 's'.repeat(64_100));
        });
      },
      [server.url, getCloseTabEvent(name)]
    );
    await closePage(page);

    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('if not firefox, retry configured times before giving up', async () => {
    server.post('/api', (_request, response) => {
      response.end('hello');
    });
    let numberOfRetries = 0;
    await page.route('**/api', (route) => {
      numberOfRetries++;
      route.abort();
    });
    await page.evaluate(
      ([url]) => {
        const { beacon } = window.createBeacon({
          inMemoryRetry: {
            attemptLimit: 2,
          },
        });
        return beacon(`${url}/api`, 'hi');
      },
      [server.url]
    );
    await waitForExpect(() => {
      expect(numberOfRetries).toBe(name === 'firefox' ? 1 : (2 + 1) * 2);
    }, 10000);
  });

  it('retry on server response statusCode', async () => {
    const requests1 = [];
    const requests2 = [];
    server.post('/api/retry', ({ headers }, res) => {
      requests1.push({
        header: headers['x-retry-context'],
      });
      res.sendStatus(502);
    });
    server.post('/api/noretry', ({ headers }, res) => {
      requests2.push({
        header: headers['x-retry-context'],
      });
      res.sendStatus(503);
    });
    await page.evaluate(
      ([url]) => {
        window
          .createBeacon({
            inMemoryRetry: {
              attemptLimit: 2,
              statusCodes: [502],
              headerName: 'x-retry-context',
            },
          })
          .beacon(`${url}/api/retry`, 'hi');
        window
          .createBeacon({
            inMemoryRetry: {
              attemptLimit: 2,
            },
          })
          .beacon(`${url}/api/noretry`, 'hi');
      },
      [server.url]
    );
    await waitForExpect(() => {
      if (name !== 'firefox') {
        expect(requests1.length).toBe(2 + 1);
      } else {
        expect(requests1.length).toBe(1);
      }
      expect(requests2.length).toBe(1);
    }, 10000);
    if (name !== 'firefox') {
      expect(requests1).toEqual([
        { header: undefined },
        { header: JSON.stringify({ attempt: 1, errorCode: 502 }) },
        { header: JSON.stringify({ attempt: 2, errorCode: 502 }) },
      ]);
    } else {
      expect(requests1[0]).toEqual({ header: undefined });
    }
  });

  it('can customize retry delay', async () => {
    const requests = [];
    server.post('/api/retry', (_request, response) => {
      requests.push(Date.now());
      response.sendStatus(502);
    });
    await page.evaluate(
      ([url]) => {
        const { beacon } = window.createBeacon({
          inMemoryRetry: {
            attemptLimit: 2,
            statusCodes: [502],
            calculateRetryDelay: (attemptCount) =>
              attemptCount === 1 ? 1 : 2000,
          },
        });
        beacon(`${url}/api/retry`, 'hi');
      },
      [server.url]
    );
    await waitForExpect(() => {
      expect(requests.length).toEqual(name === 'firefox' ? 1 : 3);
    });
    if (name !== 'firefox') {
      expect(requests[1] - requests[0]).toBeAround(1);
      expect(requests[2] - requests[1]).toBeAround(2000);
    }
  });

  it('can gzip compress payload', async () => {
    const requests = [];
    server.post('/api', (request, response) => {
      requests.push({
        encoding: request.header('content-encoding'),
        body: request.body,
      });
      response.sendStatus(200);
    });
    await page.evaluate(
      ([url]) => {
        const { beacon } = window.createBeacon({
          inMemoryRetry: {
            attemptLimit: 0,
          },
          compress: true,
        });
        beacon(`${url}/api`, 'hi');
      },
      [server.url]
    );
    await waitForExpect(() => {
      expect(requests.length).toEqual(1);
    });

    if (name !== 'firefox') {
      expect(requests[0].encoding).toBe('gzip');
    }
    // express knows gzip
    expect(requests[0].body).toBe('hi');
  });

  it('should handle partial retry with parseResponseForRetry function', async () => {
    const requests = [];
    let callCount = 0;

    server.post('/api', (request, response) => {
      callCount++;
      requests.push({
        body: request.body,
        attempt: callCount,
      });

      if (callCount === 1) {
        // First call - partial failure response (status 200 but with retry data)
        response.status(200).json({
          responses: [
            {
              id: "367",
              responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE"
            },
            {
              id: "368",
              responseStatus: "ResponseStatus_RETRYABLE_FAILURE"
            }
          ]
        });
      } else {
        // Second call - complete success
        response.status(200).json({
          responses: [
            {
              id: "368",
              responseStatus: "ResponseStatus_SUCCESS"
            }
          ]
        });
      }
    });

    const result = await page.evaluate(
      ([url]) => {
        const { beacon } = window.createBeacon({
          inMemoryRetry: {
            attemptLimit: 3,
            statusCodes: [500, 502, 503], // Note: 200 is not in retry codes, but parseResponseForRetry will handle it
            calculateRetryDelay: () => 100, // Short delay for testing
          },
          parseResponseForRetry: (responseBody, originalPayload) => {
            try {
              const response = JSON.parse(responseBody);
              const originalData = JSON.parse(originalPayload);

              // Find items that need retry based on response status
              const retryableItemIds = response.responses
                ?.filter(item => item.responseStatus === "ResponseStatus_RETRYABLE_FAILURE")
                ?.map(item => item.id) || [];

              if (retryableItemIds.length > 0) {
                // Get the original items that need retry from originalData
                const itemsToRetry = originalData.items?.filter(originalItem =>
                  retryableItemIds.includes(originalItem.id)
                ) || [];

                if (itemsToRetry.length > 0) {
                  // Return payload with only the original items that need retry
                  return JSON.stringify({
                    items: itemsToRetry
                  });
                }
              }

              return null; // No retry needed
            } catch (error) {
              console.error('parseResponseForRetry error:', error);
              return null;
            }
          }
        });

        // Send initial payload with multiple items
        return beacon(`${url}/api`, JSON.stringify({
          items: [
            { id: "367" },
            { id: "368" }
          ]
        }));
      },
      [server.url]
    );

    // Wait for both requests to complete
    await waitForExpect(() => {
      expect(requests.length).toEqual(2);
    }, 5000);

    // Verify the retry behavior
    expect(requests).toHaveLength(2);

    // First request should contain both items
    const firstRequest = JSON.parse(requests[0].body);
    expect(firstRequest.items).toHaveLength(2);
    expect(firstRequest.items).toEqual([
      { id: "367" },
      { id: "368" }
    ]);

    // Second request should only contain the retryable item
    const secondRequest = JSON.parse(requests[1].body);
    expect(secondRequest.items).toHaveLength(1);
    expect(secondRequest.items).toEqual([
      { id: "368" }
    ]);

    // Final result should be success
    expect(result.type).toBe('success');
  });

  it('should retry on 200 response with NON_RETRYABLE_FAILURE status', async () => {
    const requests = [];
    let callCount = 0;

    server.post('/api', (request, response) => {
      callCount++;
      requests.push({
        body: request.body,
        attempt: callCount,
      });

      if (callCount === 1) {
        // First call - mixed response with retryable and non-retryable items
        response.status(200).json({
          responses: [
            {
              id: "367",
              responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE" // Should NOT be retried
            },
            {
              id: "368",
              responseStatus: "ResponseStatus_RETRYABLE_FAILURE" // Should be retried
            },
            {
              id: "369",
              responseStatus: "ResponseStatus_SUCCESS" // Should NOT be retried
            }
          ]
        });
      } else {
        // Second call - success for the retried item
        response.status(200).json({
          responses: [
            {
              id: "368",
              responseStatus: "ResponseStatus_SUCCESS"
            }
          ]
        });
      }
    });

    const result = await page.evaluate(
      ([url]) => {
        const { beacon } = window.createBeacon({
          inMemoryRetry: {
            attemptLimit: 2,
            statusCodes: [500], // 200 not in retry codes, but parseResponseForRetry handles it
            calculateRetryDelay: () => 50,
          },
          parseResponseForRetry: (responseBody, originalPayload) => {
            try {
              const response = JSON.parse(responseBody);
              const originalData = JSON.parse(originalPayload);

              // Only retry items with RETRYABLE_FAILURE status
              const retryableItems = response.responses?.filter(item =>
                item.responseStatus === "ResponseStatus_RETRYABLE_FAILURE"
              ) || [];

              if (retryableItems.length > 0) {
                // Return payload with only retryable items
                return JSON.stringify({
                  id: retryableItems[0].id // For this test, we expect only one item
                });
              }

              return null; // No retry needed
            } catch (error) {
              return null;
            }
          }
        });

        return beacon(`${url}/api`, JSON.stringify({
          items: [
            { id: "367" },
            { id: "368" },
            { id: "369" }
          ]
        }));
      },
      [server.url]
    );

    // Wait for both requests
    await waitForExpect(() => {
      expect(requests.length).toEqual(2);
    }, 3000);

    expect(requests).toHaveLength(2);
    expect(result.type).toBe('success');

    // First request should contain all items
    const firstRequest = JSON.parse(requests[0].body);
    expect(firstRequest.items).toHaveLength(3);
    expect(firstRequest.items).toEqual([
      { id: "367" },
      { id: "368" },
      { id: "369" }
    ]);

    // Second request should only contain the retryable item (368)
    const secondRequest = JSON.parse(requests[1].body);
    expect(secondRequest).toEqual({ id: "368" });

    // Verify that NON_RETRYABLE_FAILURE (367) and SUCCESS (369) were NOT retried
  });

  it('should retry only RETRYABLE_FAILURE items, not NON_RETRYABLE_FAILURE', async () => {
    const requests = [];
    let callCount = 0;

    server.post('/api', (request, response) => {
      callCount++;
      requests.push({
        body: request.body,
        attempt: callCount,
      });

      if (callCount === 1) {
        // First call - mixed response with retryable and non-retryable items
        response.status(200).json({
          responses: [
            {
              id: "367",
              responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE" // Should NOT be retried
            },
            {
              id: "368",
              responseStatus: "ResponseStatus_RETRYABLE_FAILURE" // Should be retried
            },
            {
              id: "369",
              responseStatus: "ResponseStatus_SUCCESS" // Should NOT be retried
            }
          ]
        });
      } else {
        // Second call - success for the retried item
        response.status(200).json({
          responses: [
            {
              id: "368",
              responseStatus: "ResponseStatus_SUCCESS"
            }
          ]
        });
      }
    });

    const result = await page.evaluate(
      ([url]) => {
        const { beacon } = window.createBeacon({
          inMemoryRetry: {
            attemptLimit: 2,
            statusCodes: [500], // 200 not in retry codes, but parseResponseForRetry handles it
            calculateRetryDelay: () => 50,
          },
          parseResponseForRetry: (responseBody, originalPayload) => {
            try {
              const response = JSON.parse(responseBody);
              const originalData = JSON.parse(originalPayload);

              // Only retry items with RETRYABLE_FAILURE status
              const retryableItems = response.responses?.filter(item =>
                item.responseStatus === "ResponseStatus_RETRYABLE_FAILURE"
              ) || [];

              if (retryableItems.length > 0) {
                // Return payload with only retryable items
                return JSON.stringify({
                  id: retryableItems[0].id // For this test, we expect only one item
                });
              }

              return null; // No retry needed
            } catch (error) {
              return null;
            }
          }
        });

        return beacon(`${url}/api`, JSON.stringify({
          items: [
            { id: "367" },
            { id: "368" },
            { id: "369" }
          ]
        }));
      },
      [server.url]
    );

    // Wait for both requests
    await waitForExpect(() => {
      expect(requests.length).toEqual(2);
    }, 3000);

    expect(requests).toHaveLength(2);
    expect(result.type).toBe('success');

    // First request should contain all items
    const firstRequest = JSON.parse(requests[0].body);
    expect(firstRequest.items).toHaveLength(3);
    expect(firstRequest.items).toEqual([
      { id: "367" },
      { id: "368" },
      { id: "369" }
    ]);

    // Second request should only contain the retryable item (368)
    const secondRequest = JSON.parse(requests[1].body);
    expect(secondRequest).toEqual({ id: "368" });

    // Verify that NON_RETRYABLE_FAILURE (367) and SUCCESS (369) were NOT retried
  });
});

function getCloseTabEvent(
  browserName: string
): 'pagehide' | 'visibilitychange' {
  return browserName === 'webkit' ? 'pagehide' : 'visibilitychange';
}
