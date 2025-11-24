const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();
const port = 3001;

app.use(express.static(path.join(__dirname, 'client')));
app.use('/dist', express.static(path.join(__dirname, '/../dist')));
app.use(bodyParser.text());

app.post('/api', ({ body }, res) => {
  console.log(`/api => { body: ${body} }`);
  res.send('ok');
});

// Demo endpoints for parseResponseForRetry testing
let requestCounts = {};

// Reset endpoint to clear request counts
app.post('/api/reset', (req, res) => {
  requestCounts = {};
  console.log('Request counts reset');
  res.json({ message: 'Request counts reset' });
});

app.post('/api/partial-retry', ({ body }, res) => {
  const key = 'partial-retry';
  requestCounts[key] = (requestCounts[key] || 0) + 1;
  const count = requestCounts[key];

  console.log(`/api/partial-retry [${count}] => { body: ${body} }`);

  if (count === 1) {
    // First request - mixed response statuses
    res.status(200).json({
      responses: [
        { id: "item1", responseStatus: "ResponseStatus_SUCCESS" },
        { id: "item2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" },
        { id: "item3", responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE" }
      ]
    });
  } else if (count <= 4) {
    // Requests 2-4 - keep failing to test in-memory exhaustion and IndexedDB persistence
    res.status(200).json({
      responses: [
        { id: "item2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" }
      ]
    });
  } else {
    // Request 5+ - success for retried items (from IndexedDB)
    res.status(200).json({
      responses: [
        { id: "item2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  }
});

app.post('/api/all-success', ({ body }, res) => {
  console.log(`/api/all-success => { body: ${body} }`);
  res.status(200).json({
    responses: [
      { id: "item1", responseStatus: "ResponseStatus_SUCCESS" },
      { id: "item2", responseStatus: "ResponseStatus_SUCCESS" },
      { id: "item3", responseStatus: "ResponseStatus_SUCCESS" }
    ]
  });
});

app.post('/api/all-non-retryable', ({ body }, res) => {
  console.log(`/api/all-non-retryable => { body: ${body} }`);
  res.status(200).json({
    responses: [
      { id: "item1", responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE" },
      { id: "item2", responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE" },
      { id: "item3", responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE" }
    ]
  });
});

app.post('/api/server-error', ({ body }, res) => {
  console.log(`/api/server-error => { body: ${body} }`);
  res.status(500).send('Internal Server Error');
});

app.post('/api/exhaust-retry', ({ body, headers }, res) => {
  const key = 'exhaust-retry';
  requestCounts[key] = (requestCounts[key] || 0) + 1;
  const count = requestCounts[key];

  // Extract retry context for debugging
  const retryContext = headers['x-retry-context'];
  let retryInfo = null;
  if (retryContext) {
    try {
      retryInfo = JSON.parse(retryContext);
    } catch (e) {
      // ignore parse errors
    }
  }

  console.log(`[EXHAUST-RETRY] Request #${count} => {`);
  console.log(`  body: ${body}`);
  console.log(`  retryContext: ${retryContext || 'none'}`);
  console.log(`  attemptCount: ${retryInfo?.attempt || 'N/A'}`);
  console.log(`  errorCode: ${retryInfo?.errorCode || 'N/A'}`);
  console.log(`  timestamp: ${new Date().toISOString()}`);
  console.log(`}`);

  if (count <= 10) {
    // First 10 requests - always return retryable failure with 200 status
    console.log(`[EXHAUST-RETRY] Returning RETRYABLE_FAILURE (count ${count} <= 10)`);
    res.status(200).json({
      responses: [
        { id: "item1", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" },
        { id: "item2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" }
      ]
    });
  } else {
    // After persistence retry - success
    console.log(`[EXHAUST-RETRY] Returning SUCCESS (count ${count} > 10)`);
    res.status(200).json({
      responses: [
        { id: "item1", responseStatus: "ResponseStatus_SUCCESS" },
        { id: "item2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  }
});

app.post('/api/direct-persist', ({ body }, res) => {
  const key = 'direct-persist';
  requestCounts[key] = (requestCounts[key] || 0) + 1;
  const count = requestCounts[key];

  console.log(`/api/direct-persist [${count}] => { body: ${body} }`);

  if (count <= 3) {
    // First 3 requests - return 500 to trigger direct IndexedDB storage
    res.status(500).json({
      responses: [
        { id: "direct1", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" },
        { id: "direct2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" }
      ]
    });
  } else {
    // After IndexedDB retries - success
    res.status(200).json({
      responses: [
        { id: "direct1", responseStatus: "ResponseStatus_SUCCESS" },
        { id: "direct2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  }
});

app.post('/api/success-on-third-persistence', ({ body }, res) => {
  const key = 'success-on-third-persistence';
  requestCounts[key] = (requestCounts[key] || 0) + 1;
  const count = requestCounts[key];

  console.log(`/api/success-on-third-persistence [${count}] => { body: ${body} }`);

  if (count <= 3) {
    // First 3 requests (in-memory retries) - partial failure to trigger persistence
    res.status(200).json({
      responses: [
        { id: "item1", responseStatus: "ResponseStatus_SUCCESS" },
        { id: "item2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" },
        { id: "item3", responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE" }
      ]
    });
  } else if (count === 4 || count === 5) {
    // Persistence attempts 1 & 2 (attemptCount 0 & 1) - keep failing
    res.status(200).json({
      responses: [
        { id: "item2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" }
      ]
    });
  } else if (count === 6) {
    // Persistence attempt 3 (attemptCount 2) - SUCCESS!
    res.status(200).json({
      responses: [
        { id: "item2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  } else {
    // Any additional requests - success
    res.status(200).json({
      responses: [
        { id: "item2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  }
});

// Header testing endpoints
app.post('/api/header-test/:status', ({ params, body, headers }, res) => {
  const status = +params.status;
  const retryContext = headers['x-retry-context'];

  // Extract relevant headers for logging
  const relevantHeaders = {
    'x-retry-context': retryContext,
    'authorization': headers['authorization'],
    'user-agent': headers['user-agent'],
    'x-request-id': headers['x-request-id'],
    'x-demo-header': headers['x-demo-header'],
    'content-type': headers['content-type'],
    'content-encoding': headers['content-encoding']
  };

  // Remove undefined headers
  Object.keys(relevantHeaders).forEach(key => {
    if (relevantHeaders[key] === undefined) {
      delete relevantHeaders[key];
    }
  });

  const logData = {
    status,
    body: body.substring(0, 200) + (body.length > 200 ? '...' : ''),
    headers: relevantHeaders,
    timestamp: new Date().toISOString()
  };

  console.log(`[HEADER-TEST] /api/header-test/${status} =>`, JSON.stringify(logData, null, 2));

  // Parse retry context if present
  let retryInfo = null;
  if (retryContext) {
    try {
      retryInfo = JSON.parse(retryContext);
      console.log(`[RETRY-INFO] Attempt: ${retryInfo.attempt}, Error Code: ${retryInfo.errorCode || 'N/A'}`);
    } catch (e) {
      console.log(`[RETRY-INFO] Failed to parse retry context: ${retryContext}`);
    }
  }

  // Response based on status
  if (status === 200) {
    res.status(200).json({
      message: 'Success!',
      receivedHeaders: relevantHeaders,
      retryInfo,
      serverTime: new Date().toISOString()
    });
  } else if (status === 502 || status === 504) {
    // In-memory retry scenarios
    res.status(status).json({
      error: `${status === 502 ? 'Bad Gateway' : 'Gateway Timeout'}`,
      message: 'This will trigger in-memory retry',
      receivedHeaders: relevantHeaders,
      retryInfo,
      serverTime: new Date().toISOString()
    });
  } else if (status === 429 || status === 503 || status === 500) {
    // Persistent retry scenarios
    res.status(status).json({
      error: status === 429 ? 'Too Many Requests' :
        status === 503 ? 'Service Unavailable' : 'Internal Server Error',
      message: 'This will trigger persistent retry',
      receivedHeaders: relevantHeaders,
      retryInfo,
      serverTime: new Date().toISOString()
    });
  } else {
    res.status(status).json({
      error: 'Unknown status',
      receivedHeaders: relevantHeaders,
      retryInfo,
      serverTime: new Date().toISOString()
    });
  }
});

// Counter behavior test: Exact scenario replication
app.post('/api/counter-behavior-test', ({ body, headers }, res) => {
  const key = 'counter-behavior-test';
  requestCounts[key] = (requestCounts[key] || 0) + 1;
  const count = requestCounts[key];

  // Extract retry context for debugging
  const retryContext = headers['x-retry-context'];
  let retryInfo = null;
  if (retryContext) {
    try {
      retryInfo = JSON.parse(retryContext);
    } catch (e) {
      // ignore parse errors
    }
  }

  console.log(`[COUNTER-BEHAVIOR] Request #${count} => {`);
  console.log(`  body: ${body}`);
  console.log(`  retryContext: ${retryContext || 'none'}`);
  console.log(`  attemptCount: ${retryInfo?.attempt || 'N/A'}`);
  console.log(`  errorCode: ${retryInfo?.errorCode || 'N/A'}`);
  console.log(`  isInMemory: ${!retryContext ? 'YES (original)' : retryInfo?.errorCode === 500 ? 'YES (in-memory)' : 'NO (persistence)'}`);
  console.log(`  timestamp: ${new Date().toISOString()}`);
  console.log(`}`);

  // Exact scenario: 500 → 500 (in-memory) → 500 (persistence 1) → RETRYABLE_FAILURE (persistence 2) → SUCCESS (persistence 3)
  if (count <= 3) {
    // Requests 1-3: All return 500 errors
    const phase = count === 1 ? 'original' : count === 2 ? 'in-memory retry' : 'persistence attempt 1';
    console.log(`[COUNTER-BEHAVIOR] Request ${count} (${phase}) → Returning 500 error`);
    res.status(500).json({
      error: 'Internal Server Error',
      message: `Request ${count}: 500 error for ${phase}`,
      serverTime: new Date().toISOString()
    });
  } else if (count === 4) {
    // Request 4: Should be persistence attempt 2 with attemptCount: 2
    console.log(`[COUNTER-BEHAVIOR] Request 4 (persistence attempt 2) → Returning RETRYABLE_FAILURE`);
    console.log(`[COUNTER-BEHAVIOR] 🔍 CRITICAL CHECK: attemptCount should be 2, got: ${retryInfo?.attempt || 'N/A'}`);
    if (retryInfo?.attempt === 2) {
      console.log(`[COUNTER-BEHAVIOR] ✅ CORRECT: Counter is 2 (not reset)`);
    } else {
      console.log(`[COUNTER-BEHAVIOR] ❌ ERROR: Counter is ${retryInfo?.attempt}, should be 2!`);
    }
    res.status(200).json({
      responses: [
        { id: "counter1", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" },
        { id: "counter2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" }
      ]
    });
  } else if (count === 5) {
    // Request 5: Should be persistence attempt 3 with attemptCount: 3
    console.log(`[COUNTER-BEHAVIOR] Request 5 (persistence attempt 3) → Returning SUCCESS`);
    console.log(`[COUNTER-BEHAVIOR] 🔍 FINAL CHECK: attemptCount should be 3, got: ${retryInfo?.attempt || 'N/A'}`);
    if (retryInfo?.attempt === 3) {
      console.log(`[COUNTER-BEHAVIOR] ✅ CORRECT: Final attempt with counter 3`);
    } else {
      console.log(`[COUNTER-BEHAVIOR] ❌ ERROR: Counter is ${retryInfo?.attempt}, should be 3!`);
    }
    res.status(200).json({
      responses: [
        { id: "counter1", responseStatus: "ResponseStatus_SUCCESS" },
        { id: "counter2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  } else {
    // Shouldn't reach here
    console.log(`[COUNTER-BEHAVIOR] ⚠️  Unexpected request count: ${count} (should not exceed 5)`);
    res.status(200).json({
      responses: [
        { id: "counter1", responseStatus: "ResponseStatus_SUCCESS" },
        { id: "counter2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  }
});

// Simple scenario: 500 → RETRYABLE_FAILURE → SUCCESS
app.post('/api/simple-scenario', ({ body, headers }, res) => {
  const key = 'simple-scenario';
  requestCounts[key] = (requestCounts[key] || 0) + 1;
  const count = requestCounts[key];

  // Extract retry context for debugging
  const retryContext = headers['x-retry-context'];
  let retryInfo = null;
  if (retryContext) {
    try {
      retryInfo = JSON.parse(retryContext);
    } catch (e) {
      // ignore parse errors
    }
  }

  console.log(`[SIMPLE-SCENARIO] Request #${count} => {`);
  console.log(`  body: ${body}`);
  console.log(`  retryContext: ${retryContext || 'none'}`);
  console.log(`  attemptCount: ${retryInfo?.attempt || 'N/A'}`);
  console.log(`  errorCode: ${retryInfo?.errorCode || 'N/A'}`);
  console.log(`  timestamp: ${new Date().toISOString()}`);
  console.log(`}`);

  if (count === 1) {
    // First call: 500 error
    console.log(`[SIMPLE-SCENARIO] Call 1 → Returning 500 error`);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'First call - 500 error',
      serverTime: new Date().toISOString()
    });
  } else if (count === 2) {
    // Second call: 200 with RETRYABLE_FAILURE
    console.log(`[SIMPLE-SCENARIO] Call 2 → Returning 200 with RETRYABLE_FAILURE`);
    console.log(`[SIMPLE-SCENARIO] 🔍 CHECK: attemptCount should be 1, got: ${retryInfo?.attempt || 'N/A'}`);
    res.status(200).json({
      responses: [
        { id: "item1", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" },
        { id: "item2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" }
      ]
    });
  } else if (count === 3) {
    // Third call: 200 with SUCCESS
    console.log(`[SIMPLE-SCENARIO] Call 3 → Returning 200 with SUCCESS`);
    console.log(`[SIMPLE-SCENARIO] 🔍 CHECK: attemptCount should be 2, got: ${retryInfo?.attempt || 'N/A'}`);
    res.status(200).json({
      responses: [
        { id: "item1", responseStatus: "ResponseStatus_SUCCESS" },
        { id: "item2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  } else {
    // Shouldn't reach here
    console.log(`[SIMPLE-SCENARIO] Call ${count} → Returning SUCCESS (unexpected)`);
    res.status(200).json({
      responses: [
        { id: "item1", responseStatus: "ResponseStatus_SUCCESS" },
        { id: "item2", responseStatus: "ResponseStatus_SUCCESS" }
      ]
    });
  }
});

// Reset only the simple-scenario endpoint counter
app.post('/api/reset-simple-scenario', (req, res) => {
  console.log('[RESET] Resetting simple-scenario counter only');
  delete requestCounts['simple-scenario'];
  res.json({ message: 'Simple scenario counter reset' });
});

// Reset only the counter-behavior-test endpoint counter
app.post('/api/reset-counter-behavior', (req, res) => {
  console.log('[RESET] Resetting counter-behavior-test counter only');
  delete requestCounts['counter-behavior-test'];
  res.json({ message: 'Counter behavior test counter reset' });
});

app.post('/api/:status', ({ params, body, headers }, res) => {
  const status = +params.status;
  const payload = { body, header: headers['x-retry-context'] };
  console.log(`/api/${status} => ${JSON.stringify(payload)}`);
  res.status(status).send(`Status: ${status}`);
});

app.listen(port, () => {
  console.log(`listening at http://localhost:${port}`);
});
