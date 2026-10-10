#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (part?.type === 'input_image' || part?.type === 'image') return '[图片附件]';
    if (part?.type === 'input_audio' || part?.type === 'audio') return '[音频附件]';
    if (part?.type === 'input_file') return `[文件附件${part.filename ? `：${part.filename}` : ''}]`;
    return part?.type ? `[附件：${part.type}]` : '';
  }).join('\n');
}

export function cleanUserText(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const trimmed = text.trim();
  if (/^<codex_internal_context\b[^>]*\bsource=["']user_goal["']/.test(trimmed)) {
    const goal = trimmed.match(/User set the goal: "([\s\S]*)"\r?\nUser set goal status:/);
    return goal ? goal[1] : '';
  }
  if (/^<send_user_message_question_reply>/.test(trimmed)) {
    const inner = trimmed.match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
    if (inner) {
      try {
        const answers = JSON.parse(inner[1]);
        if (Array.isArray(answers)) return answers.map(x => x.answer ?? '').filter(Boolean).join('\n');
      } catch { /* Preserve an unrecognized reply rather than silently lose input. */ }
    }
    return text;
  }
  let result = text;
  if (/^\s*# AGENTS\.md instructions for\b/.test(result)) {
    const end = result.indexOf('</INSTRUCTIONS>');
    if (end < 0) return '';
    result = result.slice(end + '</INSTRUCTIONS>'.length).replace(/^\s+/, '');
  }
  // Only strip known injected wrappers at the start; user text containing tags is retained.
  const wrappers = /^(\s*)<(environment_context|user_instructions|instructions|skill|turn_aborted|codex_internal_context)\b[^>]*>[\s\S]*?<\/\2>\s*/;
  while (wrappers.test(result)) result = result.replace(wrappers, '');
  return result.trim() ? result : '';
}

export function extractRows(rows) {
  const candidates = [];
  let meta = {};
  let turnId = 'initial';
  let compactions = 0;
  let unmarkedAssistant = 0;
  function add(role, text, source, row, payload = {}, matchText = text) {
    if (!text?.trim()) return;
    candidates.push({ role, text, source, timestamp: row.timestamp ?? null,
      turnId: payload.turn_id ?? turnId, line: row.__line ?? null, matchText });
  }
  for (const row of rows) {
    const p = row.payload ?? {};
    if (row.type === 'session_meta') { meta = p; continue; }
    if (row.type === 'compacted') { compactions++; continue; }
    if (row.type === 'turn_context' && p.turn_id) turnId = p.turn_id;
    if (row.type === 'event_msg') {
      if (p.type === 'task_started') turnId = p.turn_id ?? `turn-${row.__line ?? candidates.length}`;
      if (p.type === 'user_message') add('user', cleanUserText(p.message ?? ''), 'event', row, p);
      if (p.type === 'task_complete' && typeof p.last_agent_message === 'string') {
        add('assistant', p.last_agent_message, 'completion', row, p);
      }
      continue;
    }
    if (row.type !== 'response_item' || p.type !== 'message') continue;
    if (p.role === 'user') {
      const textOnly = Array.isArray(p.content)
        ? p.content.filter(x => typeof x === 'string' || typeof x?.text === 'string') : p.content;
      add('user', cleanUserText(contentText(p.content)), 'message', row, p, cleanUserText(contentText(textOnly)));
    }
    if (p.role === 'assistant') {
      const phase = p.phase ?? p.channel;
      if (phase === 'final_answer' || phase === 'final') {
        add('assistant', contentText(p.content), 'message', row, p);
      } else if (!phase) unmarkedAssistant++;
    }
  }

  // Pair the nth duplicate representation in a turn; do not dedupe repeated real messages.
  const primaryCounts = new Map();
  const keyFor = x => JSON.stringify([x.turnId, x.role, x.matchText.trim()]);
  for (const x of candidates.filter(x => x.source === 'message')) {
    const key = keyFor(x);
    primaryCounts.set(key, (primaryCounts.get(key) ?? 0) + 1);
  }
  const fallbackCounts = new Map();
  const messages = candidates.filter(x => {
    if (x.source === 'message') return true;
    const key = keyFor(x);
    const ordinal = (fallbackCounts.get(key) ?? 0) + 1;
    fallbackCounts.set(key, ordinal);
    return ordinal > (primaryCounts.get(key) ?? 0);
  }).map(({ source, matchText, ...x }) => x);
  const warnings = [];
  if (unmarkedAssistant && !candidates.some(x => x.role === 'assistant' && x.source === 'completion')) {
    warnings.push(`${unmarkedAssistant} 条未标注阶段的助手消息未导出：日志中没有可确认最终答复的完成事件。`);
  }
  return { meta, messages, compactions, warnings };
}

export async function readSession(file) {
  const stat = await fsp.stat(file);
  if (!stat.isFile() || !stat.size) throw new Error(`日志为空或不是文件：${file}`);
  const handle = await fsp.open(file, 'r');
  const lastByte = Buffer.alloc(1);
  try { await handle.read(lastByte, 0, 1, stat.size - 1); } finally { await handle.close(); }
  const rows = [];
  const invalid = [];
  let line = 0;
  // Bound the stream to the initial size, so a running CLI cannot keep extending this read.
  const input = fs.createReadStream(file, { encoding: 'utf8', end: stat.size - 1 });
  for await (const raw of readline.createInterface({ input, crlfDelay: Infinity })) {
    line++;
    const text = line === 1 ? raw.replace(/^\uFEFF/, '') : raw;
    if (!text.trim()) continue;
    try {
      const row = { ...JSON.parse(text), __line: line };
      if (['session_meta', 'compacted', 'turn_context'].includes(row.type)
        || (row.type === 'response_item' && row.payload?.type === 'message')
        || (row.type === 'event_msg' && ['task_started', 'task_complete', 'user_message'].includes(row.payload?.type))) {
        rows.push(row);
      }
    }
    catch { invalid.push(line); }
  }
  const partial = invalid.filter(n => n === line && lastByte[0] !== 10);
  const corrupt = invalid.filter(n => !partial.includes(n));
  if (corrupt.length) throw new Error(`日志第 ${corrupt[0]} 行不是有效 JSON，已停止导出：${file}`);
  const result = extractRows(rows);
  if (!result.meta.id && !result.meta.session_id) result.warnings.push('日志缺少 session_meta 会话标识，请确认这是完整的原始日志。');
  if (partial.length) result.warnings.push(`忽略尚未写完的末尾 JSON 行（第 ${line} 行）；稍后重新导出可更新预览。`);
  return { ...result, source: path.resolve(file), snapshotBytes: stat.size };
}

async function* walk(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(target);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield target;
  }
}

async function header(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const row = JSON.parse(line.replace(/^\uFEFF/, ''));
      return row.type === 'session_meta' ? row.payload : null;
    }
  } finally { lines.close(); input.destroy(); }
  return null;
}

export async function listSessions(codexHome, cwd) {
  const sessions = [];
  for (const directory of ['sessions', 'archived_sessions']) {
    for await (const file of walk(path.join(codexHome, directory))) {
      let meta;
      try { meta = await header(file); }
      catch { continue; }
      if (!meta) continue;
      if (cwd && normalizePath(meta.cwd ?? '') !== normalizePath(cwd)) continue;
      const stat = await fsp.stat(file);
      sessions.push({ id: meta.id ?? meta.session_id, cwd: meta.cwd,
        timestamp: meta.timestamp, modified: stat.mtime.toISOString(), file });
    }
  }
  return sessions.sort((a, b) => b.modified.localeCompare(a.modified));
}

function normalizePath(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function resolveSession({ input, session, codexHome, threadId }) {
  if (input) return path.resolve(input);
  const id = session || threadId;
  if (!id) throw new Error('没有 CODEX_THREAD_ID。请用 --list 查看本地会话，然后用 --session ID 或 --input 文件指定。');
  const sessions = await listSessions(codexHome);
  const matches = sessions.filter(x => x.id === id);
  if (!matches.length) throw new Error(`找不到会话 ${id} 的本地日志。请检查 --codex-home 或用 --input 指定文件；不会改用其他会话。`);
  if (matches.length > 1) throw new Error(`会话 ${id} 对应多个日志文件，请用 --input 明确指定：\n${matches.map(x => x.file).join('\n')}`);
  return matches[0].file;
}

function info(transcript) {
  return { sessionId: transcript.meta.id ?? transcript.meta.session_id ?? path.basename(transcript.source, '.jsonl'),
    source: transcript.source, cwd: transcript.meta.cwd ?? '',
    userMessages: transcript.messages.filter(x => x.role === 'user').length,
    finalReplies: transcript.messages.filter(x => x.role === 'assistant').length,
    compactions: transcript.compactions, snapshotBytes: transcript.snapshotBytes, warnings: transcript.warnings };
}

export function renderMarkdown(transcript) {
  const details = info(transcript);
  const parts = ['# Codex 会话预览', `会话：${details.sessionId}`, `来源：${details.source}`,
    `用户消息：${details.userMessages} · 最终回复：${details.finalReplies} · 压缩记录：${details.compactions}`];
  if (details.warnings.length) parts.push(`导出提示：${details.warnings.join(' ')}`);
  for (const [index, message] of transcript.messages.entries()) {
    parts.push(`## ${index + 1}. ${message.role === 'user' ? '用户' : '最终回复'}`, message.text);
  }
  return parts.join('\n\n') + '\n';
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderHtml(transcript) {
  const details = info(transcript);
  const cards = transcript.messages.map((message, index) => `<article class="message ${message.role}" id="message-${index + 1}">
<div class="label"><span>${message.role === 'user' ? '用户' : '最终回复'}</span><a href="#message-${index + 1}" aria-label="定位消息 ${index + 1}">#${index + 1}</a></div>
<pre class="content">${escapeHtml(message.text)}</pre></article>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Codex 会话预览</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6f8;--panel:#fff;--fg:#1b2635;--muted:#64748b;--line:#e0e6ed;--accent:#245cbb;--user:#eaf2ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,"Microsoft YaHei",sans-serif;line-height:1.65}main{max-width:1000px;margin:auto;padding:36px 24px 64px}h1{font-size:28px;margin:0 0 6px}.summary{color:var(--muted);margin:0 0 22px}.toolbar{display:flex;gap:12px;position:sticky;top:0;padding:14px 0;background:var(--bg);z-index:1}input{min-width:0;flex:1;font:inherit;padding:9px 13px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg)}button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:9px 14px;background:var(--panel);color:var(--fg);cursor:pointer}.message{margin:16px 0;padding:20px 24px;background:var(--panel);border:1px solid var(--line);border-radius:12px}.message.user{background:var(--user)}.label{display:flex;justify-content:space-between;gap:12px;font-weight:600;font-size:14px;color:var(--accent);margin-bottom:10px}.label a{color:var(--muted);text-decoration:none}.content{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}details{font-size:13px;color:var(--muted);margin:14px 0}details p{overflow-wrap:anywhere}#empty{text-align:center;color:var(--muted);padding:32px}[hidden]{display:none!important}.warning{color:#9a6700;font-size:14px}
@media(prefers-color-scheme:dark){:root{--bg:#111820;--panel:#1b2531;--fg:#e5edf5;--muted:#a6b5c6;--line:#344154;--accent:#94baff;--user:#1b2e48}}
@media(max-width:600px){main{padding:22px 14px 40px}.message{padding:16px}h1{font-size:24px}}
@media print{body{background:#fff;color:#000}main{max-width:none;padding:0}.toolbar,details{display:none}.message{break-inside:avoid;border-color:#ccc;background:#fff}.label{color:#000}}
</style></head><body><main>
<h1>Codex 会话预览</h1>
<p class="summary">${details.userMessages} 条用户消息 · ${details.finalReplies} 条最终回复</p>
<details><summary>来源</summary><p>会话：${escapeHtml(details.sessionId)}<br>本地日志：${escapeHtml(details.source)}<br>已读取 ${details.compactions} 次压缩前后的原始记录</p></details>
${details.warnings.map(x => `<p class="warning">${escapeHtml(x)}</p>`).join('\n')}
<div class="toolbar"><input id="search" type="search" aria-label="搜索提问和回复" placeholder="搜索提问和回复…"><button id="print" type="button">打印</button></div>
<div id="messages">${cards}</div><p id="empty"${cards ? ' hidden' : ''}>没有匹配的消息</p>
</main><script>
const cards = Array.from(document.querySelectorAll('.message'));
document.getElementById('search').addEventListener('input', event => {
  const query = event.target.value.toLocaleLowerCase();
  let visible = 0;
  for (const card of cards) { card.hidden = !card.querySelector('.content').textContent.toLocaleLowerCase().includes(query); if (!card.hidden) visible++; }
  document.getElementById('empty').hidden = visible > 0;
});
document.getElementById('print').addEventListener('click', () => window.print());
</script></body></html>\n`;
}

function options(argv) {
  const result = {};
  const values = new Map([['--input', 'input'], ['--session', 'session'], ['--codex-home', 'codexHome'],
    ['--output-dir', 'outputDir'], ['--format', 'format'], ['--cwd', 'cwd']]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') result.list = true;
    else if (argv[i] === '--help' || argv[i] === '-h') result.help = true;
    else if (values.has(argv[i])) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`缺少参数值：${argv[i]}`);
      result[values.get(argv[i])] = argv[++i];
    } else throw new Error(`未知参数：${argv[i]}`);
  }
  if (result.input && result.session) throw new Error('--input 和 --session 不能同时使用。');
  if (result.cwd && !result.list) throw new Error('--cwd 只用于 --list；指定当前会话时使用 CODEX_THREAD_ID。');
  if (result.format && !['both', 'md', 'html'].includes(result.format)) throw new Error('--format 必须是 both、md 或 html。');
  return result;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = options(argv);
  if (opts.help) {
    console.log('Usage: node export-session.mjs [--session ID | --input FILE] [--output-dir DIR] [--format both|md|html]\n       node export-session.mjs --list [--cwd DIR] [--codex-home DIR]\nDefault: export the exact CODEX_THREAD_ID from local logs, including pre-compaction history.');
    return;
  }
  const codexHome = path.resolve(opts.codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  if (opts.list) {
    console.log(JSON.stringify(await listSessions(codexHome, opts.cwd), null, 2));
    return;
  }
  const file = await resolveSession({ ...opts, codexHome, threadId: env.CODEX_THREAD_ID });
  const transcript = await readSession(file);
  const details = info(transcript);
  const directory = path.resolve(opts.outputDir || 'conversation-preview');
  const basename = details.sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, 'session');
  const artifacts = {};
  const formats = opts.format && opts.format !== 'both' ? [opts.format] : ['md', 'html'];
  for (const format of formats) {
    const destination = path.join(directory, `${basename}.${format}`);
    if (normalizePath(destination) === normalizePath(file)) throw new Error('输出路径不能覆盖原始会话日志。');
  }
  await fsp.mkdir(directory, { recursive: true });
  for (const format of formats) {
    const destination = path.join(directory, `${basename}.${format}`);
    await fsp.writeFile(destination, format === 'md' ? renderMarkdown(transcript) : renderHtml(transcript), 'utf8');
    artifacts[format] = destination;
  }
  console.log(JSON.stringify({ ...details, artifacts }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
