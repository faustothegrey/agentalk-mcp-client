#!/usr/bin/env node
import process from 'node:process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node-pty';
import stripAnsi from 'strip-ansi';

const shell = process.env.SHELL || '/bin/zsh';
const geminiCmd = process.env.GEMINI_CMD || 'gemini';

const wrapperConfig = {
  statsOut: null,
  statsWaitMs: 2000,
  statsCaptureMs: 5000,
  statsExit: true
};

const rawArgs = process.argv.slice(2);
const geminiArgs = [];

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--stats-out') {
    const value = rawArgs[i + 1];
    if (!value || value.startsWith('--')) {
      console.error('[gemini-pty] --stats-out requires a file path.');
      process.exit(1);
    }
    wrapperConfig.statsOut = value;
    i += 1;
    continue;
  }
  if (arg === '--stats-wait-ms') {
    const value = Number(rawArgs[i + 1]);
    if (!Number.isFinite(value) || value < 0) {
      console.error('[gemini-pty] --stats-wait-ms must be a non-negative number.');
      process.exit(1);
    }
    wrapperConfig.statsWaitMs = value;
    i += 1;
    continue;
  }
  if (arg === '--stats-capture-ms') {
    const value = Number(rawArgs[i + 1]);
    if (!Number.isFinite(value) || value < 1) {
      console.error('[gemini-pty] --stats-capture-ms must be a positive number.');
      process.exit(1);
    }
    wrapperConfig.statsCaptureMs = value;
    i += 1;
    continue;
  }
  if (arg === '--no-stats-exit') {
    wrapperConfig.statsExit = false;
    continue;
  }
  geminiArgs.push(arg);
}

const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const captureMode = Boolean(wrapperConfig.statsOut);

if (!isTTY && !captureMode) {
  console.error('[gemini-pty] This launcher requires an interactive TTY unless --stats-out is provided.');
  process.exit(1);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function typeCommand(ptyProcess, text, { submit = true, charDelayMs = 25, submitDelayMs = 80 } = {}) {
  let index = 0;
  const step = () => {
    if (index < text.length) {
      ptyProcess.write(text[index]);
      index += 1;
      setTimeout(step, charDelayMs);
      return;
    }
    if (submit) {
      setTimeout(() => {
        ptyProcess.write('\r');
      }, submitDelayMs);
    }
  };
  step();
}

const commandLine = [geminiCmd, ...geminiArgs].map(shellEscape).join(' ');

let pty;
try {
  pty = spawn(shell, ['-lc', commandLine], {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd: process.cwd(),
    env: process.env
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[gemini-pty] Failed to create PTY: ${message}`);
  console.error('[gemini-pty] If you are on Node 21+, try running this with Node 20 LTS.');
  process.exit(1);
}

let cleaned = false;
let captureStatsActive = false;
let statsCommandSent = false;
let statsCaptureFinished = false;
let statsSendTimer = null;
let statsCaptureTimer = null;
let readinessWindow = '';
const capturedStatsRaw = [];
let sendStatsCommand = null;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

if (isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    pty.write(chunk);
  });

  process.stdout.on('resize', () => {
    pty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });
}

pty.onData((data) => {
  if (isTTY) {
    process.stdout.write(data);
  }
  if (captureStatsActive) {
    capturedStatsRaw.push(data);
  }
  if (wrapperConfig.statsOut && !statsCommandSent) {
    readinessWindow = `${readinessWindow}${stripAnsi(data)}`.slice(-3000);
    if (
      readinessWindow.includes('Type your message') ||
      readinessWindow.includes('? for shortcuts')
    ) {
      if (sendStatsCommand) {
        sendStatsCommand();
      }
    }
  }
});

pty.onExit(({ exitCode }) => {
  cleanup();
  process.exit(exitCode);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      pty.kill();
    } finally {
      cleanup();
      process.exit(0);
    }
  });
}

if (wrapperConfig.statsOut) {
  const statsPath = resolve(wrapperConfig.statsOut);

  const finishStatsCapture = () => {
    if (statsCaptureFinished) return;
    statsCaptureFinished = true;
    captureStatsActive = false;
    const content = stripAnsi(capturedStatsRaw.join(''));
    void writeFile(statsPath, content, 'utf8')
      .then(() => {
        console.error(`[gemini-pty] Wrote /stats output to ${statsPath}`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[gemini-pty] Failed to write stats file: ${message}`);
      })
      .finally(() => {
        if (wrapperConfig.statsExit) {
          typeCommand(pty, '/quit');
          setTimeout(() => {
            pty.kill();
          }, 1000);
        }
      });
  };

  sendStatsCommand = () => {
    if (statsCommandSent) return;
    statsCommandSent = true;
    if (statsSendTimer) {
      clearTimeout(statsSendTimer);
    }
    captureStatsActive = true;
    typeCommand(pty, '/stats');
    statsCaptureTimer = setTimeout(() => {
      finishStatsCapture();
    }, wrapperConfig.statsCaptureMs);
  };

  statsSendTimer = setTimeout(() => {
    sendStatsCommand();
  }, wrapperConfig.statsWaitMs);
}
