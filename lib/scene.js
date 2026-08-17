/**
 * scene.js — the checkpoints scene: a newest-first list of turn-boundary
 * snapshots with a live diffstat for the selected row, and a double-r
 * confirmed restore (the restore itself safety-commits first, so it is
 * rewindable too).
 *
 * Plain createElement, host React via props — same scene contract as
 * dsh-tui-subagents / dsh-tui-jobs.
 */

export function createSceneComponent({ store, api, t }) {
  /**
   * @param {{ React: typeof import('react'), ui: any, channel: any, close(): void }} props
   */
  return function CheckpointsScene({ React, ui, close }) {
    const { Box, Text, useInput, useTerminalSize } = ui
    const { columns, rows: termRows } = useTerminalSize()
    const [, bump] = React.useReducer((x) => x + 1, 0)

    const [cursor, setCursor] = React.useState(0)
    const [entries, setEntries] = React.useState(() => api.list())
    const [stat, setStat] = React.useState('')
    const [note, setNote] = React.useState('')

    const armedRef = React.useRef(0)
    const noteTimerRef = React.useRef(null)
    const flash = (text) => {
      setNote(text)
      if (noteTimerRef.current !== null) clearTimeout(noteTimerRef.current)
      noteTimerRef.current = setTimeout(() => {
        noteTimerRef.current = null
        setNote('')
        bump()
      }, 6000)
    }

    const reload = () => setEntries(api.list())

    // Live diffstat for the selected checkpoint (vs the current work tree).
    const selected = entries[cursor]
    React.useEffect(() => {
      if (selected === undefined) return setStat('')
      let stale = false
      void api.diffStat(selected.hash).then((s) => {
        if (!stale) setStat(s)
      })
      return () => {
        stale = true
      }
    }, [selected?.hash])

    const restoreSelected = () => {
      if (selected === undefined) return
      const now = Date.now()
      if (now - armedRef.current > 3000) {
        armedRef.current = now
        return flash(t('confirm-restore'))
      }
      armedRef.current = 0
      flash(t('restoring'))
      api
        .restore(selected.hash)
        .then(() => {
          flash(t('restore-ok'))
          reload()
        })
        .catch((error) => flash(t('restore-failed', { err: error instanceof Error ? error.message : String(error) })))
    }

    useInput((input, key) => {
      if (key.escape) return close()
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1))
      if (key.downArrow) return setCursor((c) => Math.min(Math.max(0, entries.length - 1), c + 1))
      if (input === 'r' || input === 'R') return restoreSelected()
      return undefined
    })

    const h = React.createElement
    const bodyRows = Math.max(3, termRows - 6)
    const rows = [
      h(Text, { key: 'title', bold: true, color: 'text' }, t('list-title', { count: entries.length })),
      h(Text, { key: 'div', dimColor: true, wrap: 'truncate' }, '─'.repeat(Math.max(8, columns - 2))),
    ]

    const start = Math.max(0, Math.min(cursor - bodyRows + 1, entries.length - bodyRows))
    entries.slice(start, start + bodyRows).forEach((entry, index) => {
      const absolute = start + index
      const isSelected = absolute === cursor
      const kind = entry.kind === 'pre' ? t('kind-pre') : t('kind-post')
      const time = new Date(entry.at).toLocaleTimeString()
      rows.push(
        h(
          Box,
          { key: `${entry.hash}-${absolute}`, flexDirection: 'row' },
          h(Text, { color: isSelected ? 'suggestion' : 'inactive' }, isSelected ? '❯ ' : '  '),
          h(Text, { color: entry.kind === 'post' ? 'success' : 'inactive' }, entry.kind === 'post' ? '● ' : '◦ '),
          h(Text, { bold: isSelected }, `turn ${entry.turn} ${kind} `),
          h(Text, { dimColor: true }, `${entry.hash.slice(0, 8)} · ${time} · ${typeof entry.session === 'string' ? entry.session.slice(0, 6) : '?'}${entry.changed === false ? ` · ${t('unchanged')}` : ''}`),
        ),
      )
    })
    if (stat !== '') {
      rows.push(h(Text, { key: 'stat', dimColor: true, wrap: 'truncate-end' }, `  ⎿ ${stat}`))
    }

    rows.push(h(Text, { key: 'div2', dimColor: true, wrap: 'truncate' }, '─'.repeat(Math.max(8, columns - 2))))
    if (note !== '') rows.push(h(Text, { key: 'note', color: note.startsWith('✗') ? 'error' : 'success' }, note))
    rows.push(h(Text, { key: 'hint', dimColor: true }, t('list-hint')))

    return h(Box, { flexDirection: 'column', paddingX: 1, height: termRows, overflow: 'hidden' }, ...rows)
  }
}
