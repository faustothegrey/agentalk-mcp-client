/**
 * Structured JSON response schema for LLM agent responses.
 *
 * Instead of relying on free-text [CALL:] markers or ACCEPT/REFUSE prefixes,
 * LLMs are instructed to wrap every response in a typed JSON envelope:
 *
 *   { "message_type": "<type>", "message_payload": { ... } }
 *
 * This module provides:
 * - Type definitions for each message type
 * - A parser that extracts the JSON envelope from raw LLM output
 * - A retry prompt builder for when parsing fails
 * - The system-prompt instructions that describe the contract to the LLM
 */
export const STRUCTURED_MESSAGE_TYPES = [
    'opinion',
    'agreement_proposal',
    'agreement_acceptance',
    'submit_plan',
    'fact_collection_end',
    'work_accept',
    'work_refuse',
    'healthcheck_ack',
];
function isValidMessageType(value) {
    return typeof value === 'string' && STRUCTURED_MESSAGE_TYPES.includes(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validatePayload(messageType, payload) {
    if (!isRecord(payload)) {
        return false;
    }
    switch (messageType) {
        case 'opinion':
            return (typeof payload.text === 'string' &&
                payload.text.length > 0 &&
                payload.proposal === null &&
                Array.isArray(payload.expected_response_types) &&
                payload.expected_response_types.every(isValidMessageType));
        case 'agreement_proposal':
        case 'agreement_acceptance':
            return (typeof payload.text === 'string' &&
                typeof payload.proposal === 'string' &&
                payload.proposal.length > 0 &&
                Array.isArray(payload.expected_response_types) &&
                payload.expected_response_types.every(isValidMessageType));
        case 'healthcheck_ack':
            return typeof payload.text === 'string' && payload.text.length > 0;
        case 'submit_plan':
            return (typeof payload.plan === 'string' &&
                payload.plan.length > 0 &&
                typeof payload.text === 'string' &&
                typeof payload.proposal === 'string' &&
                payload.proposal.length > 0);
        case 'fact_collection_end':
            return typeof payload.summary === 'string' && payload.summary.length > 0;
        case 'work_accept':
            return typeof payload.text === 'string';
        case 'work_refuse':
            return typeof payload.reason === 'string' && payload.reason.length > 0;
        default:
            return false;
    }
}
/**
 * Attempts to extract a JSON object from raw text, handling common LLM quirks:
 * - Bare JSON object
 * - JSON wrapped in markdown code fences (```json ... ``` or ``` ... ```)
 * - Leading/trailing prose around the JSON block
 */
function extractJsonFromText(rawText) {
    const trimmed = rawText.trim();
    // Try direct parse first
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // continue to heuristics
    }
    // Try extracting from markdown code fences
    const codeFenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeFenceMatch?.[1]) {
        try {
            return JSON.parse(codeFenceMatch[1].trim());
        }
        catch {
            // continue
        }
    }
    // Try finding a JSON object in the text (first { to last })
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
            return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        }
        catch {
            // give up
        }
    }
    return null;
}
/**
 * Parses a structured response from raw LLM output text.
 * Returns null if the text cannot be parsed into a valid structured response.
 */
export function parseStructuredResponse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
        return null;
    }
    const parsed = extractJsonFromText(rawText);
    if (!isRecord(parsed)) {
        return null;
    }
    if (!isValidMessageType(parsed.message_type)) {
        return null;
    }
    if (!validatePayload(parsed.message_type, parsed.message_payload)) {
        return null;
    }
    return {
        message_type: parsed.message_type,
        message_payload: parsed.message_payload,
    };
}
/**
 * Builds a correction prompt to send back to the LLM when parsing fails.
 */
export function buildRetryPrompt(rawText) {
    return [
        'Your previous response could not be parsed as a valid structured JSON message.',
        'You MUST respond with a JSON object in this exact format:',
        '',
        '```json',
        '{',
        '  "message_type": "<type>",',
        '  "message_payload": { ... }',
        '}',
        '```',
        '',
        'Valid message_type values: opinion, agreement_proposal, agreement_acceptance, submit_plan, fact_collection_end, work_accept, work_refuse, healthcheck_ack.',
        '',
        '- For "opinion": message_payload must have { "text": "...", "proposal": null, "expected_response_types": ["..."] }',
        '- For "agreement_proposal" and "agreement_acceptance": message_payload must have { "text": "...", "proposal": "...", "expected_response_types": ["..."] }',
        '- For "healthcheck_ack": message_payload must have { "text": "..." }',
        '- For "submit_plan": message_payload must have { "plan": "...", "text": "...", "proposal": "..." }',
        '- For "fact_collection_end": message_payload must have { "summary": "..." }',
        '- For "work_accept": message_payload must have { "text": "..." }',
        '- For "work_refuse": message_payload must have { "reason": "..." }',
        '',
        'Respond ONLY with the JSON object. No other text before or after it.',
        '',
        'Your previous response was:',
        rawText.slice(0, 500),
        '',
        'Please resubmit your intended response as valid JSON.',
    ].join('\n');
}
/**
 * System prompt fragment that instructs the LLM about the structured response contract.
 * Append this to any prompt where you expect a structured response.
 */
export const STRUCTURED_RESPONSE_INSTRUCTIONS = [
    '',
    '## Response format',
    '',
    'You MUST respond with a single JSON object. No prose before or after it.',
    'The JSON object must have exactly two fields:',
    '',
    '```json',
    '{',
    '  "message_type": "<type>",',
    '  "message_payload": { ... }',
    '}',
    '```',
    '',
    'Available message types:',
    '',
    '- **"opinion"** — a normal conversational reply.',
    '  Payload: `{ "text": "...", "proposal": null, "expected_response_types": ["opinion", "agreement_proposal"] }`',
    '',
    '- **"agreement_proposal"** — propose a concrete direction to be endorsed.',
    '  Payload: `{ "text": "...", "proposal": "...", "expected_response_types": ["agreement_acceptance", "opinion"] }`',
    '  Rules: only use after substantive discussion, not on your first reply. Do not repeat if already proposed.',
    '',
    '- **"agreement_acceptance"** — confirm that you agree with a peer\'s agreement proposal.',
    '  Payload: `{ "text": "...", "proposal": "...", "expected_response_types": ["submit_plan"] }`',
    '  Rules: only use after the system tells you a peer proposed agreement. If you disagree, use "opinion" instead.',
    '- **"submit_plan"** — submit the final implementation plan after agreement is reached.',
    '  Payload: `{ "plan": "the complete implementation plan", "text": "...", "proposal": "..." }`',
    '  Rules: only use after both agreement_proposal and agreement_acceptance have occurred. The plan must be concrete and implementation-ready.',
    '',
    '- **"fact_collection_end"** — mark your fact-collection phase as complete.',
    '  Payload: `{ "summary": "brief summary of findings" }`',
    '',
    'Critical rules:',
    '- Every response must be exactly one JSON object with message_type and message_payload.',
    '- For planning types, always include both "text" and "proposal" fields in message_payload.',
    '- For "opinion", set "proposal" to null.',
    '- For "agreement_proposal", "agreement_acceptance", and "submit_plan", "proposal" must repeat the exact proposal text being endorsed/submitted.',
    '- You MUST include "expected_response_types" (an array of strings) in the payload for opinion, agreement_proposal, and agreement_acceptance.',
    '- Standard protocol flow: opinion -> agreement_proposal -> agreement_acceptance -> submit_plan.',
    '- Each step represents an advancement in the planning process.',
    '- If you send a message type that is a regression (e.g., sending "opinion" when "submit_plan" is expected), the orchestrator will ask you to confirm. If you confirm the regression, the planning session will be terminated.',
    '- If your peer sends an unexpected response type, call them out in an "opinion" message and ask to return to the correct phase.',
].join('\n');
/**
 * System prompt fragment for worker agents describing accept/refuse message types.
 */
export const WORKER_RESPONSE_INSTRUCTIONS = [
    '',
    '## Response format',
    '',
    'You MUST respond with a single JSON object. No prose before or after it.',
    'The JSON object must have exactly two fields:',
    '',
    '```json',
    '{',
    '  "message_type": "<type>",',
    '  "message_payload": { ... }',
    '}',
    '```',
    '',
    'Available message types:',
    '',
    '- **"work_accept"** — you accept the plan and will execute it.',
    '  Payload: `{ "text": "your work output / execution result" }`',
    '',
    '- **"work_refuse"** — you refuse the plan because it is not feasible.',
    '  Payload: `{ "reason": "why you cannot execute the plan" }`',
    '',
    'Respond with exactly one JSON object. No other text.',
].join('\n');
/**
 * System prompt fragment for healthcheck responses.
 */
export const HEALTHCHECK_RESPONSE_INSTRUCTIONS = [
    '',
    '## Response format',
    '',
    'You MUST respond with a single JSON object:',
    '',
    '```json',
    '{',
    '  "message_type": "healthcheck_ack",',
    '  "message_payload": { "text": "your greeting here" }',
    '}',
    '```',
].join('\n');
//# sourceMappingURL=response-schema.js.map