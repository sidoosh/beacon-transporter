/**
 * Example implementation of parseResponseForRetry function
 * 
 * This demonstrates how to handle partial failures in responses with 200 status
 * where the server returns success but indicates some items need retry.
 */

// REUSABLE FACTORY FUNCTION - Use this in your code!
function createParseResponseForRetry(retryableStatuses = ['ResponseStatus_RETRYABLE_FAILURE']) {
    return function parseResponseForRetry(responseBody, originalPayload) {
        try {
            const response = JSON.parse(responseBody);
            const originalData = JSON.parse(originalPayload);

            // Find item IDs that need retry based on response status
            const retryableItemIds = response.responses
                ?.filter(item => retryableStatuses.includes(item.responseStatus))
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
    };
}

// Example 1: Simple retry on RETRYABLE_FAILURE status only
function parseResponseForRetrySimple(responseBody, originalPayload) {
    try {
        const response = JSON.parse(responseBody);

        // Only retry items with RETRYABLE_FAILURE status
        // NON_RETRYABLE_FAILURE and SUCCESS should NOT be retried
        const hasRetryableFailure = response.responses?.some(item =>
            item.responseStatus === "ResponseStatus_RETRYABLE_FAILURE"
        );

        if (hasRetryableFailure) {
            // Return the original payload to retry the entire request
            return originalPayload;
        }

        return null; // No retry needed
    } catch (error) {
        console.error('parseResponseForRetry error:', error);
        return null;
    }
}

// Example 2: Advanced partial retry - only retry failed items using originalData
function parseResponseForRetryAdvanced(responseBody, originalPayload) {
    try {
        const response = JSON.parse(responseBody);
        const originalData = JSON.parse(originalPayload);

        // Find item IDs that need retry (only RETRYABLE_FAILURE)
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

// Example 3: Conditional retry based on error codes
function parseResponseForRetryWithErrorCodes(responseBody, originalPayload) {
    try {
        const response = JSON.parse(responseBody);

        // Define which statuses should trigger retry
        const retryableStatuses = [
            "ResponseStatus_RETRYABLE_FAILURE",
            "ResponseStatus_TIMEOUT",
            "ResponseStatus_RATE_LIMITED"
        ];

        // Check if any items have retryable status
        const itemsToRetry = response.responses?.filter(item =>
            retryableStatuses.includes(item.responseStatus)
        ) || [];

        if (itemsToRetry.length > 0) {
            // You can either retry all items or just the failed ones
            const originalData = JSON.parse(originalPayload);

            // Option A: Retry only failed items
            return JSON.stringify({
                items: itemsToRetry.map(item => ({ id: item.id }))
            });

            // Option B: Retry entire payload (uncomment to use)
            // return originalPayload;
        }

        return null;
    } catch (error) {
        return null;
    }
}

// Usage example with createBeacon
const beaconConfig = {
    inMemoryRetry: {
        attemptLimit: 3,
        statusCodes: [500, 502, 503], // Note: 200 not included, parseResponseForRetry handles it
        calculateRetryDelay: (attemptCount) => Math.min(1000 * Math.pow(2, attemptCount - 1), 30000)
    },
    parseResponseForRetry: parseResponseForRetrySimple, // Use any of the examples above
};

// Example server response that would trigger retry:
const exampleResponse = {
    responses: [
        {
            id: "367",
            responseStatus: "ResponseStatus_NON_RETRYABLE_FAILURE"
        },
        {
            id: "368",
            responseStatus: "ResponseStatus_SUCCESS"
        }
    ]
};

// Example original payload:
const examplePayload = {
    items: [
        { id: "367" },
        { id: "368" }
    ]
};

console.log('Example usage:');
console.log('Original payload:', JSON.stringify(examplePayload));
console.log('Server response:', JSON.stringify(exampleResponse));
console.log('Retry payload:', parseResponseForRetryAdvanced(
    JSON.stringify(exampleResponse),
    JSON.stringify(examplePayload)
));
