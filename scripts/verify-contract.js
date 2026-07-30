import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { execFileSync } from 'child_process';
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

/**
 * BL-106: this repo's primary checkout, resolved correctly even from inside a worktree.
 *
 * Mirrors BL-101's fix in AgentTalk deliberately — the two repos must not drift into two
 * different resolution strategies for the same cross-repo lookup.
 *
 * `--git-common-dir` is the worktree-aware pointer to the shared `.git`, i.e. the PRIMARY
 * checkout's, even when invoked from a linked worktree. `--path-format=absolute` is
 * load-bearing: without it git answers a bare relative `.git` when run in the primary, which
 * would resolve against the wrong cwd and reintroduce a path bug of the same family this
 * function exists to remove.
 *
 * Returns null rather than throwing when git is unavailable or this is not a repository. The
 * caller falls back to the previous behaviour — the original code could not crash here, and
 * neither may this.
 */
function primaryCheckoutRoot() {
  try {
    const gitCommonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return gitCommonDir ? path.dirname(gitCommonDir) : null;
  } catch {
    return null;
  }
}

function sourceContractPath() {
  if (process.env.AGENTTALK_CONTRACT_PATH) {
    return path.resolve(process.env.AGENTTALK_CONTRACT_PATH);
  }
  // BL-106: this used to resolve AgentTalk as a sibling of THIS FILE. Correct only in the
  // primary checkout — from a worktree it named a path that does not exist, and the caller's
  // fail-open branch then turned "I could not look" into "everything is fine", silently, in
  // exactly the place where anyone is actually working.
  const primary = primaryCheckoutRoot();
  if (primary) {
    return path.resolve(primary, '../AgentTalk/packages/contracts/wire-contract.json');
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
    // BL-106: name the path. Before the resolution fix this warning fired on every worktree
    // run and meant nothing; now it should be rare, so when it does fire it is worth knowing
    // where we looked.
    console.warn(`AgentTalk source wire contract not found at ${sourcePath}; skipped source-alignment check.`);
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
