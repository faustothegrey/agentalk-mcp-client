export const PROTOCOL_PREFIX = '[AgentTalk]:';
export const PROTOCOL_PACKET_TYPES = ['READY', 'REQ', 'RES', 'EVT'];
export function isProtocolLine(line) {
    return line.startsWith(PROTOCOL_PREFIX);
}
export function splitProtocolLine(line) {
    if (!isProtocolLine(line)) {
        return null;
    }
    const body = line.slice(PROTOCOL_PREFIX.length);
    const colonIdx = body.indexOf(':');
    if (colonIdx === -1) {
        return null;
    }
    const packetType = body.slice(0, colonIdx);
    if (!isProtocolPacketType(packetType)) {
        return null;
    }
    return {
        packetType,
        payloadJson: body.slice(colonIdx + 1),
    };
}
export function serializeProtocolLine(type, payload) {
    return `${PROTOCOL_PREFIX}${type}:${JSON.stringify(payload)}\n`;
}
function isProtocolPacketType(value) {
    return PROTOCOL_PACKET_TYPES.includes(value);
}
/**
 * Legacy support for scripts/lib/protocol.mjs helper functions
 */
export function emitReady(payload) {
    const normalizedPayload = typeof payload === 'string' ? { session: payload } : payload;
    process.stdout.write(serializeProtocolLine('READY', normalizedPayload));
}
export function emitEvent(payload) {
    process.stdout.write(serializeProtocolLine('EVT', payload));
}
export function emitRequest(payload) {
    process.stdout.write(serializeProtocolLine('REQ', payload));
}
/**
 * Parses a protocol line. Returns null if the line is not a valid AgentTalk protocol line.
 */
export function parseInboundProtocolLine(line) {
    const parsed = splitProtocolLine(line);
    if (!parsed) {
        return null;
    }
    return {
        type: parsed.packetType,
        json: parsed.payloadJson,
    };
}
//# sourceMappingURL=protocol.js.map