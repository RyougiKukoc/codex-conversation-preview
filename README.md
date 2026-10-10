# Codex Conversation Preview

A dependency-free Codex skill that exports user questions and final assistant
replies from complete local session logs, including history before `/compact`.

从 Codex CLI 保存在本地的完整会话日志中，提取**用户提问和最终答复**，生成
Markdown 和可搜索的离线 HTML 预览。

## 特点

- 读取原始 rollout JSONL 和本地 `goals_1.sqlite`，而不是模型当前上下文或压缩摘要。
- 保留 `/compact` 前后的原文和时间顺序，跳过压缩摘要及其替代历史。
- 读取 `thread_goals`，补回没有写入 rollout JSONL 的 `/goal` 目标，并避免重复显示。
- 过滤推理、进度说明、工具调用和环境/技能注入信息。
- 默认按 `CODEX_THREAD_ID` 精确选择当前会话，不会误用最近的其他会话。
- 支持旧版完成事件、重复消息去重、正在写入的日志末尾。
- 不调用模型 API，不需要 API key 或第三方 npm 依赖；所有处理在本地完成。

## 安装

需要 Node.js 22 或更新版本；通过 Git 安装还需要 Git。

在 Codex 中让内置安装器安装仓库根目录，并指定 skill 名称：

```text
$skill-installer 从 https://github.com/RyougiKukoc/codex-conversation-preview 安装仓库根目录的 skill，名称设为 conversation-preview。
```

也可以直接克隆到 skills 目录。Windows PowerShell：

```powershell
$previewSkillParent = if ($env:CODEX_HOME) {
    Join-Path $env:CODEX_HOME "skills"
} else {
    Join-Path $HOME ".codex\skills"
}
New-Item -ItemType Directory -Path $previewSkillParent -Force | Out-Null
git clone https://github.com/RyougiKukoc/codex-conversation-preview.git (Join-Path $previewSkillParent "conversation-preview")
```

macOS / Linux：

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
git clone https://github.com/RyougiKukoc/codex-conversation-preview.git \
  "${CODEX_HOME:-$HOME/.codex}/skills/conversation-preview"
```

目标目录应不存在。已经安装过的用户可以进入该目录运行 `git pull --ff-only`
更新；不是通过 Git 安装的目录应先另存，避免覆盖本地修改。

安装后，在下一条 Codex 消息中使用 `$conversation-preview`；若选择器没有更新，
重新启动 Codex。

## 在 Codex 中使用

```text
$conversation-preview 预览当前会话，只显示我的提问和你的最终回复。
```

默认输出到当前工作目录的 `conversation-preview/`：

```text
conversation-preview/
  <session-id>.md
  <session-id>.html
```

HTML 可以直接在浏览器打开，支持搜索和打印，无需启动服务器。消息文本保留
原始 Markdown 写法；需要 Markdown 渲染时，可以在编辑器中打开 `.md` 文件。

## 独立命令行使用

从此仓库目录运行：

```bash
# Codex 环境中导出当前会话
node scripts/export-session.mjs

# 列出本地会话；可加 --cwd 指定工作目录
node scripts/export-session.mjs --list

# 精确指定会话 ID
node scripts/export-session.mjs --session <session-id>

# 直接指定本地日志及输出目录
node scripts/export-session.mjs --input <rollout.jsonl> --output-dir <destination>

# 只输出一种格式
node scripts/export-session.mjs --session <session-id> --format md
```

命令成功后返回 JSON，包含日志路径、消息数量、压缩记录数量、导出文件路径和
警告。完整参数：

| 参数 | 用途 |
| --- | --- |
| `--session <id>` | 选择指定会话；默认使用 `CODEX_THREAD_ID` |
| `--input <file>` | 直接读取指定 JSONL，与 `--session` 互斥 |
| `--list` | 列出 `sessions` 和 `archived_sessions` 中的本地会话 |
| `--cwd <directory>` | 为 `--list` 按工作目录过滤 |
| `--codex-home <directory>` | 指定 Codex 数据目录；默认 `CODEX_HOME` 或 `~/.codex` |
| `--output-dir <directory>` | 输出目录；默认当前目录的 `conversation-preview/` |
| `--format both\|md\|html` | 输出格式；默认 `both` |
| `--help` | 显示帮助 |

## `/compact` 与记录完整性

导出器从本地文件开头读取，遇到 `compacted` 记录时继续处理后面的原始消息，
不会用 `replacement_history`、`retained_context` 或压缩摘要替换此前内容。
在已验证的实际日志中，压缩前的原始记录仍保存在文件里。

`/goal` 的持久目标保存在 Codex home 下的 `goals_1.sqlite`，不一定会作为普通
用户消息写入 rollout JSONL。导出器按会话 ID 读取 `thread_goals`，把目标显示为
`用户目标 (/goal)`；如果压缩记录中已经包含同一目标，则只保留一份。目标状态
会出现在命令返回的 JSON 中。

只有能够确认的最终答复才会导出：`phase: final_answer`、旧版 `channel: final`，
或 `task_complete.last_agent_message`。未标注的助手消息不会被猜测为最终答复。

导出是一个文件快照：当前任务的最终回复尚未写入时，它不会出现在这次预览里，
再次导出即可更新。未写完的末尾 JSON 行会被跳过并报告；中间的损坏行会导致
导出停止。已经删除或裁剪掉的本地记录无法由此工具恢复。

图片、音频和文件附件使用文字占位符，不复制二进制附件。

## 测试

无需安装依赖：

```bash
npm test
```

测试涵盖压缩前后原文保留、重复事件表示、旧版最终回复、上下文过滤、附件、
活动日志快照、精确会话选择、HTML 转义和搜索，以及完整 CLI 导出。
仓库附带 [GitHub Actions 工作流](.github/workflows/test.yml)，会在 Windows、Linux
和 Node.js 22、24 上运行同一套测试。

## License

[MIT](LICENSE)
