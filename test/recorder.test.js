import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createRecorder, listCheckpoints, readIndex } from '../lib/recorder.js'

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

const ev = (type, turn, seq) => ({ type, seq, time: 0, data: { turn } })
const main = { id: 'abc-def', header: { id: 'abc-def', delegationDepth: 0 } }
// TUI-created main sessions carry no delegationDepth field at all.
const mainNoDepth = { id: 'bare-uuid', header: { id: 'bare-uuid' } }
const sub = { id: '95e33202-x', header: { id: '95e33202-x', delegationDepth: 1, origin: 'subagent' } }

describe('recorder', () => {
  it('schedules snapshots only for top-level turn boundaries', async () => {
    const { recorder, indexPath } = makeRecorder(async () => ({ hash: 'a'.repeat(40), changed: true }))
    assert.equal(recorder.handle(main, ev('turn/start', 1, 0)), true)
    assert.equal(recorder.handle(main, ev('turn/end', 1, 9)), true)
    assert.equal(recorder.handle(main, ev('assistant/chunk', 1, 3)), false)
    // Subagent sessions (delegationDepth ≥ 1 / origin subagent) never trigger.
    assert.equal(recorder.handle(sub, ev('turn/start', 1, 0)), false)
    assert.equal(recorder.handle(undefined, ev('turn/start', 1, 0)), false)
    // A TUI-style main session without a depth field records fine.
    assert.equal(recorder.handle(mainNoDepth, ev('turn/start', 9, 0)), true)
    await recorder.drain()
    const entries = readIndex(indexPath)
    assert.deepEqual(entries.map((e) => e.kind), ['pre', 'post', 'pre'])
    assert.deepEqual(entries.map((e) => e.turn), [1, 1, 9])
    assert.equal(entries[0].session, 'abc-def')
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
    recorder.handle(main, ev('turn/start', 1, 0))
    recorder.handle(main, ev('turn/end', 1, 9))
    recorder.handle(main, ev('turn/start', 2, 10))
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
    recorder.handle(main, ev('turn/start', 1, 0))
    recorder.handle(main, ev('turn/end', 1, 9))
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
    writeFileSync(indexPath, JSON.stringify({ hash: 'h1', turn: 1, kind: 'pre', at: 1, session: 's' }) + '\n')
    appendFileSync(indexPath, JSON.stringify({ hash: 'h2', turn: 1, kind: 'post', at: 2, session: 's' }) + '\n')
    appendFileSync(indexPath, '{"hash":"h3","tur')
    const entries = listCheckpoints(indexPath)
    assert.deepEqual(entries.map((e) => e.hash), ['h2', 'h1'])
  })

  it('returns [] for a missing index', () => {
    assert.deepEqual(readIndex('C:/no/such/file.jsonl'), [])
  })
})

describe('baseline', () => {
  it('snapshots turn 0 once per session', async () => {
    const { recorder, indexPath } = makeRecorder(async () => ({ hash: 'd'.repeat(40), changed: true }))
    recorder.baseline('s-1')
    recorder.baseline('s-1') // dedupe
    recorder.baseline('s-2')
    assert.equal(recorder.hasBaseline('s-1'), true)
    assert.equal(recorder.hasBaseline('nope'), false)
    await recorder.drain()
    const entries = readIndex(indexPath)
    assert.equal(entries.length, 2)
    assert.ok(entries.every((e) => e.turn === 0 && e.kind === 'pre' && e.seq === 0))
  })
})
