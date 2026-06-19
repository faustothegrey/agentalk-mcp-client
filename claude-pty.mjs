#!/usr/bin/env node
import process from 'node:process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node-pty';
import stripAnsi from 'strip-ansi';

const shell = process.env.SHELL || '/bin/zsh';
const claudeCmd = process.env.CLAUDE_CMD || 'claude';

const wrapperConfig = {
  usageOut: null,
  usageWaitMs: 7000,
  usageCaptureMs: 6000,
  usageExit: true
};

const rawArgs = process.argv.slice(2);
const claudeArgs = [];

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--usage-out') {
    const value = rawArgs[i + 1];
    if (!value || value.startsWith('--')) {
      console.error('[claude-pty] --usage-out requires a file path.');
      process.exit(1);
    }
    wrapperConfig.usageOut = value;
    i += 1;
    continue;
  }
  if (arg === '--usage-wait-ms') {
    const value = Number(rawArgs[i + 1]);
    if (!Number.isFinite(value) || value < 0) {
      console.error('[claude-pty] --usage-wait-ms must be a non-negative number.');
      process.exit(1);
    }
    wrapperConfig.usageWaitMs = value;
    i += 1;
    continue;
  }
  if (arg === '--usage-capture-ms') {
    const value = Number(rawArgs[i + 1]);
    if (!Number.isFinite(value) || value < 1) {
      console.error('[claude-pty] --usage-capture-ms must be a positive number.');
      process.exit(1);
    }
    wrapperConfig.usageCaptureMs = value;
    i += 1;
    continue;
  }
  if (arg === '--no-usage-exit') {
    wrapperConfig.usageExit = false;
    continue;
  }
  claudeArgs.push(arg);
}

const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const captureMode = Boolean(wrapperConfig.usageOut);

if (!isTTY && !captureMode) {
  console.error('[claude-pty] This launcher requires an interactive TTY unless --usage-out is provided.');
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

const commandLine = [claudeCmd, ...claudeArgs].map(shellEscape).join(' ');

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
  console.error(`[claude-pty] Failed to create PTY: ${message}`);
  process.exit(1);
}

let cleaned = false;
let captureUsageActive = false;
let usageCommandSent = false;
let usageCaptureFinished = false;
let usageSendTimer = null;
let usageExitFallbackTimer = null;
let readinessWindow = '';
const capturedUsageRaw = [];
let sendUsageCommand = null;

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
  if (captureUsageActive) {
    capturedUsageRaw.push(data);
  }
  if (wrapperConfig.usageOut && !usageCommandSent) {
    readinessWindow = `${readinessWindow}${stripAnsi(data)}`.slice(-4000);
    if (
      readinessWindow.includes('? for shortcuts') ||
      readinessWindow.includes('ctrl+g to edit') ||
      readinessWindow.includes('❯')
    ) {
      if (sendUsageCommand) {
        sendUsageCommand();
      }
    }
  }
});

pty.onExit(({ exitCode }) => {
  if (usageExitFallbackTimer) {
    clearTimeout(usageExitFallbackTimer);
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

if (wrapperConfig.usageOut) {
  const usagePath = resolve(wrapperConfig.usageOut);

  const finishUsageCapture = () => {
    if (usageCaptureFinished) return;
    usageCaptureFinished = true;
    captureUsageActive = false;
    const content = stripAnsi(capturedUsageRaw.join(''));
    void writeFile(usagePath, content, 'utf8')
      .then(() => {
        console.error(`[claude-pty] Wrote /usage output to ${usagePath}`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[claude-pty] Failed to write usage file: ${message}`);
      })
      .finally(() => {
        if (wrapperConfig.usageExit) {
          pty.write('\x1b');
          setTimeout(() => {
            typeCommand(pty, '/exit');
          }, 250);
          usageExitFallbackTimer = setTimeout(() => {
            pty.kill();
          }, 10000);
        }
      });
  };

  sendUsageCommand = () => {
    if (usageCommandSent) return;
    usageCommandSent = true;
    if (usageSendTimer) {
      clearTimeout(usageSendTimer);
    }
    captureUsageActive = true;
    typeCommand(pty, '/usage');
    setTimeout(() => {
      finishUsageCapture();
    }, wrapperConfig.usageCaptureMs);
  };

  usageSendTimer = setTimeout(() => {
    sendUsageCommand();
  }, wrapperConfig.usageWaitMs);
}
