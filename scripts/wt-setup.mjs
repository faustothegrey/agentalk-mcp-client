#!/usr/bin/env node
/**
 * BL-105 — make a git worktree of THIS repo runnable.
 *
 * THE DEFECT
 *   `git worktree add` gives you a checkout with every tracked file and no `node_modules`
 *   (it is gitignored, and git does not copy ignored files). The first command run there dies:
 *
 *       $ npm test
 *       sh: vitest: command not found
 *
 *   (verified 2026-08-02 at d43be0f in a fresh worktree. The item text quotes
 *   `Cannot find package 'vitest' imported from vitest.config.mjs` — that is what you get once
 *   a vitest binary is on PATH but the package is not resolvable from the worktree; with no
 *   `node_modules` at all you never reach vitest's own loader, and npm's `sh` fails first.)
 *
 *   That matters more here than as tidy-up, because the PO's worktree MANDATE says all code
 *   development happens in a per-task worktree. The one repo that had no helper is the one
 *   where every development checkout starts broken.
 *
 * WHAT IT DOES: links this worktree's `node_modules` at the primary checkout's. That is all.
 *
 * WHY A WHOLE-DIRECTORY SYMLINK IS RIGHT *HERE* — the argument, not the precedent
 *   AgentTalk's `scripts/wt-setup.mjs` does something much more elaborate: it creates the
 *   directory and links each entry individually, with separate handling for its own `@agenttalk`
 *   scope, copying each workspace link's RELATIVE target so it resolves inside the worktree. That
 *   machinery is not decoration — it exists because AgentTalk is a workspaces monorepo, where a
 *   workspace package in `node_modules` is a symlink back into the checkout's own source. Link
 *   the directory wholesale and `@agenttalk/foo` resolves to the PRIMARY's source, so a worktree
 *   silently tests code you are not editing. Per-entry linking is the cure for that.
 *
 *   That reason has no analogue in this repo, and it was CHECKED rather than assumed:
 *     - `package.json` declares no `workspaces` key;
 *     - `node_modules` contains no symlinks at all outside `.bin` (`find -type l`), i.e. every
 *       entry is a real installed copy of a third-party package;
 *     - the scoped entries are all third-party (`@eslint`, `@vitest`, `@types`, …) and there is
 *       no self-link for `agentalk-mcp-client`;
 *     - `.bin` shims are relative (`../eslint/bin/eslint.js`), so they stay inside the linked
 *       directory and resolve correctly through it.
 *
 *   With nothing in `node_modules` pointing back into the checkout's source, there is no wrong
 *   source for a worktree to resolve to, and the per-entry machinery would be complexity with its
 *   justification left behind in the other repo. If this repo ever adopts workspaces, this file is
 *   where that assumption has to be revisited — the bullets above are the trigger.
 *
 * WHY IT DOES NOT RUN `npm install`
 *   The committed `package-lock.json` disagrees with `package.json` about a bin name (BL-100,
 *   still open and reserved to the PO). Any install resyncs the lockfile and leaves a modified
 *   TRACKED file behind — on every run, for everyone. Provisioning must leave tracked files
 *   untouched, so this tool reuses the install the primary already has and says so loudly when
 *   there isn't one.
 *
 * WHY IT DERIVES THE PRIMARY RATHER THAN BEING TOLD
 *   No path to a machine may be baked in — BL-100's other half was exactly such a literal and it
 *   made the sibling tool unusable elsewhere. `git worktree list --porcelain` lists the MAIN
 *   working tree first, from any linked worktree, so the primary is derivable from wherever you
 *   stand. (`--git-common-dir`, which `scripts/verify-contract.js` uses for BL-106, answers a
 *   different question — where the shared `.git` is — and only equals the primary checkout under
 *   the usual layout. Here we want the main WORKING TREE, and this is the primitive that names it.)
 *
 * WHY IT DOES NOT REACH ACROSS REPOS
 *   The item's other fix direction was to teach AgentTalk's `wt-setup` a `--repo` argument. One
 *   tool reaching into two checkouts is how BL-101 started: a cross-repo path that was right from
 *   the primary and silently wrong from a worktree, landing in a fail-open branch that turned "I
 *   could not look" into "all fine". This tool resolves nothing outside its own repository.
 *
 * USAGE
 *   node scripts/wt-setup.mjs                      # provision the checkout you are standing in
 *   node scripts/wt-setup.mjs <path>               # provision an existing worktree at <path>
 *   node scripts/wt-setup.mjs <path> [branch]      # create that worktree first, then provision
 *
 * Idempotent: re-running is a no-op that reports what it found. Never deletes a real directory.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function git(args, cwd) {
  try {
    // stderr piped, not ignored: git's own words ("not a git repository", "branch already
    // exists") are the actionable half of any failure here.
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const gitSays = (err.stderr?.toString() || '').trim();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}${gitSays ? `: ${gitSays}` : ` (${err.message})`}`);
  }
}

/**
 * The main working tree of this repository, correct from inside a linked worktree.
 *
 * THROWS when git cannot answer, deliberately — unlike the fail-open in `verify-contract.js`,
 * which had to keep a passing check passing. A provisioning tool that cannot find the primary
 * has nothing to link from; carrying on would produce a checkout that looks provisioned and
 * still cannot run a single command.
 */
export function primaryCheckout(cwd = HERE) {
  const out = git(['worktree', 'list', '--porcelain'], cwd);
  const first = out.split('\n').find((line) => line.startsWith('worktree '));
  if (!first) throw new Error(`could not determine the primary checkout from 'git worktree list' in ${cwd}`);
  return first.slice('worktree '.length);
}

/** The checkout containing `cwd`. */
export function checkoutRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * Compare paths by identity, not by spelling — BL-113's lesson, one layer down. On macOS `/tmp`
 * is a symlink to `/private/tmp`, so two strings naming the same directory compare unequal, and
 * the check that must never be skipped (are we pointing at the primary?) would read false.
 */
function samePath(a, b) {
  const real = (p) => (existsSync(p) ? realpathSync(p) : path.resolve(p));
  return real(a) === real(b);
}

/**
 * Create the worktree if `target` does not exist yet. Returns whether it created one.
 * Branch defaults to the target's directory name.
 */
export function ensureWorktree(target, primary, branch) {
  if (existsSync(target)) return false;
  git(['worktree', 'add', target, '-b', branch || path.basename(target)], primary);
  return true;
}

/**
 * Point `target/node_modules` at the primary's install.
 *
 * @returns {{status: 'linked'|'already-linked'|'own-install', source: string, dest: string}}
 * @throws if `target` IS the primary, or the primary has no install to share.
 */
export function provisionNodeModules(target, primary) {
  // First, before anything can touch the filesystem. The primary owns the one real install on
  // this machine; replacing it with a link to itself would be a loop, and every other worktree
  // depends on it existing.
  if (samePath(target, primary)) {
    throw new Error(
      `refusing to provision the primary checkout (${primary}): it owns the real node_modules. ` +
      `Run 'npm install' there, and point this tool at a worktree.`,
    );
  }

  const source = path.join(primary, 'node_modules');
  if (!existsSync(source)) {
    throw new Error(
      `the primary checkout has no node_modules (${source}). Run 'npm install' there first — ` +
      `this tool will not run it for you, because an install resyncs package-lock.json and would ` +
      `leave a modified tracked file behind (BL-100).`,
    );
  }

  const dest = path.join(target, 'node_modules');
  let existing = null;
  try {
    existing = lstatSync(dest);
  } catch { /* nothing there: the normal fresh-worktree case */ }

  if (existing?.isSymbolicLink()) {
    if (existsSync(dest) && samePath(dest, source)) return { status: 'already-linked', source, dest };
    // A stale or dangling link (a worktree whose primary moved). A symlink holds no data of its
    // own, so replacing one is safe in a way that removing a directory never is.
    unlinkSync(dest);
  } else if (existing) {
    // A real directory: someone ran a real install here. That checkout already works, and its
    // node_modules is not ours to delete.
    return { status: 'own-install', source, dest };
  }

  // 'junction' is ignored on POSIX and is the type that works without elevation on Windows for
  // an absolute directory target — which ours always is.
  symlinkSync(source, dest, 'junction');
  return { status: 'linked', source, dest };
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const [targetArg, branchArg] = argv;
  const primary = primaryCheckout();
  const target = targetArg ? path.resolve(targetArg) : checkoutRoot(process.cwd());

  const created = ensureWorktree(target, primary, branchArg);
  if (created) log(`created worktree ${target}`);

  const { status, source, dest } = provisionNodeModules(target, primary);
  if (status === 'own-install') {
    log(`${dest} is a real directory (its own install); left untouched.`);
  } else if (status === 'already-linked') {
    log(`${dest} already points at ${source}; nothing to do.`);
  } else {
    log(`linked ${dest} -> ${source}`);
  }
  log(`worktree ready: ${target}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`wt-setup: ${err.message}`);
    process.exit(1);
  }
}
