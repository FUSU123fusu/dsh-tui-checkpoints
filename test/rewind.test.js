import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { matchRewindCheckpoint, rewindForkOf } from '../lib/rewind.js'

const cp = (session, seq, kind, hash) => ({ session, seq, kind, hash, turn: 1, at: 0, changed: true })

describe('rewindForkOf', () => {
  it('detects a rewind fork by parentSession + seedLength', () => {
    assert.deepEqual(rewindForkOf({ parentSession: 'abc', seedLength: 42 }), { parentSession: 'abc', seedLength: 42 })
    assert.deepEqual(rewindForkOf({ parentSession: { value: 'abc' }, seedLength: 1 }), { parentSession: 'abc', seedLength: 1 })
  })

  it('rejects plain and subagent-spawn sessions', () => {
    assert.equal(rewindForkOf({}), null)
    assert.equal(rewindForkOf(null), null)
    assert.equal(rewindForkOf({ parentSession: 'abc' }), null) // subagent spawn: no seedLength
    assert.equal(rewindForkOf({ seedLength: 3 }), null)
  })
})

describe('matchRewindCheckpoint', () => {
  const entries = [
    cp('s1', 0, 'pre', 'aaaa'),   // turn 1 pre
    cp('s1', 8, 'post', 'bbbb'),  // turn 1 post
    cp('s1', 9, 'pre', 'cccc'),   // turn 2 pre
    cp('s2', 5, 'post', 'dddd'),  // another session (a previous timeline)
  ]

  it('matches the exact pre-turn snapshot at the boundary', () => {
    // Rewinding to just before turn 2 (turn/start seq 9) → seedLength 9.
    assert.equal(matchRewindCheckpoint(entries, 's1', 9)?.hash, 'cccc')
  })

  it('falls back to the nearest earlier checkpoint of the same session', () => {
    assert.equal(matchRewindCheckpoint(entries, 's1', 8)?.hash, 'bbbb')
    assert.equal(matchRewindCheckpoint(entries, 's1', 0)?.hash, 'aaaa')
  })

  it('never crosses sessions and returns undefined when nothing fits', () => {
    assert.equal(matchRewindCheckpoint(entries, 's1', 8)?.hash === 'dddd', false)
    assert.equal(matchRewindCheckpoint(entries, 'nope', 99), undefined)
    assert.equal(matchRewindCheckpoint([], 's1', 9), undefined)
  })
})
