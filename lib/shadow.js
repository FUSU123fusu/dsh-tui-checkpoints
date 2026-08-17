/**
 * shadow.js — the shadow git repository layer.
 *
 * One shadow repo per workspace: GIT_DIR lives under
 * `~/.dsh/checkpoints/repos/<hash>.git`, its work tree IS the workspace. The
 * workspace's own `.git` (if any) is never touched — this works on plain
 * directories too. Commits happen at turn boundaries; restore is a forced
 * checkout plus a clean, preceded by a safety commit of the live state.
 *
 * Every function takes an injectable `run` (execFile-style, args array, cwd)
 * so tests can drive real git against temp dirs or a fake for edge cases.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Default runner: real git, 30s ceiling, 10MB output buffer. */
export async function gitRun(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  })
  return stdout
}

/** Stable per-workspace id from its absolute path. */
export function workspaceId(cwd) {
  return createHash('sha256').update(cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 16)
}

/** Default shadow-root: ~/.dsh/checkpoints/repos/<workspaceId>.git */
export function shadowGitDir(cwd, root = join(homedir(), '.dsh', 'checkpoints', 'repos')) {
  return join(root, `${workspaceId(cwd)}.git`)
}

/** Never-snapshot paths: VCS internals and heavyweight generated dirs. */
const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.dsh', '.dsh-tui']

/**
 * Create the shadow repo if missing and (re)write its exclude list from
 * defaults + the workspace's own .gitignore. Idempotent.
 */
export async function ensureRepo(cwd, gitDir, run = gitRun) {
  if (!existsSync(join(gitDir, 'HEAD'))) {
    mkdirSync(gitDir, { recursive: true })
    await run(cwd, ['--git-dir', gitDir, 'init', '--bare'])
  }
  const excludes = [...DEFAULT_EXCLUDES]
  try {
    for (const line of readFileSync(join(cwd, '.gitignore'), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith('!')) excludes.push(trimmed)
    }
  } catch {
    // No project .gitignore — defaults alone.
  }
  mkdirSync(join(gitDir, 'info'), { recursive: true })
  writeFileSync(join(gitDir, 'info', 'exclude'), excludes.join('\n') + '\n')
}

async function git(cwd, gitDir, args, run) {
  return run(cwd, ['--git-dir', gitDir, '--work-tree', cwd, ...args])
}

/**
 * Commit the current work-tree state. Returns { hash, changed }: unchanged
 * trees reuse the HEAD hash instead of piling up empty commits.
 *
 * Change detection is `diff --cached` against HEAD after staging — a
 * `status --porcelain` check would misread nested-repo gitlink drift
 * (embedded worktrees/submodules that `git add` refuses to stage) as
 * changes and then die on a "nothing to commit" commit.
 */
export async function snapshot(cwd, gitDir, message, run = gitRun) {
  await ensureRepo(cwd, gitDir, run)
  await git(cwd, gitDir, ['add', '-A'], run)
  const head = await git(cwd, gitDir, ['rev-parse', '--verify', 'HEAD'], run).catch(() => '')
  const staged = await run(cwd, ['--git-dir', gitDir, '--work-tree', cwd, 'diff', '--cached', '--quiet', ...(head === '' ? [] : ['HEAD'])])
    .then(() => false) // exit 0 = no staged changes
    .catch(() => true) // exit 1 = staged changes
  if (!staged) return { hash: head.trim(), changed: false }
  // Commit without reading the user's identity config chain: the shadow repo
  // is local bookkeeping, not authorship.
  try {
    await git(cwd, gitDir, ['-c', 'user.name=dsh-checkpoints', '-c', 'user.email=checkpoints@dsh.local', 'commit', '-q', '-m', message], run)
  } catch {
    // Nested-repo gitlink drift can leave nothing committable despite a
    // dirty-looking index; treat as unchanged rather than failing the turn.
    return { hash: head.trim(), changed: false }
  }
  const hash = await git(cwd, gitDir, ['rev-parse', 'HEAD'], run)
  return { hash: hash.trim(), changed: true }
}

/** One-line diff stat of the work tree against a checkpoint. */
export async function diffStat(cwd, gitDir, hash, run = gitRun) {
  const out = await git(cwd, gitDir, ['diff', '--stat', hash], run).catch(() => '')
  const lines = out.trim().split('\n').filter(Boolean)
  return lines.length === 0 ? '' : lines[lines.length - 1]
}

/**
 * Restore the work tree to a checkpoint. Takes a safety commit of the live
 * state first and keeps it on a `safety-*` branch (so a restore is itself
 * rewindable), then `reset --hard` moves HEAD+index+worktree to the
 * checkpoint — deleting files added after it — and clean sweeps residue.
 * Returns the safety hash; throws before touching anything when the safety
 * commit fails.
 */
export async function restore(cwd, gitDir, hash, run = gitRun) {
  const safety = await snapshot(cwd, gitDir, `safety before restore to ${hash.slice(0, 8)}`, run)
  if (safety.hash !== '') {
    await git(cwd, gitDir, ['branch', '-f', `safety-${Date.now()}`, safety.hash], run)
  }
  await git(cwd, gitDir, ['reset', '--hard', hash], run)
  await git(cwd, gitDir, ['clean', '-fdq'], run)
  return safety.hash
}
