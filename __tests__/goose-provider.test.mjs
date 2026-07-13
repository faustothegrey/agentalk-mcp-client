import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_PROVIDERS,
  resolveProvider,
  getProviderCommand,
  extractTokenDetails,
} from '../lib/provider-runtime.mjs';
import { resolveExecutionMode } from '../lib/executor-runtime.mjs';

// A faithful sample of `goose run --output-format json` stdout: an ASCII banner precedes the JSON.
const GOOSE_STDOUT = `
    __( O)>  ● new session · openrouter openai/gpt-4o-mini
   \\____)    20260713_3 · /tmp/x
     L L     goose is ready
{
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "hi" }] },
    { "role": "assistant", "content": [{ "type": "text", "text": "PONG" }] }
  ],
  "metadata": { "total_tokens": 3217, "input_tokens": 3214, "output_tokens": 3, "status": "completed" }
}
`;

describe('goose provider wiring', () => {
  it('is a supported provider', () => {
    expect(SUPPORTED_PROVIDERS.has('goose')).toBe(true);
    expect(resolveProvider('goose')).toBe('goose');
  });

  it('resolves to the one-shot executor path (never persistent)', () => {
    expect(resolveExecutionMode('auto', 'goose')).toBe('one_shot');
    expect(resolveExecutionMode('persistent', 'goose')).toBe('one_shot');
  });

  it('builds a headless OpenRouter command with the prompt as -t arg', () => {
    const { command, args, stdin } = getProviderCommand('goose', 'openai/gpt-4o-mini', 'DO THING');
    expect(command).toBe('goose');
    expect(stdin).toBeNull();
    expect(args).toEqual(
      expect.arrayContaining([
        'run', '--no-session', '--output-format', 'json',
        '--provider', 'openrouter', '--model', 'openai/gpt-4o-mini', '-t', 'DO THING',
      ]),
    );
    // prompt is passed as an argument, not stdin
    expect(args[args.indexOf('-t') + 1]).toBe('DO THING');
  });

  it('defaults the model to openai/gpt-4o-mini when none is given', () => {
    const { args } = getProviderCommand('goose', null, 'x');
    expect(args[args.indexOf('--model') + 1]).toBe('openai/gpt-4o-mini');
  });

  it('parses token usage from stdout despite the leading banner', () => {
    expect(extractTokenDetails('goose', GOOSE_STDOUT)).toEqual({ input: 3214, output: 3 });
  });

  it('returns zeroed usage on unparseable output', () => {
    expect(extractTokenDetails('goose', 'no json here')).toEqual({ input: 0, output: 0 });
  });
});
