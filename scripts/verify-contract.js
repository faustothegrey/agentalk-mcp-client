import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.join(__dirname, '../wire-contract.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

const dataStr = JSON.stringify(contract.data, null, 2);
const computedHash = crypto.createHash('sha256').update(dataStr).digest('hex');

if (computedHash !== contract.hash) {
  console.error('FATAL: wire-contract.json data was modified without updating the hash!');
  console.error('Expected Hash: ' + contract.hash);
  console.error('Computed Hash: ' + computedHash);
  console.error('If you intended to modify the contract, you MUST bump the version and recompute the hash.');
  process.exit(1);
}

console.log('Contract hash verified successfully (v' + contract.version + ').');
