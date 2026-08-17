/**
 * rewind.js — file-side follow-through for conversation rewinds.
 *
 * The TUI's /rewind forks the session log at a turn boundary; the forked
 * session's durable header carries `parentSession` + `seedLength` (the seed
 * event count = boundary seq + 1). A `session/created` listener sees the
 * fork the moment it happens, so the plugin can offer to restore the
 * workspace to the checkpoint matching that exact boundary — closing the
 * "rewind only rewinds the conversation" gap without touching core code.
 */

/**
 * Find the checkpoint matching a rewind boundary. The pre-turn snapshot of
 * turn N is taken at N's turn/start event (seq); a rewind to just before
 * that turn produces seedLength === turnStart.seq. Match that pre snapshot
 * first; otherwise the nearest earlier checkpoint of the same session.
 *
 * @param {Array<{ session: string, seq: number, kind: string, hash: string }>} entries - chronological index rows
 * @param {string} parentSession - the session that was rewound FROM
 * @param {number} seedLength - the fork's seed event count
 */
export function matchRewindCheckpoint(entries, parentSession, seedLength) {
  const own = entries.filter((e) => e.session === parentSession)
  const exact = own.find((e) => e.kind === 'pre' && e.seq === seedLength)
  if (exact !== undefined) return exact
  let best
  for (const e of own) {
    if (typeof e.seq === 'number' && e.seq <= seedLength && (best === undefined || e.seq > best.seq)) best = e
  }
  return best
}

/**
 * Classify a freshly created session: is it a rewind fork of another session?
 * Returns { parentSession, seedLength } or null. Seed-less children (subagent
 * spawns have parentSession but no seedLength; fork shares carry both through
 * the TUI's rewindTo) are excluded.
 */
export function rewindForkOf(header) {
  if (header === null || typeof header !== 'object') return null
  const parentSession = typeof header.parentSession === 'string' ? header.parentSession
    : header.parentSession !== null && typeof header.parentSession === 'object' ? header.parentSession.value
    : undefined
  if (typeof parentSession !== 'string' || parentSession === '') return null
  if (typeof header.seedLength !== 'number' || header.seedLength < 0) return null
  return { parentSession, seedLength: header.seedLength }
}
