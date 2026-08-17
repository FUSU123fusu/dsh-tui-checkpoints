/**
 * recorder.js — turn-boundary checkpoint recorder.
 *
 * Listens to the cordis `session/event` feed; at every top-level turn
 * boundary (turn/start = pre-turn state, turn/end = post-turn state) it
 * queues a shadow-repo snapshot and appends the mapping to a JSONL index.
 * Snapshots serialize through a promise chain so a slow `git add` on a big
 * tree never overlaps the next one; unchanged trees reuse HEAD.
 *
 * Top-level detection uses the durable header's delegationDepth (0 = main
 * session, ≥1 = subagent) — session id prefixes are NOT stable across hosts
 * (the TUI mints bare UUIDs). Subagent file changes still land in snapshots
 * — just at the parent's turn boundaries.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function createRecorder({ cwd, gitDir, indexPath, snapshot, now = Date.now }) {
  let queue = Promise.resolve()
  const baselines = new Set()

  const appendIndex = (entry) => {
    mkdirSync(dirname(indexPath), { recursive: true })
    appendFileSync(indexPath, JSON.stringify(entry) + '\n')
  }

  return {
    /**
     * Feed one session event. `session` is the live Session object (its
     * header carries delegationDepth); only depth-0 (top-level) turn
     * boundaries schedule snapshots — subagent file changes are captured by
     * the parent's boundaries. Returns true when it scheduled a snapshot.
     * Never throws into the cordis event path.
     */
    handle(session, event) {
      if (event === null || typeof event !== 'object') return false
      if (session === null || session === undefined) return false
      const header = session.header
      // Top-level detection: skip only what is provably a subagent
      // (origin marker or a positive delegationDepth). Hosts create main
      // sessions WITHOUT delegationDepth (the TUI mints bare-UUID sessions
      // with no depth field), so `depth !== 0 → skip` would starve the main
      // session; absence defaults to top-level.
      const depth = header?.delegationDepth ?? 0
      if (header?.origin === 'subagent' || depth !== 0) return false
      const sessionId = typeof session.id === 'string' ? session.id : session.id?.value
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

    /** One turn-0 workspace snapshot per session id (fresh sessions only). */
    hasBaseline(sessionId) {
      return baselines.has(sessionId)
    },
    baseline(sessionId) {
      if (baselines.has(sessionId)) return
      baselines.add(sessionId)
      queue = queue.then(async () => {
        const { hash, changed } = await snapshot(cwd, gitDir, `baseline ${sessionId}`)
        if (hash === '') return
        appendIndex({ at: now(), session: sessionId, turn: 0, seq: 0, kind: 'pre', hash, changed })
      }).catch(() => {
        // Same containment as turn snapshots.
      })
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

/**
 * Read the fork-link JSONL ({session, parent} per line, written when a rewind
 * fork is announced) into a child→parent Map. Tolerates torn trailing lines.
 */
export function readLinks(linksPath) {
  let text
  try {
    text = readFileSync(linksPath, 'utf8')
  } catch {
    return new Map()
  }
  const links = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed?.session === 'string' && typeof parsed?.parent === 'string') {
        links.set(parsed.session, parsed.parent)
      }
    } catch {
      // Torn tail — skip.
    }
  }
  return links
}

/**
 * The session family of `sessionId`: itself plus every ancestor and
 * descendant reachable through fork links (rewind branches included), so a
 * post-rewind session still sees its pre-rewind timeline. Returns undefined
 * when `sessionId` is unknown — callers treat that as "no filter".
 */
export function familyOf(links, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const children = new Map()
  for (const [child, parent] of links) {
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [child])
    else list.push(child)
  }
  const family = new Set([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    const id = queue.pop()
    const parent = links.get(id)
    if (parent !== undefined && !family.has(parent)) {
      family.add(parent)
      queue.push(parent)
    }
    for (const child of children.get(id) ?? []) {
      if (!family.has(child)) {
        family.add(child)
        queue.push(child)
      }
    }
  }
  return family
}

/**
 * Panel filter: by default only the current session family's checkpoints;
 * showAll reveals every session that ever worked in this workspace. Entries
 * with no session tag stay visible in both views (they cannot be attributed).
 */
export function filterEntries(entries, family, showAll) {
  if (showAll || family === undefined) return entries
  return entries.filter((entry) => entry.session === undefined || family.has(entry.session))
}
