import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { callProvider } from './provider-runtime.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(__dirname, '../bridge.mjs');
export const EXECUTION_MODES = ['persistent', 'one_shot', 'auto'];
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
    return providerName === 'claude' || providerName === 'codex' || providerName === 'gemini' || providerName === 'stub';
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
    if (providerName === 'codex') {
        return {
            command: 'codex',
            args: ['mcp-server'],
            env: process.env,
        };
    }
    if (providerName === 'gemini') {
        return {
            command: 'agy',
            args: ['mcp'],
            env: process.env,
        };
    }
    if (providerName === 'stub') {
        const bridgePath = join(__dirname, 'stub-bridge.js');
        return {
            command: 'node',
            args: [bridgePath],
            env: process.env,
        };
    }
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
        this._proc.on('close', (code) => {
            if (this._status === 'terminated')
                return;
            const err = new Error(`Persistent ${this._providerName} session exited with code ${code}`);
            this._status = 'error';
            this._rejectCurrentRequest(err);
        });
        await this._onSpawned();
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
        this._currentRequest = null;
        this._currentSink = null;
    }
    _sendToStdin(payload) {
        if (!this._proc?.stdin || this._proc.stdin.destroyed) {
            throw new Error(`Persistent ${this._providerName} session is not available`);
        }
        this._proc.stdin.write(JSON.stringify(payload) + '\n');
    }
}
class ClaudePersistentExecutor extends BasePersistentExecutor {
    _mcpConfigDir = null;
    async initialize() {
        if (process.env.AGENTTALK_PERSISTENT_MCP === 'true') {
            const agentId = process.env.AGENTTALK_AGENT_ID || 'unknown';
            const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || 'ws://localhost:3000/mcp';
            const agentMcpUrl = `${mcpUrl}?agentId=${agentId}`;
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
        }
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
class GeminiPersistentExecutor extends BasePersistentExecutor {
    _mcpHomeDir = null;
    async initialize() {
        if (process.env.AGENTTALK_PERSISTENT_MCP === 'true') {
            const agentId = process.env.AGENTTALK_AGENT_ID || 'unknown';
            const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || 'ws://localhost:3000/mcp';
            const agentMcpUrl = `${mcpUrl}?agentId=${agentId}`;
            this._mcpHomeDir = mkdtempSync(join(tmpdir(), `gemini-home-${agentId}-`));
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
            for (const file of filesToCopy) {
                const src = join(realGeminiDir, file);
                if (existsSync(src)) {
                    try {
                        copyFileSync(src, join(geminiSubdir, file));
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
            const baseCmd = this._commandOverride || getPersistentProviderCommand(this._providerName, this._selectedModel);
            this._commandOverride = {
                command: baseCmd.command,
                args: baseCmd.args,
                env: {
                    ...baseCmd.env,
                    GEMINI_CLI_HOME: this._mcpHomeDir,
                    GEMINI_CLI_TRUST_WORKSPACE: 'true',
                }
            };
        }
        await super.initialize();
    }
    async close() {
        await super.close();
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
        if (this._currentRequest) {
            throw new Error(`Persistent ${this._providerName} session is already processing a request`);
        }
        this._status = 'busy';
        this._currentSink = sink;
        sink.onReplyStart?.({ id: request.id });
        // Speak the same protocol as ClaudePersistentExecutor
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
class CodexPersistentExecutor extends BasePersistentExecutor {
    #threadId = null;
    #rpcId = 0;
    #pendingRpc = new Map();
    async initialize() {
        if (process.env.AGENTTALK_PERSISTENT_MCP === 'true') {
            this._initialized = true;
            this._status = 'ready';
            return;
        }
        await super.initialize();
    }
    async close() {
        if (process.env.AGENTTALK_PERSISTENT_MCP === 'true') {
            this._status = 'terminated';
            return;
        }
        await super.close();
    }
    async executeTurn(request, sink = {}) {
        if (process.env.AGENTTALK_PERSISTENT_MCP === 'true') {
            if (this._currentRequest) {
                throw new Error(`Persistent ${this._providerName} session is already processing a request`);
            }
            this._status = 'busy';
            this._currentSink = sink;
            sink.onReplyStart?.({ id: request.id });
            const agentId = process.env.AGENTTALK_AGENT_ID || 'unknown';
            const mcpUrl = process.env.AGENTTALK_PERSISTENT_MCP_URL || 'ws://localhost:3000/mcp';
            const agentMcpUrl = `${mcpUrl}?agentId=${agentId}`;
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
                    cwd: process.cwd(),
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
        if (this._currentRequest) {
            throw new Error(`Persistent ${this._providerName} session is already processing a request`);
        }
        this._status = 'busy';
        this._currentSink = sink;
        sink.onReplyStart?.({ id: request.id });
        const toolName = this.#threadId ? 'codex-reply' : 'codex';
        const toolArgs = this.#threadId
            ? { threadId: this.#threadId, prompt: request.prompt }
            : { prompt: request.prompt };
        if (!this.#threadId && this._selectedModel) {
            toolArgs.model = this._selectedModel;
        }
        return new Promise((resolve, reject) => {
            this._currentRequest = {
                ...request,
                responseText: '',
                resolve,
                reject,
            };
            this.#callRpc('tools/call', { name: toolName, arguments: toolArgs }).then((result) => {
                if (!this._currentRequest)
                    return;
                const currentRequest = this._currentRequest;
                const sink = this._currentSink;
                const response = result.content?.[0]?.text || result.content || '';
                this.#threadId = result.threadId || result.structuredContent?.threadId || this.#threadId;
                this._clearCurrentRequest();
                this._status = 'ready';
                sink?.onReplyDone?.({
                    id: currentRequest.id,
                    response,
                    tokens: currentRequest.lastTokens || 0,
                    tokenDetails: currentRequest.lastTokenDetails || { input: 0, output: 0 },
                });
                currentRequest.resolve({
                    response,
                    tokens: currentRequest.lastTokens || 0,
                    tokenDetails: currentRequest.lastTokenDetails || { input: 0, output: 0 },
                });
            }, (err) => {
                this._status = 'error';
                this._rejectCurrentRequest(err);
            });
        });
    }
    #callRpc(method, params) {
        const id = ++this.#rpcId;
        return new Promise((resolve, reject) => {
            this.#pendingRpc.set(id, { resolve, reject });
            this._sendToStdin({ jsonrpc: '2.0', method, params, id });
        });
    }
    _handleEvent(event) {
        if (event.jsonrpc !== '2.0')
            return;
        // Handle Responses
        if (event.id !== undefined) {
            const pending = this.#pendingRpc.get(event.id);
            if (pending) {
                this.#pendingRpc.delete(event.id);
                if (event.error) {
                    pending.reject(new Error(event.error.message || 'RPC Error'));
                }
                else {
                    pending.resolve(event.result);
                }
            }
            return;
        }
        // Handle Notifications (codex/event)
        if (event.method === 'codex/event' && this._currentRequest) {
            const msg = event.params?.msg;
            if (!msg)
                return;
            if (msg.type === 'agent_message_delta' || msg.type === 'agent_message_content_delta') {
                const delta = msg.delta;
                if (delta) {
                    this._currentRequest.responseText += delta;
                    this._currentSink?.onReplyChunk?.({ id: this._currentRequest.id, text: delta });
                }
            }
            else if (msg.type === 'token_count') {
                const usage = msg.info?.last_token_usage || msg.info?.total_token_usage;
                if (usage) {
                    this._currentRequest.lastTokenDetails = {
                        input: usage.input_tokens || 0,
                        output: usage.output_tokens || 0,
                    };
                    this._currentRequest.lastTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
                }
            }
        }
    }
}
class StubPersistentExecutor extends GeminiPersistentExecutor {
    async initialize() {
        if (this._initialized) {
            return;
        }
        const { command, args, env } = this._commandOverride || getPersistentProviderCommand(this._providerName, this._selectedModel);
        this._proc = spawn(command, args, {
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
        this._proc.on('close', (code) => {
            if (this._status === 'terminated')
                return;
            const err = new Error(`Persistent ${this._providerName} session exited with code ${code}`);
            this._status = 'error';
            this._rejectCurrentRequest(err);
        });
        this._initialized = true;
        this._status = 'ready';
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
        else if (providerName === 'stub') {
            executor = new StubPersistentExecutor(providerName, selectedModel, persistentCommandOverride);
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