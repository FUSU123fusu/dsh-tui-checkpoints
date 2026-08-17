/**
 * dsh-tui-checkpoints i18n — zh (default) / en, flat dict with {{name}} params.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dict = {
  'cmd-desc': { zh: '工作区检查点：浏览并恢复每轮的文件状态', en: 'Workspace checkpoints: browse and restore per-turn file state' },
  'none': { zh: '还没有检查点（每个 turn 边界会自动存档）', en: 'No checkpoints yet (every turn boundary snapshots automatically)' },
  'no-scene-host': { zh: '当前宿主不支持全屏界面（需要 dsh-TUI），改用文本列表：', en: 'This host has no full-screen scene support (needs dsh-TUI); falling back to a text list:' },

  'list-title': { zh: '工作区检查点（{{count}}）', en: 'Workspace checkpoints ({{count}})' },
  'list-hint': { zh: '↑/↓ 选择 · r 恢复到此检查点 · Esc 退出', en: '↑/↓ select · r restore to this checkpoint · Esc quit' },
  'kind-pre': { zh: '轮前', en: 'pre-turn' },
  'kind-post': { zh: '轮后', en: 'post-turn' },
  'unchanged': { zh: '无变化', en: 'unchanged' },

  'confirm-restore': { zh: '再按一次 r 确认恢复（当前状态会先存入安全提交）', en: 'press r again to confirm restore (current state is safety-committed first)' },
  'restoring': { zh: '恢复中…', en: 'restoring…' },
  'restore-ok': { zh: '✓ 文件已恢复到该检查点；对话请再双击 Esc 回溯到同一轮', en: '✓ files restored; now double-Esc to rewind the conversation to the same turn' },
  'restore-failed': { zh: '✗ 恢复失败：{{err}}', en: '✗ restore failed: {{err}}' },
  'rewind-question': { zh: '检测到你回溯了会话——要把文件也恢复到对应检查点吗（turn {{turn}} {{kind}}）？', en: 'Conversation rewound — restore files to the matching checkpoint too (turn {{turn}} {{kind}})?' },
  'rewind-restore': { zh: '恢复文件', en: 'Restore files' },
  'rewind-keep': { zh: '保持现状', en: 'Keep files as-is' },
}

const LANGS = new Set(['zh', 'en'])

function isLang(value) {
  return typeof value === 'string' && LANGS.has(value)
}

export function detectLang(env = process.env, readFile = readFileSync) {
  if (isLang(env.DSH_TUI_LANG)) return env.DSH_TUI_LANG
  if (isLang(env.CC_TUI_LANG)) return env.CC_TUI_LANG
  try {
    const parsed = JSON.parse(readFile(join(homedir(), '.dsh-tui', 'lang.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && isLang(parsed.lang)) return parsed.lang
  } catch {
    // No readable lang pref — fall through to the default.
  }
  return 'zh'
}

export function createT(lang) {
  return (key, params = {}) => {
    const entry = dict[key]
    const template = entry?.[lang] ?? entry?.zh ?? key
    return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
      name in params ? String(params[name]) : match)
  }
}
