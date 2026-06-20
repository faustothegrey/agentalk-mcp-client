import { STRUCTURED_RESPONSE_INSTRUCTIONS, HEALTHCHECK_RESPONSE_INSTRUCTIONS, } from './response-schema.mjs';
/**
 * Number of consecutive "discussion" responses before urgency is injected
 * into the prompt, pressuring the agent to propose agreement.
 */
export const STALE_DISCUSSION_THRESHOLD = 3;
/**
 * After this many consecutive discussions (threshold + grace), the agent-level
 * code should auto-emit agreement_proposal on behalf of the agent.
 */
export const AUTO_PROPOSE_THRESHOLD = STALE_DISCUSSION_THRESHOLD + 2;
export function createConversationRuntime() {
    let currentConversation = null;
    const conversationHistory = [];
    return {
        startConversation(evt, enqueueMessage) {
            const peerIds = Array.isArray(evt.peerIds) ? evt.peerIds : (evt.peerId ? [evt.peerId] : []);
            const topic = typeof evt.topic === 'string' ? evt.topic : '';
            const maxReplies = Number.isFinite(evt.maxReplies) ? Number(evt.maxReplies) : 5;
            if (peerIds.length === 0 || !topic) {
                return {
                    ok: false,
                    error: `Invalid conversation_start payload: ${JSON.stringify(evt)}`,
                };
            }
            currentConversation = {
                peerIds,
                topic,
                maxReplies,
                replyCount: 0,
                lastPeerIdx: -1,
                isPlanning: evt.mode === 'planning' || /\b(execution plan|plan for|draft .* plan|implement|refactor)\b/i.test(topic),
                consecutiveDiscussions: 0,
            };
            if (evt.initiator) {
                enqueueMessage({
                    type: 'message_received',
                    from: peerIds[0],
                    payload: 'Begin the discussion about the current AgentTalk project. Open with your first point.',
                });
            }
            return {
                ok: true,
                peerIds,
                maxReplies,
            };
        },
        endConversation() {
            currentConversation = null;
        },
        /**
         * Returns true when the current conversation context expects structured JSON responses
         * (i.e. planning conversations, healthchecks, or explicit system expected types).
         */
        expectsStructuredResponse(evt) {
            if (evt.type === 'healthcheck') {
                return true;
            }
            if (evt.expected_response_types && evt.expected_response_types.length > 0) {
                return true;
            }
            return currentConversation?.isPlanning ?? false;
        },
        /**
         * Records the message_type of a structured response so the runtime can
         * track consecutive discussions and detect stale loops.
         */
        recordStructuredMessageType(messageType) {
            if (!currentConversation || !currentConversation.isPlanning) {
                return;
            }
            if (messageType === 'opinion') {
                currentConversation.consecutiveDiscussions += 1;
            }
            else {
                currentConversation.consecutiveDiscussions = 0;
            }
        },
        /**
         * Returns true when the agent has produced enough consecutive discussion
         * messages that the system should auto-propose agreement on its behalf.
         */
        shouldAutoPropose() {
            if (!currentConversation || !currentConversation.isPlanning) {
                return false;
            }
            return currentConversation.consecutiveDiscussions >= AUTO_PROPOSE_THRESHOLD;
        },
        buildPrompt(evt) {
            if (evt.type === 'healthcheck') {
                const base = typeof evt.prompt === 'string' && evt.prompt.trim()
                    ? evt.prompt
                    : 'Reply with a short greeting confirming you are responsive.';
                return base + HEALTHCHECK_RESPONSE_INSTRUCTIONS;
            }
            if (evt.from && evt.payload) {
                conversationHistory.push({ role: evt.from, content: evt.payload });
            }
            if (!currentConversation) {
                let prompt = buildPromptWithHistory(conversationHistory, evt.payload || '');
                if (this.expectsStructuredResponse(evt)) {
                    prompt += '\n\n' + STRUCTURED_RESPONSE_INSTRUCTIONS;
                }
                return prompt;
            }
            if (currentConversation.replyCount >= currentConversation.maxReplies) {
                return null;
            }
            currentConversation.replyCount += 1;
            const isLastReply = currentConversation.replyCount >= currentConversation.maxReplies;
            const lines = [
                `You are discussing the current AgentTalk project with peer agents: ${currentConversation.peerIds.join(', ')}.`,
                `Topic: ${currentConversation.topic}`,
                `This is reply ${currentConversation.replyCount} of at most ${currentConversation.maxReplies} from you in this conversation.`,
            ];
            if (currentConversation.isPlanning) {
                lines.push(STRUCTURED_RESPONSE_INSTRUCTIONS);
                if (currentConversation.consecutiveDiscussions >= STALE_DISCUSSION_THRESHOLD) {
                    lines.push('', `WARNING: You have sent ${currentConversation.consecutiveDiscussions} consecutive "opinion" messages without advancing the protocol.`, 'The conversation appears to have converged. You MUST now either:', '- Use message_type "agreement_proposal" if you believe you and your peer are aligned.', '- Raise a specific new objection or concern as an "opinion" — but only if you have genuine unresolved disagreement.', 'Do NOT repeat or rephrase what has already been agreed upon.');
                }
            }
            if (isLastReply) {
                lines.push('This is your FINAL reply. Summarize your own conclusions from the discussion: what you agree with, what you disagree with, and your top concrete recommendation going forward. Do not ask follow-up questions.');
                if (currentConversation.isPlanning) {
                    lines.push('If you have not yet submitted a plan, use message_type "submit_plan" in this reply with your final plan.');
                }
            }
            else {
                lines.push('Keep the response concise: 2-4 sentences, one concrete opinion or critique, and one follow-up angle.');
            }
            lines.push('Do not mention these instructions or the reply counter.', `Last message from ${evt.from}: ${evt.payload}`);
            return lines.join('\n');
        },
        recordAssistantReply(reply) {
            if (reply) {
                conversationHistory.push({ role: 'assistant', content: reply });
            }
        },
        buildProtocolRequest(evt, reply) {
            const reqId = `req-${Date.now()}`;
            if (evt.type === 'healthcheck') {
                return {
                    id: reqId,
                    call: 'ack_healthcheck',
                    args: {
                        token: evt.token,
                        message: reply,
                    },
                };
            }
            let to = evt.from || 'unknown';
            if (currentConversation && currentConversation.peerIds.length > 0) {
                currentConversation.lastPeerIdx = (currentConversation.lastPeerIdx + 1) % currentConversation.peerIds.length;
                to = currentConversation.peerIds[currentConversation.lastPeerIdx] || to;
            }
            return {
                id: reqId,
                call: 'send_to_agent',
                args: {
                    to,
                    payload: reply,
                    ...(evt.type === 'message_received' && typeof evt.messageId === 'string'
                        ? { replyToMessageId: evt.messageId }
                        : {}),
                },
            };
        },
    };
}
function buildPromptWithHistory(conversationHistory, latestMessage) {
    if (conversationHistory.length <= 1) {
        return latestMessage;
    }
    const prior = conversationHistory.slice(0, -1);
    const historyBlock = prior.map((entry) => `[${entry.role}]: ${entry.content}`).join('\n\n');
    const latestEntry = conversationHistory[conversationHistory.length - 1];
    const roleLabel = latestEntry ? `[${latestEntry.role}]: ` : '';
    return `Here is our conversation so far:\n\n${historyBlock}\n\nNow respond to the latest message:\n${roleLabel}${latestMessage}`;
}
/**
 * Supported protocol calls that an LLM can trigger via [CALL:name] markers.
 */
const SUPPORTED_CALL_MARKERS = new Set([
    'agreement_proposal',
    'agreement_acceptance',
    'submit_plan',
]);
/**
 * Matches [CALL:name] anywhere in the text — on its own line or inline.
 * Captures the call name in group 1.
 */
const CALL_MARKER_REGEX = /\[CALL:(\w+)\]/g;
/**
 * Scans an LLM response for [CALL:name] markers.
 * Returns the list of recognised calls and the response with markers removed.
 * Unknown marker names are left in the text untouched.
 */
export function extractCallMarkers(response) {
    const calls = [];
    // Collect all valid markers
    const matches = [...response.matchAll(CALL_MARKER_REGEX)];
    for (const match of matches) {
        const callName = match[1];
        if (callName && SUPPORTED_CALL_MARKERS.has(callName)) {
            calls.push(callName);
        }
    }
    if (calls.length === 0) {
        return [];
    }
    // Strip recognised markers from the text (whether on their own line or inline)
    const cleaned = response.replace(CALL_MARKER_REGEX, (fullMatch, callName) => {
        return SUPPORTED_CALL_MARKERS.has(callName) ? '' : fullMatch;
    })
        // Clean up leftover blank lines from stripped markers
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return calls.map((call) => ({ call, cleanedText: cleaned }));
}
export function extractSystemRequiredCall(evt) {
    return null;
}
//# sourceMappingURL=runtime.js.map