/**
 * recorder.js — turn-boundary checkpoint recorder.
 *
 * Listens to the cordis `session/event` feed. Snapshots happen ONLY at
 * `turn/end` of turns that actually touched the filesystem (a `tool/call`
 * outside the known read-only set fired) — pure-chat turns cost zero git
 * work. The pre-turn snapshot was dropped: turn N's "pre" ≈ turn N-1's
 * "post", and the rewind matcher falls back to the nearest earlier
 * checkpoint anyway.
 *
 * Top-level detection uses the durable header: only events provably NOT from
 * a subagent (origin 'subagent' or delegationDepth > 0) count — hosts create
 * main sessions without a depth field, so absence defaults to top-level.
 * Subagent file changes are captured at the parent's boundary (the parent's
 * `subagent` tool call counts as mutating).
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Tools that provably cannot change the worktree. Everything else (write,
 * edit, bash, pwsh, mcp tools, third-party plugins) counts as mutating —
 * erring toward a snapshot is the safe direction.
 */
const READONLY_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'list', 'view'])

export function isMutatingTool(name) {
  return typeof name === 'string' && !READONLY_TOOLS.has(name.toLowerCase())
}

export function createRecorder({ cwd, gitDir, indexPath, snapshot, now = Date.now }) {
  let queue = Promise.resolve()
  /** Mutating-tool flag for the open turn; null outside a turn. */
  let turnDirty = null

  const appendIndex = (entry) => {
    mkdirSync(dirname(indexPath), { recursive: true })
    appendFileSync(indexPath, JSON.stringify(entry) + '\n')
  }

  return {
    /**
     * Feed one session event. `session` is the live Session object (its
     * header carries delegationDepth/origin). Returns true when it scheduled
     * a snapshot. Never throws into the cordis event path.
     */
    handle(session, event) {
      if (event === null || typeof event !== 'object') return false
      if (session === null || session === undefined) return false
      const header = session.header
      const depth = header?.delegationDepth ?? 0
      if (header?.origin === 'subagent' || depth !== 0) return false
      const sessionId = typeof session.id === 'string' ? session.id : session.id?.value
      const data = event.data === null || typeof event.data !== 'object' ? {} : event.data

      if (event.type === 'turn/start') {
        turnDirty = false
        return false
      }
      if (event.type === 'tool/call') {
        if (turnDirty === false && isMutatingTool(data.name)) turnDirty = true
        return false
      }
      if (event.type !== 'turn/end') return false
      const dirty = turnDirty === true
      turnDirty = null
      if (!dirty) return false

      const turn = typeof data.turn === 'number' ? data.turn : 0
      const seq = typeof event.seq === 'number' ? event.seq : -1
      queue = queue.then(async () => {
        const { hash, changed } = await snapshot(cwd, gitDir, `post turn ${turn}`)
        if (hash === '') return
        appendIndex({ at: now(), session: sessionId, turn, seq, kind: 'post', hash, changed })
      }).catch(() => {
        // A failed snapshot (git missing, locked tree) must not poison later ones.
      })
      return true
    },

    /** Test/backfill hook: settle the queued snapshots. */
    drain() {
      return queue
    },
  }
}

/** Read the JSONL index, newest last. Tolerates torn trailing lines. */
export function readIndex(indexPath) {
  let text
  try {
    text = readFileSync(indexPath, 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.hash === 'string') entries.push(parsed)
    } catch {
      // Torn tail — skip.
    }
  }
  return entries
}

/** One display row per entry, newest first, unchanged collapses into its hash. */
export function listCheckpoints(indexPath) {
  return readIndex(indexPath).reverse()
}
