/**
 * recorder.js — turn-boundary checkpoint recorder.
 *
 * Listens to the cordis `session/event` feed; at every top-level turn
 * boundary (turn/start = pre-turn state, turn/end = post-turn state) it
 * queues a shadow-repo snapshot and appends the mapping to a JSONL index.
 * Snapshots serialize through a promise chain so a slow `git add` on a big
 * tree never overlaps the next one; unchanged trees reuse HEAD.
 *
 * Top-level detection uses the persistence naming contract: top-level
 * sessions are `session-<uuid>`, subagents bare uuids. Subagent file changes
 * still land in snapshots — just at the parent's turn boundaries.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function createRecorder({ cwd, gitDir, indexPath, snapshot, now = Date.now }) {
  let queue = Promise.resolve()

  const appendIndex = (entry) => {
    mkdirSync(dirname(indexPath), { recursive: true })
    appendFileSync(indexPath, JSON.stringify(entry) + '\n')
  }

  return {
    /**
     * Feed one session event. Returns true when it scheduled a snapshot.
     * Never throws into the cordis event path.
     */
    handle(sessionId, event) {
      if (typeof sessionId !== 'string' || !sessionId.startsWith('session-')) return false
      if (event === null || typeof event !== 'object') return false
      const kind = event.type === 'turn/start' ? 'pre' : event.type === 'turn/end' ? 'post' : null
      if (kind === null) return false
      const turn = typeof event.data?.turn === 'number' ? event.data.turn : 0
      const seq = typeof event.seq === 'number' ? event.seq : -1
      queue = queue.then(async () => {
        const { hash, changed } = await snapshot(cwd, gitDir, `${kind} turn ${turn}`)
        if (hash === '') return
        appendIndex({ at: now(), session: sessionId, turn, seq, kind, hash, changed })
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
