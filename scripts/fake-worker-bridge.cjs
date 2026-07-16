// Fake provider CLI for the BL-040 D1/D3 slice (NOT a real worker turn — that's the babysat D4).
// The executor sends each prompt on stdin; we answer every prompt with a valid healthcheck_ack so
// the worker passes the orchestrator's start-healthcheck and ATTACHES (D1). No goal is delivered in
// this slice, so after attach the worker parks on await_turn and the wall-clock cap terminates it (D3).
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', () => {
  const ack = JSON.stringify({ message_type: 'healthcheck_ack', message_payload: { text: 'ok' } });
  console.log(JSON.stringify({ type: 'result', result: ack, usage: { input_tokens: 0, output_tokens: 0 } }));
});
