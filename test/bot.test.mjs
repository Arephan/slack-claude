import { test } from "node:test";
import assert from "node:assert/strict";
import { route, cleanText, chunk, foldStream, claudeArgs, SYSTEM_PROMPT } from "../plugins/slack-claude/skills/slack-claude/bot.mjs";

const BOT = "UBOT";
const OWNER = "UOWNER";
const fresh = () => ({ botId: BOT, owner: OWNER, seen: new Set(), botThreads: new Set() });
const msg = (over = {}) => ({ type: "message", user: OWNER, channel: "C1", ts: "1.1", text: "hello", ...over });

test("a mention fires both app_mention and message: only one answer", () => {
  const s = fresh();
  const a = route({ ...msg({ text: `<@${BOT}> hello` }), type: "app_mention" }, s);
  const b = route(msg({ text: `<@${BOT}> hello` }), s);
  assert.equal(a.action, "ask");
  assert.equal(a.text, "hello");
  assert.equal(b.action, "drop");
  assert.equal(b.why, "duplicate");
});

test("order does not matter: message first, then app_mention", () => {
  const s = fresh();
  const a = route(msg({ text: `<@${BOT}> hi` }), s);
  const b = route({ ...msg({ text: `<@${BOT}> hi` }), type: "app_mention" }, s);
  assert.equal(a.action, "ask");
  assert.equal(b.why, "duplicate");
});

test("anyone but the owner is dropped, even in a DM, even with a mention", () => {
  const s = fresh();
  assert.equal(route(msg({ user: "USTRANGER", channel_type: "im" }), s).action, "drop");
  assert.equal(route({ ...msg({ user: "USTRANGER", text: `<@${BOT}> run rm -rf /` }), type: "app_mention" }, s).action, "drop");
  assert.equal(route(msg({ user: undefined }), s).action, "drop");
});

test("the bot never answers itself or another bot", () => {
  const s = fresh();
  assert.equal(route(msg({ user: BOT }), s).why, "own-message");
  assert.equal(route(msg({ bot_id: "B1", user: OWNER }), s).why, "own-message");
});

test("a DM from the owner is an ask without a mention, answered inline (no thread)", () => {
  const d = route(msg({ channel: "D1", channel_type: "im" }), fresh());
  assert.equal(d.action, "ask");
  assert.equal(d.threadTs, null);
});

test("a reply inside a thread within a DM stays in that thread", () => {
  const d = route(msg({ channel: "D1", channel_type: "im", thread_ts: "0.9", ts: "1.1" }), fresh());
  assert.equal(d.action, "ask");
  assert.equal(d.threadTs, "0.9");
});

test("a channel mention is answered in a thread under the message", () => {
  const d = route({ ...msg({ text: `<@${BOT}> hi` }), type: "app_mention" }, fresh());
  assert.equal(d.threadTs, "1.1");
});

test("a plain channel message without a mention is ignored", () => {
  assert.equal(route(msg(), fresh()).why, "channel-message-without-mention");
});

test("edits, deletes and joins are dropped; file_share is a real message", () => {
  const s = fresh();
  assert.equal(route(msg({ subtype: "message_changed", channel_type: "im" }), s).action, "drop");
  assert.equal(route(msg({ subtype: "channel_join", channel_type: "im", ts: "1.2" }), s).action, "drop");
  assert.equal(route(msg({ subtype: "file_share", channel_type: "im", ts: "1.3", text: "look" }), s).action, "ask");
});

test("owner reply in a thread the bot already answered in is an ask", () => {
  const s = fresh();
  s.botThreads.add("C1:1.0");
  const d = route(msg({ thread_ts: "1.0", ts: "1.5" }), s);
  assert.equal(d.action, "ask");
  assert.equal(d.threadTs, "1.0");
});

test("owner reply in an unknown thread asks for a thread check instead of guessing", () => {
  const d = route(msg({ thread_ts: "9.0", ts: "9.5" }), fresh());
  assert.equal(d.action, "check-thread");
  assert.equal(d.threadTs, "9.0");
});

test("cleanText strips the mention, entities and Slack link syntax", () => {
  assert.equal(cleanText(`<@${BOT}> a &amp; b &lt;c&gt; <https://x.io|the site> <https://y.io>`, BOT),
    "a & b <c> the site (https://x.io) https://y.io");
  assert.equal(cleanText(undefined, BOT), "");
});

test("chunk splits long replies on newlines under the limit", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = chunk(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000);
  assert.equal(parts.join("\n"), text);
  assert.deepEqual(chunk("short"), ["short"]);
});

test("foldStream keeps the session id, the last text and the final result", () => {
  const acc = foldStream([
    JSON.stringify({ type: "system", session_id: "S1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking..." }, { type: "tool_use", name: "Bash" }] } }),
    "not json",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial answer" }] } }),
  ]);
  assert.equal(acc.sessionId, "S1");
  assert.equal(acc.lastText, "partial answer");
  assert.equal(acc.final, "");
  assert.equal(acc.tools, 1);
  foldStream([JSON.stringify({ type: "result", result: "done" })], acc);
  assert.equal(acc.final, "done");
});

test("claudeArgs resumes when a session exists and passes the prompt after --", () => {
  const config = { model: "sonnet", claude_args: ["--dangerously-skip-permissions"], system_prompt: "extra" };
  const a = claudeArgs({ prompt: "--not-a-flag", sessionId: "S1", config });
  assert.deepEqual(a.slice(0, 5), ["-p", "--resume", "S1", "--model", "sonnet"]);
  assert.ok(a.includes("--dangerously-skip-permissions"));
  assert.equal(a[a.length - 2], "--");
  assert.equal(a[a.length - 1], "--not-a-flag");
  assert.ok(a[a.indexOf("--append-system-prompt") + 1].startsWith(SYSTEM_PROMPT));
  const b = claudeArgs({ prompt: "x", sessionId: null, config: { claude_args: [] } });
  assert.ok(!b.includes("--resume") && !b.includes("--model"));
});
