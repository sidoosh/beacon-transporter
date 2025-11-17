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

app.post('/api/exhaust-retry', ({ body }, res) => {
  const key = 'exhaust-retry';
  requestCounts[key] = (requestCounts[key] || 0) + 1;
  const count = requestCounts[key];

  console.log(`/api/exhaust-retry [${count}] => { body: ${body} }`);

  if (count <= 10) {
    // First 10 requests - always return retryable failure with 200 status
    res.status(200).json({
      responses: [
        { id: "item1", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" },
        { id: "item2", responseStatus: "ResponseStatus_RETRYABLE_FAILURE" }
      ]
    });
  } else {
    // After persistence retry - success
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

app.post('/api/:status', ({ params, body, headers }, res) => {
  const status = +params.status;
  const payload = { body, header: headers['x-retry-context'] };
  console.log(`/api/${status} => ${JSON.stringify(payload)}`);
  res.status(status).send(`Status: ${status}`);
});

app.listen(port, () => {
  console.log(`listening at http://localhost:${port}`);
});
