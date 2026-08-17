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
    const id = typeof session?.id === 'string' ? session.id : session?.id?.value
    recorder.handle(id, event)
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
