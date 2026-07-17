import { describe, expect, it, vi } from 'vitest';
import { createResponseRecorder } from '../lib/response-log.mjs';

// BL-064: the worker's report had no channel at all — it existed in llm-agent for one instant and
// crossed MCP unwritten. These bars are on the DECISION of where it goes, not on the ndjson writer
// underneath (that already had its own): pointing them at the writer would test a util that was
// never broken while the actual guarantee — the report gets filed — went unasserted.

describe('createResponseRecorder (BL-064)', () => {
  it('files the report at the path the launcher handed down', () => {
    const record = vi.fn();
    const createRecorder = vi.fn(() => record);

    const recordResponse = createResponseRecorder(
      { AGENTTALK_RESPONSE_LOG: '/runs/r.ndjson.responses.ndjson' },
      { createRecorder },
    );
    recordResponse({ event: 'agent-response', agentId: 'w1', text: 'my reasoning' });

    expect(createRecorder).toHaveBeenCalledWith('/runs/r.ndjson.responses.ndjson');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent-response', agentId: 'w1', text: 'my reasoning' }),
    );
  });

  it('is a no-op when no run recording is configured', () => {
    const createRecorder = vi.fn();

    // A manual launch: no launcher, no recording, no sink. It must not invent a file.
    const recordResponse = createResponseRecorder({}, { createRecorder });
    recordResponse({ event: 'agent-response', text: 'x' });

    expect(createRecorder).not.toHaveBeenCalled();
  });

  it('never lets a broken log fail the turn', () => {
    const logError = vi.fn();
    const boom = () => { throw new Error('disk full'); };

    const recordResponse = createResponseRecorder(
      { AGENTTALK_RESPONSE_LOG: '/runs/r.responses.ndjson' },
      { createRecorder: () => boom, logError },
    );

    // The whole point: observability cannot be allowed to kill a real run.
    expect(() => recordResponse({ event: 'agent-response', text: 'x' })).not.toThrow();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('survives a sink that cannot even be opened', () => {
    const logError = vi.fn();
    const createRecorder = () => { throw new Error('EACCES'); };

    const recordResponse = createResponseRecorder(
      { AGENTTALK_RESPONSE_LOG: '/nope/r.responses.ndjson' },
      { createRecorder, logError },
    );

    expect(() => recordResponse({ event: 'agent-response', text: 'x' })).not.toThrow();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});
