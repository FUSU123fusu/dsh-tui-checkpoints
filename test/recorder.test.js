import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createRecorder, isMutatingTool, listCheckpoints, readIndex } from '../lib/recorder.js'

const cleanups = []
after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

function makeRecorder(snapshot) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cp-idx-'))
  cleanups.push(dir)
  const recorder = createRecorder({
    cwd: dir,
    gitDir: join(dir, 'shadow.git'),
    indexPath: join(dir, 'index.jsonl'),
    snapshot,
    now: () => 1000,
  })
  return { recorder, indexPath: join(dir, 'index.jsonl') }
}

const ev = (type, turn, seq, extra = {}) => ({ type, seq, time: 0, data: { turn, ...extra } })
const main = { id: 'abc-def', header: { id: 'abc-def', delegationDepth: 0 } }
// TUI-created main sessions carry no delegationDepth field at all.
const mainNoDepth = { id: 'bare-uuid', header: { id: 'bare-uuid' } }
const sub = { id: '95e33202-x', header: { id: '95e33202-x', delegationDepth: 1, origin: 'subagent' } }

describe('isMutatingTool', () => {
  it('known read-only tools do not count', () => {
    assert.equal(isMutatingTool('read'), false)
    assert.equal(isMutatingTool('glob'), false)
    assert.equal(isMutatingTool('Grep'), false)
  })
  it('everything else counts, erring toward snapshots', () => {
    assert.equal(isMutatingTool('write'), true)
    assert.equal(isMutatingTool('bash'), true)
    assert.equal(isMutatingTool('pwsh'), true)
    assert.equal(isMutatingTool('mcp__whatever__thing'), true)
    assert.equal(isMutatingTool(undefined), false)
  })
})

describe('recorder', () => {
  it('snapshots at turn/end only when a mutating tool ran', async () => {
    const { recorder, indexPath } = makeRecorder(async () => ({ hash: 'a'.repeat(40), changed: true }))
    // Chat-only turn: no snapshot.
    recorder.handle(main, ev('turn/start', 1, 0))
    recorder.handle(main, ev('assistant/chunk', 1, 3))
    recorder.handle(main, ev('turn/end', 1, 9))
    // Turn with a read-only tool: still no snapshot.
    recorder.handle(main, ev('turn/start', 2, 10))
    recorder.handle(main, ev('tool/call', 2, 11, { name: 'read' }))
    recorder.handle(main, ev('turn/end', 2, 19))
    // Turn with a write: snapshot.
    assert.equal(recorder.handle(main, ev('turn/start', 3, 20)), false)
    recorder.handle(main, ev('tool/call', 3, 21, { name: 'write' }))
    assert.equal(recorder.handle(main, ev('turn/end', 3, 29)), true)
    // Subagent events never trigger.
    recorder.handle(sub, ev('turn/start', 1, 0))
    recorder.handle(sub, ev('tool/call', 1, 1, { name: 'write' }))
    assert.equal(recorder.handle(sub, ev('turn/end', 1, 9)), false)
    await recorder.drain()
    const entries = readIndex(indexPath)
    assert.deepEqual(entries.map((e) => [e.kind, e.turn]), [['post', 3]])
    assert.equal(entries[0].session, 'abc-def')
  })

  it('TUI-style main sessions (no depth field) record fine', async () => {
    const { recorder, indexPath } = makeRecorder(async () => ({ hash: 'b'.repeat(40), changed: true }))
    recorder.handle(mainNoDepth, ev('turn/start', 1, 0))
    recorder.handle(mainNoDepth, ev('tool/call', 1, 1, { name: 'edit' }))
    recorder.handle(mainNoDepth, ev('turn/end', 1, 9))
    await recorder.drain()
    assert.equal(readIndex(indexPath).length, 1)
  })

  it('serializes snapshots through the queue', async () => {
    let active = 0
    let maxActive = 0
    const { recorder } = makeRecorder(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return { hash: 'b'.repeat(40), changed: true }
    })
    for (let turn = 1; turn <= 3; turn++) {
      recorder.handle(main, ev('turn/start', turn, 0))
      recorder.handle(main, ev('tool/call', turn, 1, { name: 'write' }))
      recorder.handle(main, ev('turn/end', turn, 9))
    }
    await recorder.drain()
    assert.equal(maxActive, 1)
  })

  it('a failed snapshot does not poison later ones', async () => {
    let n = 0
    const { recorder, indexPath } = makeRecorder(async () => {
      n++
      if (n === 1) throw new Error('git exploded')
      return { hash: 'c'.repeat(40), changed: true }
    })
    for (let turn = 1; turn <= 2; turn++) {
      recorder.handle(main, ev('turn/start', turn, 0))
      recorder.handle(main, ev('tool/call', turn, 1, { name: 'write' }))
      recorder.handle(main, ev('turn/end', turn, 9))
    }
    await recorder.drain()
    assert.equal(readIndex(indexPath).length, 1)
  })
})

describe('readIndex / listCheckpoints', () => {
  it('tolerates a torn trailing line and lists newest first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cp-idx-'))
    cleanups.push(dir)
    const indexPath = join(dir, 'index.jsonl')
    const { writeFileSync, appendFileSync } = await import('node:fs')
    writeFileSync(indexPath, JSON.stringify({ hash: 'h1', turn: 1, kind: 'post', at: 1, session: 's' }) + '\n')
    appendFileSync(indexPath, JSON.stringify({ hash: 'h2', turn: 1, kind: 'post', at: 2, session: 's' }) + '\n')
    appendFileSync(indexPath, '{"hash":"h3","tur')
    const entries = listCheckpoints(indexPath)
    assert.deepEqual(entries.map((e) => e.hash), ['h2', 'h1'])
  })

  it('returns [] for a missing index', () => {
    assert.deepEqual(readIndex('C:/no/such/file.jsonl'), [])
  })
})
