import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (line) => {
  let content = "";
  let text = line;
  try {
    const parsed = JSON.parse(line);
    if (parsed.message && parsed.message.content) {
      text = parsed.message.content[0].text;
    }
  } catch (e) {}

  const recentText = text;
  process.stderr.write(`\n[stub-bridge] received full length: ${text.length}\n`);

  let branch = "none";
  if (recentText.includes('work_assign')) {
    branch = "work_accept";
    content = JSON.stringify({ 
      message_type: 'work_accept', 
      message_payload: { text: "OK" } 
    });
  } else if (recentText.includes('Work response submitted successfully') || recentText.includes('submit_work_result')) {
    branch = "submit_work_result";
    content = JSON.stringify({ 
      message_type: 'submit_work_result', 
      message_payload: { result: "Done working" } 
    });
  } else if (recentText.includes('Acknowledge planning protocol') || recentText.includes('ack_planning_protocol')) {
    branch = "ack_planning_protocol";
    content = JSON.stringify({ message_type: 'ack_planning_protocol', message_payload: {} });
  
  } else if (recentText.includes('agreement_acceptance') && (recentText.includes('Your peer has proposed agreement') || recentText.includes('I propose X'))) {
    branch = "agreement_acceptance";
    content = JSON.stringify({ 
      message_type: 'agreement_acceptance', 
      message_payload: { 
        text: "OK", 
        proposal: "I propose X", 
        expected_response_types: ["submit_plan"] 
      } 
    });
  } else if (recentText.includes('agreement_proposal') && (recentText.includes('You MUST now either') || recentText.includes('Please call agreement_proposal now') || recentText.includes('reply 3 of at most 10'))) {
    branch = "agreement_proposal";
    content = JSON.stringify({ 
      message_type: 'agreement_proposal', 
      message_payload: { 
        text: "I propose X", 
        proposal: "I propose X", 
        expected_response_types: ["agreement_acceptance", "opinion"] 
      } 
    });
  } else if (recentText.includes('use message_type "submit_plan" in this reply with your final plan') || recentText.includes('One planner must call submit_plan') || recentText.includes('expected_response_types":["submit_plan"]') || recentText.includes("expected_response_types: [ 'submit_plan' ]") || recentText.includes('Your submit_plan call was rejected')) {
    branch = "submit_plan";
    content = JSON.stringify({ 
      message_type: 'submit_plan', 
      message_payload: { 
        plan: "File: src/index.js\nChange: Update the function", 
        text: "Here is the plan", 
        proposal: "I propose X" 
      } 
    });
  } else if (recentText.includes('fact_collection_begin') || recentText.includes('collect facts')) {
    branch = "fact_collection_end";
    content = JSON.stringify({ 
      message_type: 'fact_collection_end', 
      message_payload: { summary: "Done" } 
    });
  } else if (recentText.includes('Last message from planner-b: I propose X') || recentText.includes('Last message from planner-a: I propose X')) {
    branch = "agreement_acceptance (fallback)";
    content = JSON.stringify({ 
      message_type: 'agreement_acceptance', 
      message_payload: { 
        text: "OK", 
        proposal: "I propose X", 
        expected_response_types: ["submit_plan"] 
      } 
    });
  } else {
    branch = "opinion";
    content = JSON.stringify({ 
      message_type: 'opinion', 
      message_payload: { 
        text: "mock opinion", 
        proposal: null, 
        expected_response_types: ["opinion", "agreement_proposal"] 
      } 
    });
  }

  process.stderr.write(`[stub-bridge] branch: ${branch}\n`);

  if (content) {
    console.log(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: content }] }
    }));
  }
  console.log(JSON.stringify({
    type: 'result',
    is_error: false,
    usage: { input_tokens: 0, output_tokens: 0 }
  }));
});
