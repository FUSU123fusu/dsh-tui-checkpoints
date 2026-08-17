# dsh-tui-checkpoints（spike）

给 dsh-TUI 补上「真回溯」缺的那一层：**文件改动**。每个 turn 边界把工作区快照进一个**影子 git 仓库**，`/checkpoints` 浏览并按轮恢复文件状态。

> ⚠️ 这是 spike（技术验证版）。对话回溯用内置的双击 Esc `/rewind`；本插件负责文件那一半。恢复后提示你再回溯对话到同一轮——两段式是刻意的，等验证稳定后会作为核心 PR 并入 rewind。

[English](#english) below.

## 用法

```
/checkpoints     " 打开检查点面板
```

- 列表：● 轮后 / ◦ 轮前快照，turn 号 + commit 短 hash + 时间
- 选中行下方实时显示与当前工作区的 diffstat
- `r` 恢复（3 秒内按两次确认；恢复前先把当前状态存进 `safety-*` 分支，恢复本身也可回滚）
- 恢复文件后，双击 Esc 把对话回溯到同一轮，两边就对齐了

## 原理

- **影子仓库**：`GIT_DIR` 在 `~/.dsh/checkpoints/repos/<工作区hash>.git`，work tree 就是项目目录。项目自己的 `.git` 完全不动，**项目不是 git 仓库也能用**。
- **快照时机**：监听 `session/event`，顶层会话的 `turn/start`（轮前）和 `turn/end`（轮后）各存一次；快照串行排队，无变化复用 HEAD 不堆空提交。
- **忽略规则**：默认排除 `.git`/`node_modules` 等 + 项目的 `.gitignore`，写进影子仓库的 `info/exclude`。
- **恢复语义**：`reset --hard <hash>` + `clean`——后来新增的文件删掉、改过的文件还原。先存安全提交（`safety-*` 分支保留），失败不动任何东西。
- 映射索引：`~/.dsh/checkpoints/index/<工作区hash>.jsonl`（turn/seq ↔ commit hash）。

## 实测性能（dsh-TUI 仓库，含 worktrees）

纯聊天轮零 git 开销（只在出现改文件工具的轮末快照）；改文件轮后台 ~0.7s（大仓库首次 ~5.8s）。快照后台串行排队，不阻塞对话。

## 已知边界

- 嵌套 git 仓库（子模块/worktree）以 gitlink 记录，其内部漂移不展开。
- 只记录文件；对话回溯走内置 rewind。模型记忆 = 会话日志，fork 截断即回溯，无需额外处理。
- 恢复是工作区级操作：正在编辑的未保存内容会被覆盖（但已进安全提交）。

## 开发

```
node --test    " 真 git 临时仓库测试 + recorder 逻辑（10 个）
```

---

## English

Shadow-git workspace checkpoints for dsh-TUI (spike). Every turn boundary snapshots the working tree into a per-workspace shadow repo (the project's own `.git` is never touched; non-git workspaces work too). `/checkpoints` browses per-turn file states and restores with a double-r confirm — the restore itself safety-commits first, so it's rewindable. Conversation rewind stays with the built-in double-Esc `/rewind`; this plugin covers the file half. MIT
