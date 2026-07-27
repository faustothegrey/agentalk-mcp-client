import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync, existsSync, readFileSync, symlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { callProvider } from './provider-runtime.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(__dirname, '../bridge.mjs');
export const EXECUTION_MODES = ['persistent', 'one_shot', 'auto'];

function appendAgentId(url, agentId) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}agentId=${encodeURIComponent(agentId)}`;
}

// Deprecated alias kept for backward compatibility (saved recordings, older clients).
const EXECUTION_MODE_ALIASES = {
    interactive: 'persistent',
};
// True for both the canonical 'persistent' value and its legacy 'interactive' alias.
export function isPersistentExecutionMode(value) {
    return value === 'persistent' || value === 'interactive';
}
export function normalizeRequestedExecutionMode(value) {
    const aliased = EXECUTION_MODE_ALIASES[value];
    if (aliased) {
        return aliased;
    }
    return EXECUTION_MODES.includes(value) ? value : 'auto';
}
export function supportsPersistentExecution(providerName) {
    return providerName === 'claude' || providerName === 'codex' || providerName === 'gemini';
}
export function resolveExecutionMode(requestedExecutionMode, providerName) {
    const normalizedRequestedMode = normalizeRequestedExecutionMode(requestedExecutionMode);
    if (normalizedRequestedMode === 'one_shot') {
        return 'one_shot';
    }
    if (supportsPersistentExecution(providerName)) {
        return 'persistent';
    }
    return 'one_shot';
}
function getPersistentProviderCommand(providerName, selectedModel) {
    if (providerName === 'claude') {
        return {
            command: process.env.AGENTTALK_CLAUDE_PERSISTENT_COMMAND ||
                // Deprecated alias kept for backward compatibility.
                process.env.AGENTTALK_CLAUDE_INTERACTIVE_COMMAND ||
                'claude',
            args: [
                '-p',
                '--verbose',
                '--output-format=stream-json',
                '--input-format=stream-json',
                '--permission-mode',
                'bypassPermissions',
                '--model',
                selectedModel || 'sonnet',
                '--add-dir',
                '.git',
            ],
            env: process.env,
        };
    }
    // NOTE: no 'codex' branch either. CodexPersistentExecutor spawns `codex exec`
    // per turn and never routes through here. See BL-057.
    // NOTE: no 'gemini' branch. GeminiPersistentExecutor spawns agy per turn
    // (`agy --print`) and never routes through here; `agy` has no `mcp`
    // subcommand, so the entry that used to live here could only ever hang.
    // See BL-057 / LB-92.
    throw new Error(`Persistent execution is not implemented for provider: ${providerName}`);
}
function extractAssistantText(event) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
        .map((entry) => entry.text)
        .join('');
}
class OneShotExecutor {
    #providerName;
    #selectedModel;
    #status = 'starting';
    constructor(providerName, selectedModel) {
        this.#providerName = providerName;
        this.#selectedModel = selectedModel;
    }
    async initialize() {
        this.#status = 'ready';
    }
    async executeTurn(request, sink = {}) {
        this.#status = 'busy';
        sink.onReplyStart?.({ id: request.id });
        try {
            const result = await callProvider(this.#providerName, this.#selectedModel, request.prompt, {
                ...(request.onStderrChunk ? { onStderrChunk: request.onStderrChunk } : {}),
                // BL-075: honour the per-turn task dir, exactly as gemini and codex already do
                // on the persistent path. Without this the one-shot child inherited our cwd --
                // the workdir's MAIN tree -- so the assigned `agentalk-task-<id>` worktree stayed
                // empty and per-task isolation was not real for goose (or for any provider
                // explicitly running one_shot). Falls back to the workdir when the worker could
                // not provision a task dir (BL-061), which is the pre-BL-075 behaviour.
                cwd: sink.cwd || process.cwd(),
            });
            if (result.response) {
                sink.onReplyChunk?.({ id: request.id, text: result.response });
            }
            sink.onReplyDone?.({
                id: request.id,
                response: result.response,
                tokens: result.tokens,
                tokenDetails: result.tokenDetails,
            });
            return result;
        }
        catch (err) {
            this.#status = 'error';
            sink.onReplyError?.({
                id: request.id,
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
        finally {
            if (this.#status !== 'error') {
                this.#status = 'ready';
            }
        }
    }
    getStatus() {
        return this.#status;
    }
    async close() { }
}
// A persistent session that never answers is indistinguishable from a slow one
// without a deadline, so every turn gets one. Matches the one-shot spawn timeout
// in provider-runtime.mjs; override per-turn via sink.timeoutMs.
const DEFAULT_PERSISTENT_TURN_TIMEOUT_MS = 300000;

class BasePersistentExecutor {
    _providerName;
    _selectedModel;
    _commandOverride;
    _status = 'starting';
    _proc = null;
    _buffer = '';
    _currentRequest = null;
    _currentSink = null;
    _initialized = false;
    _closePromise = null;
    _exitInfo = null;
    _turnTimer = null;
    constructor(providerName, selectedModel, commandOverride) {
        this._providerName = providerName;
        this._selectedModel = selectedModel;
        this._commandOverride = commandOverride;
    }
    async initialize() {
        if (this._initialized) {
            return;
        }
        const { command, args, env } = this._commandOverride || getPersistentProviderCommand(this._providerName, this._selectedModel);
        this._proc = spawn(command, args, {
            // BL-053: session-level cwd -- NOT the per-turn task dir, and it cannot be. This
            // spawn happens once at initialize(), before any turn exists; a long-lived stdio
            // session cannot change directory per turn. So claude (the only provider still on
            // this path) gets session isolation, not task isolation. That is a real limit, but
            // not a containment hole: process.cwd() is the assigned workdir (llm-agent chdir's
            // into it at startup), so claude still cannot reach outside it. Per-task isolation
            // for claude would mean restarting the session per task -- deliberately not done here.
            cwd: process.cwd(),
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this._proc.stdout?.on('data', (chunk) => {
            this._buffer += chunk.toString();
            this._drainStdout();
        });
        this._proc.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            if (this._currentRequest?.onStderrChunk) {
                this._currentRequest.onStderrChunk(text);
            }
            else {
                process.stderr.write(text);
            }
        });
        this._proc.on('error', (err) => {
            this._status = 'error';
            this._rejectCurrentRequest(err);
        });
        this._proc.on('close', (code, signal) => {
            if (this._status === 'terminated')
                return;
            // Remember the exit even when no request is in flight: a turn that
            // arrives later must fail loudly rather than wait on a dead child.
            this._exitInfo = { code, signal };
            const err = new Error(`Persistent ${this._providerName} session exited with code ${code}`);
            this._status = 'error';
            this._rejectCurrentRequest(err);
        });
        await this._onSpawned();
        if (this._exitInfo) {
            this._status = 'error';
            throw new Error(`Persistent ${this._providerName} session exited during startup with code ${this._exitInfo.code} (command: ${command} ${args.join(' ')})`);
        }
        this._initialized = true;
        this._status = 'ready';
    }
    async _onSpawned() {
        // Hooks for sub-classes
    }
    getStatus() {
        return this._status;
    }
    async close() {
        if (this._closePromise) {
            return this._closePromise;
        }
        if (!this._proc) {
            return;
        }
        this._status = 'terminated';
        this._closePromise = new Promise((resolve) => {
            const proc = this._proc;
            this._proc = null;
            proc.once('close', () => resolve());
            proc.stdin?.end();
            setTimeout(() => proc.kill(), 1000);
        });
        await this._closePromise;
    }
    _drainStdout() {
        let newlineIndex;
        while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
            const rawLine = this._buffer.slice(0, newlineIndex);
            this._buffer = this._buffer.slice(newlineIndex + 1);
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            try {
                this._handleEvent(JSON.parse(line));
            }
            catch {
                // Protocol streams should remain machine-readable. Ignore malformed noise.
            }
        }
    }
    _rejectCurrentRequest(err) {
        if (!this._currentRequest) {
            return;
        }
        const currentRequest = this._currentRequest;
        const sink = this._currentSink;
        this._clearCurrentRequest();
        sink?.onReplyError?.({
            id: currentRequest.id,
            error: err instanceof Error ? err.message : String(err),
        });
        currentRequest.reject(err);
    }
    _clearCurrentRequest() {
        if (this._turnTimer) {
            clearTimeout(this._turnTimer);
            this._turnTimer = null;
        }
        this._currentRequest = null;
        this._currentSink = null;
    }
    // Arm after _currentRequest is assigned. A child that is alive but silent
    // (e.g. an unrecognised subcommand dropping into an interactive UI) never
    // emits 'close', so an exit handler alone cannot catch it.
    _armTurnTimeout(sink) {
        const timeoutMs = sink?.timeoutMs ?? DEFAULT_PERSISTENT_TURN_TIMEOUT_MS;
        if (!timeoutMs) {
            return;
        }
        this._turnTimer = setTimeout(() => {
            this._status = 'error';
            this._rejectCurrentRequest(new Error(`Persistent ${this._providerName} session did not respond within ${timeoutMs}ms`));
        }, timeoutMs);
        this._turnTimer.unref?.();
    }
    _sendToStdin(payload) {
        if (this._exitInfo) {
            throw new Error(`Persistent ${this._providerName} session is not available: the session exited with code ${this._exitInfo.code}`);
        }
        if (!this._proc?.stdin || this._proc.stdin.destroyed) {
            throw new Error(`Persistent ${this._providerName} session is not available`);
        }
        this._proc.stdin.write(JSON.stringify(payload) + '\n');
    }
}
class ClaudePersistentExecutor extends BasePersistentExecutor {
    _mcpConfigDir = null;
    async initialize() {
        const agentId = process.env.AGENTTALK_AGENT_ID || 'unknown';
        const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || 'ws://localhost:3000/mcp';
        const agentMcpUrl = appendAgentId(mcpUrl, agentId);
        this._mcpConfigDir = mkdtempSync(join(tmpdir(), `claude-mcp-${agentId}-`));
        const configPath = join(this._mcpConfigDir, 'mcp.json');
        writeFileSync(configPath, JSON.stringify({
            mcpServers: {
                bridge: {
                    command: 'node',
                    args: [bridgePath, agentMcpUrl]
                }
            }
        }, null, 2));
        const baseCmd = this._commandOverride || getPersistentProviderCommand(this._providerName, this._selectedModel);
        this._commandOverride = {
            command: baseCmd.command,
            args: [
                ...baseCmd.args,
                '--mcp-config',
                configPath,
                '--strict-mcp-config'
            ],
            env: {
                ...baseCmd.env,
                // NOTE: do NOT override CLAUDE_CONFIG_DIR here — it points Claude at an empty
                // dir and discards the user's credentials ("Not logged in"). The bridge MCP
                // config is supplied via the --mcp-config flag above, which needs no config-dir
                // override. (BUG-2, verified 2026-06-18.)
                MCP_TOOL_TIMEOUT: '600000',
            }
        };
        await super.initialize();
    }
    async close() {
        await super.close();
        if (this._mcpConfigDir) {
            try {
                rmSync(this._mcpConfigDir, { recursive: true, force: true });
            }
            catch (err) {
                console.error(`[ClaudePersistentExecutor] Failed to clean up temp dir ${this._mcpConfigDir}:`, err);
            }
            this._mcpConfigDir = null;
        }
    }
    async executeTurn(request, sink = {}) {
        if (this._currentRequest) {
            throw new Error(`Persistent ${this._providerName} session is already processing a request`);
        }
        this._status = 'busy';
        this._currentSink = sink;
        sink.onReplyStart?.({ id: request.id });
        const payload = {
            type: 'user',
            model: this._selectedModel,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: request.prompt,
                    },
                ],
            },
        };
        return new Promise((resolve, reject) => {
            this._currentRequest = {
                ...request,
                responseText: '',
                resolve,
                reject,
            };
            this._armTurnTimeout(sink);
            try {
                this._sendToStdin(payload);
            }
            catch (err) {
                this._status = 'error';
                this._clearCurrentRequest();
                reject(err);
            }
        });
    }
    _handleEvent(event) {
        if (!this._currentRequest) {
            return;
        }
        if (event.type === 'assistant') {
            const text = extractAssistantText(event);
            if (text) {
                this._currentRequest.responseText += text;
                this._currentSink?.onReplyChunk?.({ id: this._currentRequest.id, text });
            }
            return;
        }
        if (event.type !== 'result') {
            return;
        }
        const currentRequest = this._currentRequest;
        const sink = this._currentSink;
        const response = currentRequest.responseText || (typeof event.result === 'string' ? event.result : '');
        this._clearCurrentRequest();
        if (event.is_error) {
            this._status = 'error';
            const error = new Error(response || `Persistent ${this._providerName} request failed`);
            sink?.onReplyError?.({ id: currentRequest.id, error: error.message });
            currentRequest.reject(error);
            return;
        }
        this._status = 'ready';
        const tokenDetails = {
            input: event.usage?.input_tokens || 0,
            output: event.usage?.output_tokens || 0,
        };
        const tokens = tokenDetails.input + tokenDetails.output;
        sink?.onReplyDone?.({
            id: currentRequest.id,
            response,
            tokens,
            tokenDetails,
        });
        currentRequest.resolve({ response, tokens, tokenDetails });
    }
}
// The `agy` (Antigravity) binary is a different product from the `gemini` CLI: it
// ignores gemini's `.gemini/settings.json`, and it only spawns MCP servers declared
// in its HOME-level `~/.gemini/config/mcp_config.json`. Project-local mcp_config is
// discovered and then silently ignored (antigravity-cli#60) -- which is why a valid
// workspace plugin loads nothing in either print or interactive mode.
//
// HOME-level would normally mean one global bridge URL for every agent, breaking
// per-agent isolation. We avoid that by pointing HOME at the agent's own temp home
// when spawning agy, so "HOME-level" resolves per agent. See BL-045 / LB-93.
export function writeAgyMcpConfig(homeDir, agentMcpUrl) {
    const config = {
        mcpServers: {
            bridge: {
                command: 'node',
                args: [bridgePath, agentMcpUrl],
            },
        },
    };
    // Current path plus the pre-migration one, so this does not hinge on agy's version.
    const written = [];
    for (const relDir of [['.gemini', 'config'], ['.gemini', 'antigravity-cli']]) {
        const dir = join(homeDir, ...relDir);
        mkdirSync(dir, { recursive: true });
        const configPath = join(dir, 'mcp_config.json');
        writeFileSync(configPath, JSON.stringify(config, null, 2));
        written.push(configPath);
    }
    return written;
}

class GeminiPersistentExecutor extends BasePersistentExecutor {
    _isFirstTurn = true;
    async initialize() {
        const agentId = process.env.AGENTTALK_AGENT_ID || 'unknown';
        const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || 'ws://localhost:3000/mcp';
        const agentMcpUrl = appendAgentId(mcpUrl, agentId);
        // Consumed per-turn by writeAgyBridgePlugin (the path agy actually reads).
        this._agentMcpUrl = agentMcpUrl;
        this._mcpHomeDir = mkdtempSync(join(tmpdir(), `gemini-home-${agentId}-`));
        // Everything below is the *gemini CLI* config mechanism (GEMINI_CLI_HOME +
        // .gemini/settings.json). agy ignores it entirely -- it is retained only so a
        // persistentCommandOverride pointing at the real `gemini` binary still works.
        // For agy the bridge arrives via writeAgyBridgePlugin(); see BL-045 / LB-93.
        const geminiSubdir = join(this._mcpHomeDir, '.gemini');
        mkdirSync(geminiSubdir, { recursive: true });
        // Copy authentication and other state from real home to preserve login credentials
        const realGeminiDir = join(homedir(), '.gemini');
        const filesToCopy = [
            'oauth_creds.json',
            'state.json',
            'google_accounts.json',
            'trustedFolders.json',
            'projects.json',
        ];
        // Redirecting HOME moves agy's credentials out from under it, so its own auth
        // state has to come along or every turn fails with "Authentication required".
        // These are agy's (antigravity-cli), distinct from the gemini-CLI files above.
        const agyFilesToCopy = [
            join('antigravity-cli', 'antigravity-oauth-token'),
            join('antigravity-cli', 'session-primer-key.json'),
            join('antigravity-cli', 'settings.json'),
            join('config', 'config.json'),
            'installation_id',
        ];
        for (const file of [...filesToCopy, ...agyFilesToCopy]) {
            const src = join(realGeminiDir, file);
            if (existsSync(src)) {
                try {
                    const dest = join(geminiSubdir, file);
                    mkdirSync(dirname(dest), { recursive: true });
                    copyFileSync(src, dest);
                }
                catch (err) {
                    console.error(`[GeminiPersistentExecutor] Failed to copy ${file}:`, err);
                }
            }
        }
        // Read existing settings to preserve theme/auth type if possible
        let baseSettings = {};
        const srcSettings = join(realGeminiDir, 'settings.json');
        if (existsSync(srcSettings)) {
            try {
                baseSettings = JSON.parse(readFileSync(srcSettings, 'utf8'));
            }
            catch {
                // ignore
            }
        }
        const settingsPath = join(geminiSubdir, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({
            ...baseSettings,
            mcpServers: {
                bridge: {
                    command: 'node',
                    args: [bridgePath, agentMcpUrl],
                    timeout: 600000
                }
            }
        }, null, 2));
        // The one config agy actually loads MCP servers from, written into this
        // agent's own temp home (HOME is redirected there at spawn time).
        writeAgyMcpConfig(this._mcpHomeDir, agentMcpUrl);
        // agy reads its credentials from the macOS Keychain via go-keyring, which
        // resolves the login keychain under $HOME/Library. Redirecting HOME hides it
        // and raises a GUI "keychain not found" prompt -- fatal for an unattended
        // agent, since nobody is there to dismiss it. Link Library back to the real
        // home so only .gemini is per-agent.
        const realLibrary = join(homedir(), 'Library');
        if (existsSync(realLibrary)) {
            try {
                symlinkSync(realLibrary, join(this._mcpHomeDir, 'Library'), 'dir');
            }
            catch (err) {
                console.error('[GeminiPersistentExecutor] Failed to link Library into the agent home:', err);
            }
        }
        this._initialized = true;
        this._status = 'ready';
    }
    async close() {
        this._status = 'terminated';
        if (this._mcpHomeDir) {
            try {
                rmSync(this._mcpHomeDir, { recursive: true, force: true });
            }
            catch (err) {
                console.error(`[GeminiPersistentExecutor] Failed to clean up temp dir ${this._mcpHomeDir}:`, err);
            }
            this._mcpHomeDir = null;
        }
    }
    async executeTurn(request, sink = {}) {
        {
            if (this._currentRequest) {
                throw new Error(`Persistent ${this._providerName} session is already processing a request`);
            }
            this._status = 'busy';
            this._currentSink = sink;
            sink.onReplyStart?.({ id: request.id });

            const baseCmd = this._commandOverride || { command: 'agy' };
            const args = ['--dangerously-skip-permissions'];
            if (!this._isFirstTurn) {
                args.push('--continue');
            }
            args.push('--print', request.prompt);

            return new Promise((resolve, reject) => {
                this._currentRequest = {
                    ...request,
                    responseText: '',
                    resolve,
                    reject,
                };
                const proc = spawn(baseCmd.command, args, {
                    cwd: sink.cwd || process.cwd(),
                    env: {
                        ...baseCmd.env,
                        ...process.env,
                        // agy resolves its HOME-level mcp_config from ~; pointing HOME at
                        // this agent's temp home is what keeps per-agent bridge URLs
                        // isolated (and keeps the real ~ unpolluted). The auth state
                        // copied into that temp home above is what makes it survivable.
                        HOME: this._mcpHomeDir,
                        GEMINI_CLI_HOME: this._mcpHomeDir,
                        GEMINI_CLI_TRUST_WORKSPACE: 'true',
                    },
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                let timeoutTimer = null;
                if (sink.timeoutMs) {
                    timeoutTimer = setTimeout(() => {
                        try { proc.kill('SIGKILL'); } catch (e) {}
                        this._status = 'error';
                        this._rejectCurrentRequest(new Error(`Execution timed out after ${sink.timeoutMs}ms`));
                    }, sink.timeoutMs);
                }

                proc.stdout?.on('data', (chunk) => {
                    const text = chunk.toString();
                    this._currentRequest.responseText += text;
                    sink.onReplyChunk?.({ id: request.id, text });
                });
                proc.stderr?.on('data', (chunk) => {
                    const text = chunk.toString();
                    if (request.onStderrChunk) {
                        request.onStderrChunk(text);
                    }
                    else {
                        process.stderr.write(text);
                    }
                });
                proc.on('error', (err) => {
                    if (timeoutTimer) clearTimeout(timeoutTimer);
                    this._status = 'error';
                    this._rejectCurrentRequest(err);
                });
                proc.on('close', (code) => {
                    if (timeoutTimer) clearTimeout(timeoutTimer);
                    this._status = 'ready';
                    if (code !== 0) {
                        const err = new Error(`agy exec failed with exit code ${code}`);
                        this._rejectCurrentRequest(err);
                        return;
                    }
                    this._isFirstTurn = false;
                    const response = this._currentRequest?.responseText || '';
                    this._clearCurrentRequest();
                    const tokenDetails = { input: 0, output: 0 };
                    const tokens = 0;
                    sink.onReplyDone?.({
                        id: request.id,
                        response,
                        tokens,
                        tokenDetails,
                    });
                    resolve({ response, tokens, tokenDetails });
                });
            });
        }
    }
    _handleEvent(event) {
        if (!this._currentRequest) {
            return;
        }
        if (event.type === 'assistant') {
            const text = extractAssistantText(event);
            if (text) {
                this._currentRequest.responseText += text;
                this._currentSink?.onReplyChunk?.({ id: this._currentRequest.id, text });
            }
            return;
        }
        if (event.type !== 'result') {
            return;
        }
        const currentRequest = this._currentRequest;
        const sink = this._currentSink;
        const response = currentRequest.responseText || (typeof event.result === 'string' ? event.result : '');
        this._clearCurrentRequest();
        if (event.is_error) {
            this._status = 'error';
            const error = new Error(response || `Persistent ${this._providerName} request failed`);
            sink?.onReplyError?.({ id: currentRequest.id, error: error.message });
            currentRequest.reject(error);
            return;
        }
        this._status = 'ready';
        const tokenDetails = {
            input: event.usage?.input_tokens || 0,
            output: event.usage?.output_tokens || 0,
        };
        const tokens = tokenDetails.input + tokenDetails.output;
        sink?.onReplyDone?.({
            id: currentRequest.id,
            response,
            tokens,
            tokenDetails,
        });
        currentRequest.resolve({ response, tokens, tokenDetails });
    }
}
class CodexPersistentExecutor extends BasePersistentExecutor {
    // Codex is spawned per turn (`codex exec`), so there is no long-lived stdio
    // session to initialize, drain, or close -- hence no super.initialize()/close()
    // and none of BasePersistentExecutor's stdio machinery. See BL-057.
    async initialize() {
        this._initialized = true;
        this._status = 'ready';
    }
    async close() {
        this._status = 'terminated';
    }
    async executeTurn(request, sink = {}) {
        {
            if (this._currentRequest) {
                throw new Error(`Persistent ${this._providerName} session is already processing a request`);
            }
            this._status = 'busy';
            this._currentSink = sink;
            sink.onReplyStart?.({ id: request.id });
            const agentId = process.env.AGENTTALK_AGENT_ID || 'unknown';
            const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || 'ws://localhost:3000/mcp';
            const agentMcpUrl = appendAgentId(mcpUrl, agentId);
            const args = [
                'exec',
                '--dangerously-bypass-approvals-and-sandbox',
                '-c', 'mcp_servers.bridge.command="node"',
                '-c', `mcp_servers.bridge.args=["${bridgePath}","${agentMcpUrl}"]`,
                '-c', 'mcp_servers.bridge.tool_timeout_sec=600',
                request.prompt,
            ];
            return new Promise((resolve, reject) => {
                this._currentRequest = {
                    ...request,
                    responseText: '',
                    resolve,
                    reject,
                };
                const proc = spawn('codex', args, {
                    // BL-053: honour the per-turn task dir, like gemini. Falls back to the
                    // workdir (our own cwd) when the worker could not provision one.
                    cwd: sink.cwd || process.cwd(),
                    env: process.env,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                proc.stdout?.on('data', (chunk) => {
                    const text = chunk.toString();
                    this._currentRequest.responseText += text;
                    sink.onReplyChunk?.({ id: request.id, text });
                });
                proc.stderr?.on('data', (chunk) => {
                    const text = chunk.toString();
                    if (request.onStderrChunk) {
                        request.onStderrChunk(text);
                    }
                    else {
                        process.stderr.write(text);
                    }
                });
                proc.on('error', (err) => {
                    this._status = 'error';
                    this._rejectCurrentRequest(err);
                });
                proc.on('close', (code) => {
                    this._status = 'ready';
                    if (code !== 0) {
                        const err = new Error(`Codex exec failed with exit code ${code}`);
                        this._rejectCurrentRequest(err);
                        return;
                    }
                    const response = this._currentRequest?.responseText || '';
                    this._clearCurrentRequest();
                    const tokenDetails = { input: 0, output: 0 };
                    const tokens = 0;
                    sink.onReplyDone?.({
                        id: request.id,
                        response,
                        tokens,
                        tokenDetails,
                    });
                    resolve({ response, tokens, tokenDetails });
                });
            });
        }
    }
}
export function createExecutor({ providerName, selectedModel, requestedExecutionMode, persistentCommandOverride, }) {
    const normalizedRequestedExecutionMode = normalizeRequestedExecutionMode(requestedExecutionMode);
    const resolvedExecutionMode = resolveExecutionMode(normalizedRequestedExecutionMode, providerName);
    let executor;
    if (isPersistentExecutionMode(resolvedExecutionMode)) {
        if (providerName === 'claude') {
            executor = new ClaudePersistentExecutor(providerName, selectedModel, persistentCommandOverride);
        }
        else if (providerName === 'codex') {
            executor = new CodexPersistentExecutor(providerName, selectedModel, persistentCommandOverride);
        }
        else if (providerName === 'gemini') {
            executor = new GeminiPersistentExecutor(providerName, selectedModel, persistentCommandOverride);
        }
        else {
            executor = new OneShotExecutor(providerName, selectedModel);
        }
    }
    else {
        executor = new OneShotExecutor(providerName, selectedModel);
    }
    return {
        requestedExecutionMode: normalizedRequestedExecutionMode,
        resolvedExecutionMode,
        executor,
    };
}
//# sourceMappingURL=executor-runtime.js.map
