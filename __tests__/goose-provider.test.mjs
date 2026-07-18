import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('BL-024 T3b: requires an explicit model — no silent default (goose is a harness over a model)', () => {
    expect(() => getProviderCommand('goose', null, 'x')).toThrow(/goose requires an explicit --model/);
    expect(() => getProviderCommand('goose', '', 'x')).toThrow(/goose requires an explicit --model/);
    // an explicit model is honoured, verbatim
    const { args } = getProviderCommand('goose', 'anthropic/claude-3.5-sonnet', 'x');
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-3.5-sonnet');
  });

  it('parses token usage from stdout despite the leading banner', () => {
    expect(extractTokenDetails('goose', GOOSE_STDOUT)).toEqual({ input: 3214, output: 3 });
  });

  it('returns zeroed usage on unparseable output', () => {
    expect(extractTokenDetails('goose', 'no json here')).toEqual({ input: 0, output: 0 });
  });
});

describe('goose coordination profile (env-driven)', () => {
  const saved = {};
  const KEYS = ['AGENTTALK_GOOSE_MAX_TURNS', 'AGENTTALK_GOOSE_NO_PROFILE', 'AGENTTALK_GOOSE_SYSTEM'];
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('defaults to --max-turns 30, no --system, no --no-profile', () => {
    const { args } = getProviderCommand('goose', 'openai/gpt-4o', 'x');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('30');
    expect(args).not.toContain('--system');
    expect(args).not.toContain('--no-profile');
  });

  it('honors AGENTTALK_GOOSE_MAX_TURNS', () => {
    process.env.AGENTTALK_GOOSE_MAX_TURNS = '3';
    const { args } = getProviderCommand('goose', 'openai/gpt-4o', 'x');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('3');
  });

  it('adds --no-profile and --system when the coordination env is set', () => {
    process.env.AGENTTALK_GOOSE_NO_PROFILE = '1';
    process.env.AGENTTALK_GOOSE_SYSTEM = 'Emit exactly one protocol message.';
    const { args } = getProviderCommand('goose', 'openai/gpt-4o', 'x');
    expect(args).toContain('--no-profile');
    expect(args[args.indexOf('--system') + 1]).toBe('Emit exactly one protocol message.');
    // prompt still last
    expect(args[args.indexOf('-t') + 1]).toBe('x');
  });
});
