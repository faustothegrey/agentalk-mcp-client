import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function computeContractHash(contractData) {
  const dataStr = JSON.stringify(contractData, null, 2);
  return crypto.createHash('sha256').update(dataStr).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sourceContractPath() {
  if (process.env.AGENTTALK_CONTRACT_PATH) {
    return path.resolve(process.env.AGENTTALK_CONTRACT_PATH);
  }
  return path.resolve(__dirname, '../../AgentTalk/packages/contracts/wire-contract.json');
}

function clientContractPath() {
  if (process.env.AGENTTALK_CLIENT_CONTRACT_PATH) {
    return path.resolve(process.env.AGENTTALK_CLIENT_CONTRACT_PATH);
  }
  return path.resolve(__dirname, '../wire-contract.json');
}

function verifyHash(contract, label) {
  const computedHash = computeContractHash(contract.data);
  if (computedHash !== contract.hash) {
    console.error(`FATAL: ${label} data was modified without updating the hash!`);
    console.error('Expected Hash: ' + contract.hash);
    console.error('Computed Hash: ' + computedHash);
    process.exit(1);
  }
}

const sourcePath = sourceContractPath();
const targetPath = clientContractPath();

if (!fs.existsSync(sourcePath)) {
  console.error('FATAL: AgentTalk source wire contract not found at ' + sourcePath);
  process.exit(1);
}

const sourceContract = readJson(sourcePath);
verifyHash(sourceContract, sourcePath);

const nextContents = JSON.stringify(sourceContract, null, 2) + '\n';
const currentContents = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;

if (currentContents === nextContents) {
  console.log(`wire-contract.json already aligned to AgentTalk v${sourceContract.version}.`);
  process.exit(0);
}

fs.writeFileSync(targetPath, nextContents, 'utf8');
console.log(`Synced wire-contract.json from AgentTalk v${sourceContract.version} (${sourceContract.hash}).`);
