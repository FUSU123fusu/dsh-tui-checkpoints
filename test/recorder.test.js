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

describe('recorder', () => {
  it('schedules snapshots only for top-level turn boundaries', async () => {
    const calls = []
    const { recorder, indexPath } = makeRecorder(async () => ({ hash: 'a'.repeat(40), changed: true }))
    assert.equal(recorder.handle('session-abc', ev('turn/start', 1, 0)), true)
    assert.equal(recorder.handle('session-abc', ev('turn/end', 1, 9)), true)
    assert.equal(recorder.handle('session-abc', ev('assistant/chunk', 1, 3)), false)
    // Subagent sessions (bare uuid) never trigger snapshots.
    assert.equal(recorder.handle('95e33202-7f66-46c1', ev('turn/start', 1, 0)), false)
    assert.equal(recorder.handle(undefined, ev('turn/start', 1, 0)), false)
    await recorder.drain()
    assert.equal(calls.length, 0) // fake captured via index, not calls
    const entries = readIndex(indexPath)
    assert.deepEqual(entries.map((e) => e.kind), ['pre', 'post'])
    assert.deepEqual(entries.map((e) => e.turn), [1, 1])
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
    recorder.handle('session-x', ev('turn/start', 1, 0))
    recorder.handle('session-x', ev('turn/end', 1, 9))
    recorder.handle('session-x', ev('turn/start', 2, 10))
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
    recorder.handle('session-x', ev('turn/start', 1, 0))
    recorder.handle('session-x', ev('turn/end', 1, 9))
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
