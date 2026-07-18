import { spawn } from 'child_process';
export const SUPPORTED_PROVIDERS = new Set(['claude', 'gemini', 'codex', 'goose', 'agy']);
const MODEL_LIMITS = {
    'sonnet': 200000,
    'sonnet-3-5': 200000,
    'opus': 500000,
    'haiku': 200000,
    'gemini-3.1-pro-preview': 4194304,
    'gemini-3-pro-preview': 4194304,
    'gemini-3-flash-preview': 2097152,
    'gemini-2.5-flash': 1048576,
    'gemini-2.5-pro': 2097152,
    'o3-mini': 200000,
    'o1': 200000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
};
const DEFAULT_PROVIDER_LIMITS = {
    claude: 200000,
    gemini: 2097152,
    codex: 128000,
    goose: 128000,
};
export function resolveProvider(providerArg) {
    if (providerArg === 'agy') {
        return 'gemini';
    }
    if (SUPPORTED_PROVIDERS.has(providerArg)) {
        return providerArg;
    }
    throw new Error(`Unsupported provider: "${providerArg}". Expected one of: ${[...SUPPORTED_PROVIDERS].join(', ')}`);
}
export function getProviderLimit(providerName, selectedModel) {
    return (selectedModel && MODEL_LIMITS[selectedModel]) || DEFAULT_PROVIDER_LIMITS[providerName] || 200000;
}
export function getSpawnEnv(providerName) {
    if (providerName !== 'claude') {
        return process.env;
    }
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    return env;
}
export function stripAnsi(text) {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}
function normalizeCliOutput(text) {
    return stripAnsi(text).replace(/\r/g, '');
}
export async function callProvider(providerName, selectedModel, userMessage, options = {}) {
    const { command, args, stdin } = getProviderCommand(providerName, selectedModel, userMessage);
    const { onStderrChunk } = options;
    const safeArgs = args.map((a) => (a === userMessage ? '<prompt>' : a));
    console.error(`[llm-agent] Running: ${command} ${safeArgs.join(' ')} (prompt via ${stdin ? 'stdin' : 'arg'}, ${userMessage.length} chars)`);
    const { code, stdout, stderr } = await spawnAndCollect(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 300000,
        env: getSpawnEnv(providerName),
        stdin,
        keepStdinOpen: providerName === 'codex',
        onStderrChunk,
    });
    const cleanStdout = normalizeCliOutput(stdout).trim();
    const cleanStderr = normalizeCliOutput(stderr).trim();
    if (cleanStderr && !onStderrChunk) {
        console.error(`[llm-agent] ${providerName} stderr: ${cleanStderr}`);
    }
    if (code !== 0 && providerName !== 'claude') {
        const details = cleanStderr || cleanStdout || `exit code ${code}`;
        throw new Error(`${providerName} failed: ${details}`);
    }
    const response = extractResponse(providerName, cleanStdout);
    const tokens = extractTokens(providerName, cleanStdout);
    const tokenDetails = extractTokenDetails(providerName, cleanStdout);
    if (code !== 0 && !response) {
        const details = cleanStderr || cleanStdout || `exit code ${code}`;
        throw new Error(`${providerName} failed: ${details}`);
    }
    return { response, tokens, tokenDetails };
}
export function getProviderCommand(providerName, selectedModel, userMessage) {
    switch (providerName) {
        case 'claude':
            return {
                command: 'claude',
                args: [
                    '-p',
                    '--model',
                    selectedModel || 'sonnet',
                    '--output-format',
                    'json',
                    '--permission-mode',
                    'bypassPermissions',
                    '--add-dir',
                    '.git',
                ],
                stdin: userMessage,
            };
        case 'codex': {
            const args = [
                'exec',
                '--skip-git-repo-check',
                '--color',
                'never',
                '--json',
                '--full-auto',
                '--add-dir',
                '.git',
            ];
            if (selectedModel) {
                args.push('--model', selectedModel);
            }
            args.push(userMessage);
            return { command: 'codex', args, stdin: null };
        }
        case 'goose': {
            // Goose runs headless and one-shot, driven by an OpenRouter model. It brings its
            // own file/shell tools, so it is a real dev-capable executor (unlike a bare API agent).
            // --output-format json emits a structured result (banner text precedes the JSON object).
            //
            // Optional "coordination profile" via env (dev turns keep the defaults):
            //   AGENTTALK_GOOSE_MAX_TURNS  — cap goose's internal tool-loop (default 30; use a small
            //                                value like 3 for coordination turns so a turn stays under
            //                                the orchestrator's planning-turn budget).
            //   AGENTTALK_GOOSE_NO_PROFILE — '1' adds --no-profile (drop dev tools; pure reasoning).
            //   AGENTTALK_GOOSE_SYSTEM     — extra --system instructions (e.g. "emit exactly one
            //                                structured protocol message; obey the requested message_type").
            // BL-024 T3b: model is a REQUIRED companion for goose — `goose` alone names no agent
            // (it is a harness over an arbitrary OpenRouter model). No silent default: fail loudly
            // if none was supplied. The launcher rejects this earlier; this is the backstop for a
            // direct `llm-agent --provider goose` with no --model.
            if (typeof selectedModel !== 'string' || selectedModel.trim() === '') {
                throw new Error('goose requires an explicit --model (it is a harness over an OpenRouter model)');
            }
            const maxTurns = process.env.AGENTTALK_GOOSE_MAX_TURNS || '30';
            const args = [
                'run',
                '--no-session',
                '--output-format',
                'json',
                '--provider',
                'openrouter',
                '--model',
                selectedModel,
                '--max-turns',
                maxTurns,
            ];
            if (process.env.AGENTTALK_GOOSE_NO_PROFILE === '1') {
                args.push('--no-profile');
            }
            if (process.env.AGENTTALK_GOOSE_SYSTEM) {
                args.push('--system', process.env.AGENTTALK_GOOSE_SYSTEM);
            }
            args.push('-t', userMessage);
            return { command: 'goose', args, stdin: null };
        }
        case 'gemini':
        default: {
            const args = [
                '-p',
                userMessage,
                '--output-format',
                'json',
                '--approval-mode',
                'yolo',
                '--include-directories',
                '.git',
            ];
            args.push('--model', selectedModel || 'gemini-3.1-pro');
            return { command: 'agy', args, stdin: null };
        }
    }
}
// Goose prints an ASCII banner to stdout before its JSON result, so we cannot JSON.parse the
// whole stream. Slice from the first '{' (the banner art contains no braces) and parse that.
function parseGooseJson(stdout) {
    const start = stdout.indexOf('{');
    if (start === -1) {
        return null;
    }
    try {
        return JSON.parse(stdout.slice(start));
    }
    catch {
        return null;
    }
}
export function extractTokenDetails(providerName, stdout) {
    try {
        if (providerName === 'goose') {
            const obj = parseGooseJson(stdout);
            return { input: obj?.metadata?.input_tokens || 0, output: obj?.metadata?.output_tokens || 0 };
        }
        if (providerName === 'codex') {
            for (const line of stdout.split('\n')) {
                if (!line.trim())
                    continue;
                const json = JSON.parse(line);
                if (json.type === 'turn.completed' && json.usage) {
                    return { input: json.usage.input_tokens || 0, output: json.usage.output_tokens || 0 };
                }
            }
            return { input: 0, output: 0 };
        }
        const json = JSON.parse(stdout);
        if (providerName === 'claude') {
            return { input: json.usage?.input_tokens || 0, output: json.usage?.output_tokens || 0 };
        }
        if (providerName === 'gemini' && json.stats?.models) {
            let input = 0, output = 0;
            for (const model of Object.values(json.stats.models)) {
                input += model.tokens?.input || 0;
                output += model.tokens?.output || 0;
            }
            return { input, output };
        }
    }
    catch {
        return { input: 0, output: 0 };
    }
    return { input: 0, output: 0 };
}
function extractTokens(providerName, stdout) {
    try {
        if (providerName === 'goose') {
            const obj = parseGooseJson(stdout);
            return obj?.metadata?.total_tokens || 0;
        }
        if (providerName === 'codex') {
            for (const line of stdout.split('\n')) {
                if (!line.trim())
                    continue;
                const json = JSON.parse(line);
                if (json.type === 'turn.completed' && json.usage) {
                    return (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0);
                }
            }
            return 0;
        }
        const json = JSON.parse(stdout);
        if (providerName === 'claude') {
            return (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0);
        }
        if (providerName === 'gemini' && json.stats?.models) {
            let total = 0;
            for (const model of Object.values(json.stats.models)) {
                total += model.tokens?.total || 0;
            }
            return total;
        }
    }
    catch {
        return 0;
    }
    return 0;
}
function extractResponse(providerName, stdout) {
    try {
        if (providerName === 'goose') {
            const obj = parseGooseJson(stdout);
            const messages = Array.isArray(obj?.messages) ? obj.messages : [];
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'assistant') {
                    const text = (messages[i].content || [])
                        .filter((c) => c.type === 'text' && c.text)
                        .map((c) => c.text)
                        .join('\n')
                        .trim();
                    if (text) {
                        return text;
                    }
                }
            }
            return '';
        }
        if (providerName === 'codex') {
            let lastAgentMessage = '';
            for (const line of stdout.split('\n')) {
                if (!line.trim())
                    continue;
                const json = JSON.parse(line);
                if (json.type === 'item.completed' && json.item?.type === 'agent_message' && json.item?.text) {
                    lastAgentMessage = json.item.text;
                }
            }
            return lastAgentMessage;
        }
        const json = JSON.parse(stdout);
        if (providerName === 'claude') {
            return json.result || '';
        }
        if (providerName === 'gemini') {
            return json.response || '';
        }
    }
    catch {
        return stdout;
    }
    return stdout;
}
export async function scrapeClaudeUsageViaSlashCommand() {
    const expectScript = `
set timeout 35
match_max 200000
log_user 1
spawn -noecho env -u ANTHROPIC_API_KEY claude
after 5000
send -- "/usage\\t\\r"
after 15000
send -- "/exit\\r"
expect eof
`;
    const { stdout, stderr } = await spawnAndCollect('expect', ['-c', expectScript], {
        env: getSpawnEnv('claude'),
        timeout: 35000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return extractClaudeUsageOutput(`${stdout}${stderr}`);
}
function extractClaudeUsageOutput(rawOutput) {
    const cleaned = stripAnsi(rawOutput)
        .replace(/\u0007/g, '')
        .replace(/\r/g, '')
        .replace(/^spawn .*\n/m, '')
        .replace(/^\/exit\s*$/gm, '')
        .trim();
    const usageStart = cleaned.search(/Current session|Current week|% used/i);
    if (usageStart === -1) {
        return '';
    }
    return cleaned.slice(usageStart).trim();
}
function spawnAndCollect(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { stdin, keepStdinOpen = false, onStdoutChunk, onStderrChunk, ...spawnOptions } = options;
        const proc = spawn(command, args, spawnOptions);
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (chunk) => {
            stdout += chunk;
            if (onStdoutChunk) {
                onStdoutChunk(chunk.toString());
            }
        });
        proc.stderr?.on('data', (chunk) => {
            stderr += chunk;
            if (onStderrChunk) {
                onStderrChunk(chunk.toString());
            }
        });
        if (stdin) {
            proc.stdin?.write(stdin);
            proc.stdin?.end();
        }
        else if (!keepStdinOpen && proc.stdin) {
            proc.stdin?.end();
        }
        proc.on('close', (code) => resolve({ code, stdout, stderr }));
        proc.on('error', (err) => reject(err));
    });
}
//# sourceMappingURL=provider-runtime.js.map