import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { diffStat, ensureRepo, gitRun, restore, shadowGitDir, snapshot, workspaceId } from '../lib/shadow.js'

/** Real git against a fresh temp workspace + shadow repo. */
function makeWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-cp-ws-'))
  const gitDir = join(mkdtempSync(join(tmpdir(), 'dsh-cp-repo-')), 'shadow.git')
  return { cwd, gitDir }
}

const cleanups = []
after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

describe('shadow repo (real git)', () => {
  it('snapshots a non-git workspace and reuses HEAD when unchanged', async () => {
    const { cwd, gitDir } = makeWorkspace()
    cleanups.push(cwd, gitDir)
    writeFileSync(join(cwd, 'a.txt'), 'hello')

    const first = await snapshot(cwd, gitDir, 'pre turn 1')
    assert.equal(first.changed, true)
    assert.match(first.hash, /^[0-9a-f]{40}$/)

    const again = await snapshot(cwd, gitDir, 'post turn 1')
    assert.equal(again.changed, false)
    assert.equal(again.hash, first.hash)

    // The workspace never gained a .git of its own.
    assert.equal(existsSync(join(cwd, '.git')), false)
  })

  it('restores file contents and deletes post-checkpoint files, keeping a safety branch', async () => {
    const { cwd, gitDir } = makeWorkspace()
    cleanups.push(cwd, gitDir)
    writeFileSync(join(cwd, 'code.js'), 'v1')
    const cp1 = await snapshot(cwd, gitDir, 'pre turn 1')

    // Agent does work: modifies code.js, creates new.js.
    writeFileSync(join(cwd, 'code.js'), 'v2 broken')
    writeFileSync(join(cwd, 'new.js'), 'added later')
    await snapshot(cwd, gitDir, 'post turn 1')

    const safety = await restore(cwd, gitDir, cp1.hash)
    assert.equal(readFileSync(join(cwd, 'code.js'), 'utf8'), 'v1')
    assert.equal(existsSync(join(cwd, 'new.js')), false)
    assert.match(safety, /^[0-9a-f]{40}$/)

    // The safety branch preserves the pre-restore state.
    const branches = await gitRun(cwd, ['--git-dir', gitDir, 'branch', '--list', 'safety-*'])
    assert.ok(branches.trim().length > 0)
    const v2 = await gitRun(cwd, ['--git-dir', gitDir, 'show', `${safety}:new.js`])
    assert.equal(v2, 'added later')
  })

  it('respects the project .gitignore plus default excludes', async () => {
    const { cwd, gitDir } = makeWorkspace()
    cleanups.push(cwd, gitDir)
    writeFileSync(join(cwd, '.gitignore'), 'dist/\n')
    mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(cwd, 'dist'), { recursive: true })
    writeFileSync(join(cwd, 'node_modules', 'pkg', 'x.js'), 'x')
    writeFileSync(join(cwd, 'dist', 'out.js'), 'out')
    writeFileSync(join(cwd, 'src.js'), 'src')

    await snapshot(cwd, gitDir, 'pre turn 1')
    const files = await gitRun(cwd, ['--git-dir', gitDir, 'ls-tree', '-r', '--name-only', 'HEAD'])
    assert.ok(files.includes('src.js'))
    assert.ok(files.includes('.gitignore'))
    assert.ok(!files.includes('node_modules'))
    assert.ok(!files.includes('dist'))
  })

  it('diffStat summarizes drift from a checkpoint', async () => {
    const { cwd, gitDir } = makeWorkspace()
    cleanups.push(cwd, gitDir)
    writeFileSync(join(cwd, 'a.txt'), 'one\n')
    const cp = await snapshot(cwd, gitDir, 'pre turn 1')
    assert.equal(await diffStat(cwd, gitDir, cp.hash), '')
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n')
    const stat = await diffStat(cwd, gitDir, cp.hash)
    assert.ok(stat.includes('1 file changed'))
  })
})

describe('workspaceId / shadowGitDir', () => {
  it('is stable and path-shape insensitive', () => {
    assert.equal(workspaceId('D:\\Foo\\Bar'), workspaceId('d:/foo/bar/'))
    assert.ok(shadowGitDir('D:\\x').endsWith('.git'))
  })
})
