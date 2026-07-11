import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractPath = process.env.AGENTTALK_CLIENT_CONTRACT_PATH
  ? path.resolve(process.env.AGENTTALK_CLIENT_CONTRACT_PATH)
  : path.join(__dirname, '../wire-contract.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

function computeContractHash(contractData) {
  const dataStr = JSON.stringify(contractData, null, 2);
  return crypto.createHash('sha256').update(dataStr).digest('hex');
}

function verifyHash(candidate, label) {
  const computedHash = computeContractHash(candidate.data);

  if (computedHash !== candidate.hash) {
    console.error(`FATAL: ${label} data was modified without updating the hash!`);
    console.error('Expected Hash: ' + candidate.hash);
    console.error('Computed Hash: ' + computedHash);
    console.error('If you intended to modify the contract, you MUST bump the version and recompute the hash.');
    process.exit(1);
  }
}

function sourceContractPath() {
  if (process.env.AGENTTALK_CONTRACT_PATH) {
    return path.resolve(process.env.AGENTTALK_CONTRACT_PATH);
  }
  return path.resolve(__dirname, '../../AgentTalk/packages/contracts/wire-contract.json');
}

function verifySourceAlignment(clientContract) {
  const sourcePath = sourceContractPath();

  if (!fs.existsSync(sourcePath)) {
    if (process.env.AGENTTALK_CONTRACT_PATH) {
      console.error('FATAL: AgentTalk source wire contract not found at ' + sourcePath);
      process.exit(1);
    }
    console.warn('AgentTalk source wire contract not found; skipped source-alignment check.');
    return;
  }

  const sourceContract = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  verifyHash(sourceContract, sourcePath);

  const sourceData = JSON.stringify(sourceContract.data, null, 2);
  const clientData = JSON.stringify(clientContract.data, null, 2);
  if (
    clientContract.version !== sourceContract.version ||
    clientContract.hash !== sourceContract.hash ||
    clientData !== sourceData
  ) {
    console.error('FATAL: agentalk-mcp-client and AgentTalk wire contracts diverged.');
    console.error(`AgentTalk: v${sourceContract.version} ${sourceContract.hash}`);
    console.error(`Client:    v${clientContract.version} ${clientContract.hash}`);
    console.error('Run npm run sync-contract, then re-run this check.');
    process.exit(1);
  }

  console.log('Contract alignment verified successfully against AgentTalk source.');
}

verifyHash(contract, contractPath);
console.log('Contract hash verified successfully (v' + contract.version + ').');
verifySourceAlignment(contract);
