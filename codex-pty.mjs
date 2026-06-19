#!/usr/bin/env node
import process from 'node:process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node-pty';
import stripAnsi from 'strip-ansi';

const shell = process.env.SHELL || '/bin/zsh';
const codexCmd = process.env.CODEX_CMD || 'codex';

const wrapperConfig = {
  statusOut: null,
  statusWaitMs: 7000,
  statusCaptureMs: 7000,
  statusExit: true
};

const rawArgs = process.argv.slice(2);
const codexArgs = [];

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--status-out') {
    const value = rawArgs[i + 1];
    if (!value || value.startsWith('--')) {
      console.error('[codex-pty] --status-out requires a file path.');
      process.exit(1);
    }
    wrapperConfig.statusOut = value;
    i += 1;
    continue;
  }
  if (arg === '--status-wait-ms') {
    const value = Number(rawArgs[i + 1]);
    if (!Number.isFinite(value) || value < 0) {
      console.error('[codex-pty] --status-wait-ms must be a non-negative number.');
      process.exit(1);
    }
    wrapperConfig.statusWaitMs = value;
    i += 1;
    continue;
  }
  if (arg === '--status-capture-ms') {
    const value = Number(rawArgs[i + 1]);
    if (!Number.isFinite(value) || value < 1) {
      console.error('[codex-pty] --status-capture-ms must be a positive number.');
      process.exit(1);
    }
    wrapperConfig.statusCaptureMs = value;
    i += 1;
    continue;
  }
  if (arg === '--no-status-exit') {
    wrapperConfig.statusExit = false;
    continue;
  }
  codexArgs.push(arg);
}

if (!codexArgs.includes('--no-alt-screen')) {
  codexArgs.push('--no-alt-screen');
}

const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const captureMode = Boolean(wrapperConfig.statusOut);

if (!isTTY && !captureMode) {
  console.error('[codex-pty] This launcher requires an interactive TTY unless --status-out is provided.');
  process.exit(1);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
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

const commandLine = [codexCmd, ...codexArgs].map(shellEscape).join(' ');

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
  console.error(`[codex-pty] Failed to create PTY: ${message}`);
  process.exit(1);
}

let cleaned = false;
let captureStatusActive = false;
let statusCommandSent = false;
let statusCaptureFinished = false;
let statusSendTimer = null;
let statusExitFallbackTimer = null;
let readinessWindow = '';
const capturedStatusRaw = [];
let sendStatusCommand = null;

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
  if (captureStatusActive) {
    capturedStatusRaw.push(data);
  }
  if (wrapperConfig.statusOut && !statusCommandSent) {
    readinessWindow = `${readinessWindow}${stripAnsi(data)}`.slice(-5000);
    if (
      readinessWindow.includes('Type your message') ||
      readinessWindow.includes('? for shortcuts') ||
      readinessWindow.includes('ctrl+g to edit')
    ) {
      if (sendStatusCommand) {
        sendStatusCommand();
      }
    }
  }
});

pty.onExit(({ exitCode }) => {
  if (statusExitFallbackTimer) {
    clearTimeout(statusExitFallbackTimer);
  }
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

if (wrapperConfig.statusOut) {
  const statusPath = resolve(wrapperConfig.statusOut);

  const finishStatusCapture = () => {
    if (statusCaptureFinished) return;
    statusCaptureFinished = true;
    captureStatusActive = false;
    const content = stripAnsi(capturedStatusRaw.join(''));
    void writeFile(statusPath, content, 'utf8')
      .then(() => {
        console.error(`[codex-pty] Wrote /status output to ${statusPath}`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[codex-pty] Failed to write status file: ${message}`);
      })
      .finally(() => {
        if (wrapperConfig.statusExit) {
          typeCommand(pty, '/exit');
          statusExitFallbackTimer = setTimeout(() => {
            pty.kill();
          }, 4000);
        }
      });
  };

  sendStatusCommand = () => {
    if (statusCommandSent) return;
    statusCommandSent = true;
    if (statusSendTimer) {
      clearTimeout(statusSendTimer);
    }
    captureStatusActive = true;
    typeCommand(pty, '/status');
    setTimeout(() => {
      finishStatusCapture();
    }, wrapperConfig.statusCaptureMs);
  };

  statusSendTimer = setTimeout(() => {
    sendStatusCommand();
  }, wrapperConfig.statusWaitMs);
}
