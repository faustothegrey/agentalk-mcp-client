export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        "patterns": ["*@agenttalk/runtime-core*", "*agentalk-mcp-orchestrator*"]
      }]
    }
  }
];
