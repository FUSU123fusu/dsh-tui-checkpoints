/**
 * dsh-tui-checkpoints — shadow-git workspace checkpoints inside dsh-TUI.
 * Every top-level turn boundary snapshots the working tree into a per-
 * workspace shadow repo (the project's own .git is never touched);
 * `/checkpoints` opens a scene to browse them and restore file state.
 *
 * Cordis plugin contract: `name` + `apply`, zero runtime dependencies.
 * `inject: [commands]` in cordis.patch.yml handles service timing; the
 * host-only scene seam is a runtime probe.
 * @module dsh-tui-checkpoints
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createT, detectLang } from './i18n.js'
import { createRecorder, listCheckpoints } from './recorder.js'
import { diffStat, restore, shadowGitDir, snapshot, workspaceId } from './shadow.js'
import { matchRewindCheckpoint, rewindForkOf } from './rewind.js'
import { createSceneComponent } from './scene.js'

export const name = 'dsh-tui-checkpoints'

const SCENE_ID = 'checkpoints'

function createStore() {
  const listeners = new Set()
  return {
    data: {},
    set(patch) {
      Object.assign(this.data, patch)
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const t = createT(detectLang())
  const commands = ctx.get('commands', false)
  if (commands === undefined) return

  const cwd = process.cwd()
  const gitDir = shadowGitDir(cwd)
  const indexPath = join(homedir(), '.dsh', 'checkpoints', 'index', `${workspaceId(cwd)}.jsonl`)
  const store = createStore()

  const recorder = createRecorder({ cwd, gitDir, indexPath, snapshot })
  ctx.on('session/event', (session, event) => {
    recorder.handle(session, event)
  })

  // Rewind follow-through: the TUI's /rewind forks the session log; the
  // fork's header carries parentSession + seedLength. When we see one, offer
  // to restore the workspace to the checkpoint matching that exact boundary,
  // so a double-Esc rewind covers files too. One prompt per fork.
  const rewindSeen = new Set()
  ctx.on('session/created', (session) => {
    const header = session?.header
    const fork = rewindForkOf(header)
    const depth = header?.delegationDepth ?? 0
    const isSubagent = header?.origin === 'subagent' || depth > 0
    const sessionId = typeof session?.id === 'string' ? session.id : session?.id?.value

    // Baseline: every fresh top-level session gets a turn-0 snapshot of the
    // workspace as found. Without it, a rewind to turn 1 of a session that
    // started before the plugin loaded (or resumed with a long old log) has
    // no checkpoint at/below the boundary and the follow-through silently
    // does nothing.
    if (fork === null && !isSubagent && sessionId !== undefined && !recorder.hasBaseline(sessionId)) {
      recorder.baseline(sessionId)
    }

    if (fork === null) return
    if (sessionId !== undefined && rewindSeen.has(sessionId)) return
    if (sessionId !== undefined) rewindSeen.add(sessionId)
    const target = matchRewindCheckpoint(listCheckpoints(indexPath).reverse(), fork.parentSession, fork.seedLength)
    // Debug breadcrumb (temporary): fork detection + match outcome.
    try {
      const debugDir = join(homedir(), '.dsh', 'checkpoints')
      mkdirSync(debugDir, { recursive: true })
      appendFileSync(join(debugDir, 'debug.jsonl'), JSON.stringify({
        at: Date.now(), kind: 'created', parent: fork.parentSession, seedLength: fork.seedLength,
        matched: target === undefined ? null : target.hash.slice(0, 8),
      }) + '\n')
    } catch { /* debug only */ }
    if (target === undefined) return
    const userQuestions = ctx.get('userQuestions', false)
    if (userQuestions === undefined) return
    void userQuestions.ask({
      questions: [{
        id: 'checkpoint-rewind',
        header: '/checkpoints',
        question: t('rewind-question', { turn: target.turn, kind: target.kind === 'pre' ? t('kind-pre') : t('kind-post') }),
        options: [{ label: t('rewind-restore') }, { label: t('rewind-keep') }],
      }],
    }).then(async (answer) => {
      // The ask answer nests: { answers: [{ id, selected: [label…] }] }.
      const item = answer?.answers?.find((entry) => entry.id === 'checkpoint-rewind')
      if (!item?.selected?.includes(t('rewind-restore'))) return
      await restore(cwd, gitDir, target.hash)
    }).catch(() => {
      // Esc / answer failure — leave the worktree alone.
    })
  })

  const api = {
    list: () => listCheckpoints(indexPath),
    diffStat: (hash) => diffStat(cwd, gitDir, hash),
    restore: async (hash) => {
      const safety = await restore(cwd, gitDir, hash)
      return safety
    },
  }

  let sceneRegistered = false
  const ensureScene = () => {
    if (sceneRegistered) return true
    const scenes = ctx.get('tuiScenes', false)
    if (scenes === undefined) return false
    scenes.register({
      id: SCENE_ID,
      title: 'checkpoints',
      component: createSceneComponent({ store, api, t }),
    })
    sceneRegistered = true
    return true
  }

  commands.register({
    name: 'checkpoints',
    description: t('cmd-desc'),
    handler: async () => {
      const entries = api.list()
      if (entries.length === 0) return { kind: 'success', text: t('none') }
      if (!ensureScene() || !ctx.get('tuiScenes', false).open(SCENE_ID)) {
        const lines = entries.slice(0, 20).map((entry) =>
          `${entry.kind === 'pre' ? '◦' : '●'} turn ${entry.turn} ${entry.kind} · ${entry.hash.slice(0, 8)} · ${new Date(entry.at).toLocaleTimeString()}`)
        return { kind: 'success', text: [t('no-scene-host'), ...lines].join('\n') }
      }
      return { kind: 'success' }
    },
  })

  const trees = ctx.get('tuiCommandTrees', false)
  trees?.register({
    root: 'checkpoints',
    descriptions: { zh: '工作区检查点：浏览并恢复每轮的文件状态', en: 'Workspace checkpoints: browse and restore per-turn file state' },
    children: () => [],
  })
}
