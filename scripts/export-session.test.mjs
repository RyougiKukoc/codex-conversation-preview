import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { cleanUserText, extractRows, readSession, listSessions, resolveSession, renderHtml, renderMarkdown } from './export-session.mjs';

const row = (type, payload) => ({ type, payload, timestamp: '2026-10-10T00:00:00Z' });
const start = id => row('event_msg', { type: 'task_started', turn_id: id });
const message = (role, text, phase) => row('response_item', { type: 'message', role, phase,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
const complete = (id, text) => row('event_msg', { type: 'task_complete', turn_id: id, last_agent_message: text });
const metadata = id => row('session_meta', { id, cwd: process.cwd(), timestamp: '2026-10-10T00:00:00Z' });
const texts = result => result.messages.map(x => [x.role, x.text]);

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-conversation-preview-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function writeLog(file, rows, tail = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n' + tail, 'utf8');
}

test('preserves exact pre/post compact history and ignores replacement histories', () => {
  const original = '早期问题\n\n```js\nconst x = "<summary>";\n```';
  const rows = [metadata('one'), start('a'), message('user', original),
    message('assistant', '进度 SECRET', 'commentary'), row('response_item', { type: 'reasoning', text: 'SECRET' }),
    message('assistant', '原始最终答复', 'final_answer'), complete('a', '原始最终答复'),
    row('compacted', { message: 'SECRET SUMMARY', replacement_history: [message('user', '伪问题').payload, message('assistant', '伪回复', 'final_answer').payload] }),
    start('b'), message('user', original), message('assistant', '原始最终答复', 'final_answer'),
    row('compacted', { message: 'SECOND SECRET', retained_context: [{ role: 'user', text: '伪问题' }] }),
    start('c'), message('user', '压缩后的问题'), message('assistant', '压缩后的答复', 'final_answer')];
  const result = extractRows(rows);
  assert.equal(result.compactions, 2);
  assert.deepEqual(texts(result), [['user', original], ['assistant', '原始最终答复'],
    ['user', original], ['assistant', '原始最终答复'], ['user', '压缩后的问题'], ['assistant', '压缩后的答复']]);
});

test('pairs event/message duplicates without deleting legitimate identical inputs', () => {
  const userEvent = row('event_msg', { type: 'user_message', message: '重复问题' });
  const result = extractRows([start('a'), userEvent, message('user', '重复问题'), userEvent, message('user', '重复问题'),
    message('assistant', '答复', 'final_answer'), complete('a', '答复'), start('b'), message('user', '重复问题'),
    message('assistant', '答复', 'final_answer'), complete('b', '答复')]);
  assert.deepEqual(texts(result), [['user', '重复问题'], ['user', '重复问题'], ['assistant', '答复'], ['user', '重复问题'], ['assistant', '答复']]);
});

test('recovers old unmarked final replies only from completion events', () => {
  const result = extractRows([start('a'), message('user', '问题'), message('assistant', '进度'),
    message('assistant', '最后答复'), complete('a', '最后答复'), start('b'), message('user', '未完成'), message('assistant', '仍在工作')]);
  assert.deepEqual(texts(result), [['user', '问题'], ['assistant', '最后答复'], ['user', '未完成']]);
  const legacy = message('assistant', 'legacy');
  legacy.payload.channel = 'final';
  assert.deepEqual(texts(extractRows([legacy])), [['assistant', 'legacy']]);
  assert.equal(extractRows([message('assistant', '未知')]).warnings.length, 1);
});

test('filters injected wrappers but keeps actual goal requests and clarification answers', () => {
  const goal = '生成预览，保留 /compact 前内容。';
  assert.equal(cleanUserText(`<codex_internal_context source="user_goal">\nUser set the goal: "${goal}"\nUser set goal status: "active".\n</codex_internal_context>`), goal);
  assert.equal(cleanUserText('<codex_internal_context source="goal">\n<objective>自动续跑</objective>\n</codex_internal_context>'), '');
  assert.equal(cleanUserText('<environment_context>隐藏环境</environment_context>'), '');
  assert.equal(cleanUserText('<skill name="x">隐藏技能</skill>'), '');
  assert.equal(cleanUserText('# AGENTS.md instructions for C:/work\n<INSTRUCTIONS>隐藏</INSTRUCTIONS>'), '');
  assert.equal(cleanUserText('<environment_context>隐藏</environment_context>\n真正提问'), '真正提问');
  assert.equal(cleanUserText('请解释 <environment_context>example</environment_context>'), '请解释 <environment_context>example</environment_context>');
  assert.equal(cleanUserText('<send_user_message_question_reply>\n[{"question":"选什么？","answer":"选第二个"}]\n</send_user_message_question_reply>'), '选第二个');
});

test('represents attachments without duplicating the text-only user event', () => {
  const input = message('user', '看看这张图');
  input.payload.content.push({ type: 'input_image', image_url: 'data:image/png;base64,SECRET' });
  const result = extractRows([start('a'), row('event_msg', { type: 'user_message', message: '看看这张图', images: ['SECRET'] }), input]);
  assert.deepEqual(texts(result), [['user', '看看这张图\n[图片附件]']]);
});

test('reads a live snapshot and tolerates only an unfinished last line', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'live.jsonl');
  await writeLog(file, [metadata('live'), start('a'), message('user', '原始问题'), message('assistant', '最终答复', 'final_answer')], '{"type":');
  const before = await fs.readFile(file);
  const result = await readSession(file);
  assert.deepEqual(texts(result), [['user', '原始问题'], ['assistant', '最终答复']]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.snapshotBytes, before.length);
  assert.deepEqual(await fs.readFile(file), before);
  await fs.writeFile(file, JSON.stringify(metadata('bad')) + '\nINVALID\n' + JSON.stringify(message('user', 'later')) + '\n');
  await assert.rejects(readSession(file), /第 2 行/);
  await fs.writeFile(file, JSON.stringify(metadata('bad')) + '\nINVALID\n');
  await assert.rejects(readSession(file), /第 2 行/);
});

test('resolves exact current or archived session, with no latest-session fallback', async t => {
  const root = await temporary(t);
  const current = path.join(root, 'sessions', '2026', '10', '10', 'rollout-current.jsonl');
  const other = path.join(root, 'sessions', 'rollout-newer.jsonl');
  const archived = path.join(root, 'archived_sessions', 'rollout-old.jsonl');
  await writeLog(current, [metadata('current')]);
  await writeLog(other, [metadata('other')]);
  await writeLog(archived, [metadata('archived')]);
  assert.equal(await resolveSession({ codexHome: root, threadId: 'current' }), current);
  assert.equal(await resolveSession({ codexHome: root, session: 'archived', threadId: 'current' }), archived);
  await assert.rejects(resolveSession({ codexHome: root }), /CODEX_THREAD_ID/);
  await assert.rejects(resolveSession({ codexHome: root, threadId: 'missing' }), /不会改用其他会话/);
  assert.equal((await listSessions(root, process.cwd())).length, 3);
  assert.equal((await listSessions(root, path.join(root, 'unrelated'))).length, 0);
  await writeLog(path.join(root, 'sessions', 'duplicate.jsonl'), [metadata('current')]);
  await assert.rejects(resolveSession({ codexHome: root, threadId: 'current' }), /多个日志文件/);
});

test('HTML escapes original content and exports long text without truncation', () => {
  const text = '<script>globalThis.attack=true</script>\n' + '汉字 & "quoted"\n'.repeat(10000) + 'TAIL';
  const result = { ...extractRows([metadata('one'), message('user', '原始问题'), message('assistant', text, 'final_answer')]), source: '/local/log.jsonl', snapshotBytes: 100 };
  const html = renderHtml(result);
  assert(!html.includes('<script>globalThis.attack'));
  assert(html.includes('&lt;script&gt;globalThis.attack=true&lt;/script&gt;'));
  assert(html.includes('TAIL'));
  assert(html.includes('汉字 &amp; &quot;quoted&quot;'));
  assert(renderMarkdown(result).includes(text));
  assert(!html.includes('https://'));
});

test('standalone preview search filters and restores message cards', () => {
  const result = { ...extractRows([metadata('search'), message('user', '查找 COMPACT'), message('assistant', '本地日志', 'final_answer')]), source: '/local/log.jsonl', snapshotBytes: 1 };
  const html = renderHtml(result);
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));
  assert.equal(scripts.length, 1);
  const cards = result.messages.map(x => ({ hidden: false, querySelector: () => ({ textContent: x.text }) }));
  const listeners = {};
  const empty = { hidden: true };
  const document = {
    querySelectorAll: () => cards,
    getElementById: id => id === 'empty' ? empty : { addEventListener: (event, callback) => { listeners[id] = callback; } },
  };
  vm.runInNewContext(scripts[0][1], { document, window: { print() {} } });
  listeners.search({ target: { value: 'compact' } });
  assert.deepEqual(cards.map(x => x.hidden), [false, true]);
  assert.equal(empty.hidden, true);
  listeners.search({ target: { value: '不存在' } });
  assert(cards.every(x => x.hidden));
  assert.equal(empty.hidden, false);
  listeners.search({ target: { value: '' } });
  assert(cards.every(x => !x.hidden));
  assert.equal(empty.hidden, true);
});

test('CLI generates both artifacts and leaves the input log unchanged', async t => {
  const root = await temporary(t);
  const file = path.join(root, 'input.jsonl');
  const output = path.join(root, 'preview');
  await writeLog(file, [metadata('integration'), start('a'), message('user', '压缩前'), message('assistant', '旧回复', 'final_answer'),
    row('compacted', { message: 'SECRET', replacement_history: [] }), start('b'), message('user', '压缩后'), message('assistant', '新回复', 'final_answer')]);
  const before = await fs.readFile(file);
  const script = fileURLToPath(new URL('./export-session.mjs', import.meta.url));
  const run = await promisify(execFile)(process.execPath, [script, '--input', file, '--output-dir', output]);
  const report = JSON.parse(run.stdout);
  assert.equal(report.userMessages, 2);
  assert.equal(report.finalReplies, 2);
  assert.equal(report.compactions, 1);
  assert.equal(report.warnings.length, 0);
  assert((await fs.readFile(report.artifacts.md, 'utf8')).includes('压缩前'));
  assert((await fs.readFile(report.artifacts.html, 'utf8')).includes('压缩后'));
  assert(!(await fs.readFile(report.artifacts.html, 'utf8')).includes('SECRET'));
  assert.deepEqual(await fs.readFile(file), before);
});
