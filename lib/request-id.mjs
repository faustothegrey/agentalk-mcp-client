/**
 * Creates a unique request ID generator for AgentTalk protocol communications.
 * Generates IDs in the format: req-<timestamp>-<sequence>
 */
export function createRequestIdGenerator(options = {}) {
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    let sequence = 0;
    return function nextRequestId() {
        sequence += 1;
        if (sequence > 999_999) {
            sequence = 1;
        }
        return `req-${now()}-${sequence}`;
    };
}
//# sourceMappingURL=request-id.js.map