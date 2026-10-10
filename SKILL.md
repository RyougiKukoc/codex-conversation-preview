---
name: conversation-preview
description: Preview or export Codex CLI conversations as user questions and final assistant replies, reading the full local session logs including messages before /compact. Use for clean conversation previews, chat exports, or reviewing past questions and answers without reasoning, progress messages, or tool calls.
---

# Conversation Preview

Generate a faithful transcript from local Codex rollout JSONL files, never from
the model's current context, a compaction summary, or `history.jsonl` (which lacks
assistant replies). Keep original wording and chronological order.

## Export

Run `scripts/export-session.mjs` with Node.js. It has no third-party dependencies.
Resolve the script relative to this skill's directory, not the working directory.

For the current conversation, run:

```powershell
node "<skill-directory>/scripts/export-session.mjs"
```

The script uses `CODEX_THREAD_ID` to locate the exact local session under
`CODEX_HOME` (or `~/.codex`). It exports both Markdown and a searchable standalone
HTML preview to `conversation-preview/` in the working directory. Read the JSON
result and return clickable links to the generated files; use HTML for a browser
preview and Markdown for a transcript viewer. Open a file if the user asks.

If the current thread ID is unavailable or not found, do not silently substitute
the most recently modified session. List sessions and identify the requested one
using its ID and working directory:

```powershell
node "<skill-directory>/scripts/export-session.mjs" --list --cwd "<workspace>"
node "<skill-directory>/scripts/export-session.mjs" --session "<session-id>"
```

To export a user-selected log or destination:

```powershell
node "<skill-directory>/scripts/export-session.mjs" --input "<rollout.jsonl>" --output-dir "<destination>"
```

`--format md`, `--format html`, and `--codex-home <path>` are also supported.
Exporting other sessions should follow the user's requested scope.

## History and filtering

- Read the entire local log from its beginning, including records before every
  `compacted` entry. Never replace earlier messages with `replacement_history`,
  `retained_context`, or a compaction summary. Repeated legitimate questions and
  replies remain distinct.
- Retain actual user messages and assistant messages with `phase: final_answer`
  (or legacy `channel: final`). Completion events can recover final replies from
  older logs without phase markers; do not guess that an unmarked assistant
  message is final. Avoid counting duplicate event/message representations twice.
- Exclude instructions, environment/skill injections, automatic goal
  continuations, reasoning, commentary, and tool traffic. The user's explicit
  goal-setting request and answers to clarification questions are user input.
- Attachments are represented by text placeholders; binary attachments are not
  copied. Messages are not summarized or truncated.
- An active log is read as a snapshot. A partially written last JSON line is
  reported and skipped; corruption in the middle is an error. A user's current
  request may appear before its final reply has been written.

The command reports sources, message counts, compaction count, and any warnings.
Check these before reporting success. A physically missing or pruned local log
cannot be recovered from model context; report that limitation accurately.

For parser changes, run `node --test scripts/export-session.test.mjs`. These tests
cover compaction history, duplicate event representations, legacy final replies,
injected context, and incomplete live logs.
