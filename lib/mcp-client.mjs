import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wireContractPath = path.join(__dirname, '..', 'wire-contract.json');
const wireContract = JSON.parse(fs.readFileSync(wireContractPath, 'utf8'));

export class McpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.rpcId = 1;
    this.pendingRpc = new Map();
    this.isShuttingDown = false;
    this.reconnectDelayMs = 1000;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      console.error(`[McpClient] Connecting to ${this.url}`);
      this.ws = new WebSocket(this.url);

      this.ws.on('open', async () => {
        console.error(`[McpClient] Connected.`);
        this.reconnectDelayMs = 1000;
        try {
          await this.callRpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { 
              name: 'agenttalk-client', 
              version: '1.0.0',
              contractVersion: wireContract.version,
              contractHash: wireContract.hash
            }
          });
          
          this.ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {}
          }));
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && this.pendingRpc.has(msg.id)) {
          const { resolve, reject } = this.pendingRpc.get(msg.id);
          this.pendingRpc.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      });

      this.ws.on('close', (code, reason) => {
        console.error(`[McpClient] Disconnected: ${code} ${reason}`);
        for (const { reject } of this.pendingRpc.values()) {
          reject(new Error('WebSocket closed'));
        }
        this.pendingRpc.clear();
        
        if (code === 1008 || code === 4001 || this.isShuttingDown) {
          console.error(`[McpClient] Terminal closure, exiting.`);
          process.exit(code === 1000 || code === 4001 ? 0 : 1);
        }

        setTimeout(() => this.connect().catch(() => {}), this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10000);
      });

      this.ws.on('error', (err) => {
        console.error(`[McpClient] Connection error:`, err.message);
      });
    });
  }

  async callRpc(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    return new Promise((resolve, reject) => {
      const id = this.rpcId++;
      this.pendingRpc.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async callTool(name, args) {
    return this.callRpc('tools/call', { name, arguments: args });
  }

  close(code = 1000, reason = 'Normal closure') {
    this.isShuttingDown = true;
    if (this.ws) {
      this.ws.close(code, reason);
    }
  }
}
