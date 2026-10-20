#!/usr/bin/env node
/**
 * slack-claude: a Slack bot that runs your messages through Claude Code on
 * this machine and posts the answer back in the thread.
 *
 * Transport is Slack Socket Mode: the bot opens an outbound WebSocket and
 * Slack pushes events down it. No public URL, no ngrok, no inbound port.
 *
 * Triggers (owner only, see config.owner):
 *   - a DM to the bot
 *   - an @mention of the bot in any channel it is in
 *   - a reply by the owner in a thread the bot already answered in
 *
 * Acks: 👀 the moment a message is accepted, then ✅ answered / ❌ failed /
 * ❓ nothing to answer.
 *
 * Config lives in ~/.slack-claude/config.json (override the directory with
 * SLACK_CLAUDE_HOME). Node 22 or newer, no dependencies.
 *
 * Commands:
 *   node bot.mjs            run the bot (foreground; a service wrapper keeps it up)
 *   node bot.mjs check      verify tokens, scopes, owner, and the claude binary
 *   node bot.mjs users      list the humans in the workspace with their IDs
 *   node bot.mjs ask "..."  run one prompt through claude the way the bot would
 *   node bot.mjs logs       tail the log
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const HOME = process.env.SLACK_CLAUDE_HOME || join(homedir(), ".slack-claude");
const CONFIG_FILE = join(HOME, "config.json");
const SESSIONS_FILE = join(HOME, "sessions.json");
const LOG_FILE = join(HOME, "bot.log");

const DEFAULTS = {
  model: "",                       // "" = claude's default
  cwd: homedir(),                  // where claude runs
  cap_minutes: 15,                 // one answer may take at most this long
  claude_args: ["--dangerously-skip-permissions"],
  system_prompt: "",               // appended after the built-in one
  session_max_age_days: 7,         // resume a thread's session only this long
};

export const SYSTEM_PROMPT =
  "You are answering a Slack message. Your whole reply is posted to Slack as one message, so: " +
  "write Slack mrkdwn (*bold*, _italic_, `code`, ``` fenced blocks, bullets with •), never Markdown headings or tables. " +
  "Be brief; Slack is read on a phone. Do not post to Slack yourself and do not describe what you are about to do: " +
  "do the work, then print only the final message text. " +
  "The person cannot answer questions mid-run, so make a reasonable assumption and say what you assumed. " +
  "Anything you start in the background dies the moment you finish, so never promise background work: " +
  "do it in the foreground or say it cannot be done from here.";

// ---------- small pure helpers (exported for tests) ----------

/** Slack sends HTML entities and <url|label> links; hand Claude plain text. */
export function cleanText(text, botId) {
  return (text ?? "")
    .replaceAll(`<@${botId}>`, "")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .trim();
}

/** Slack caps a message at 40k chars; past ~4k it also reads badly. Split on newlines. */
export function chunk(text, max = 3800) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Decide what to do with one Slack event. Pure: `state` carries the sets that
 * make it idempotent. Returns { action: "ask", channel, ts, threadTs, text }
 * or { action: "drop", why } or { action: "check-thread", ... } when the only
 * open question is whether the bot already spoke in that thread.
 *
 * The owner gate is the entire security model: Claude runs with whatever
 * permissions config.claude_args grants, so nobody but the owner may reach it.
 */
export function route(ev, { botId, owner, seen, botThreads }) {
  if (!ev) return { action: "drop", why: "no-event" };
  if (ev.bot_id || ev.user === botId) return { action: "drop", why: "own-message" };
  if (ev.user !== owner) return { action: "drop", why: `not-owner:${ev.user ?? "?"}` };
  // Slack fires BOTH `message` and `app_mention` for one mention, in either order.
  const key = `${ev.channel}:${ev.ts}`;
  if (seen.has(key)) return { action: "drop", why: "duplicate" };
  const text = cleanText(ev.text, botId);
  const mentioned = (ev.text ?? "").includes(`<@${botId}>`);
  // In a DM the conversation is the channel itself: reply inline, one Claude session for
  // the whole DM, like a chat. Everywhere else reply in a thread, one session per thread.
  const threadTs = ev.thread_ts ?? (ev.channel_type === "im" ? null : ev.ts);
  const accept = () => { seen.add(key); return { action: "ask", channel: ev.channel, ts: ev.ts, threadTs, text }; };

  if (ev.type === "app_mention") return accept();
  if (ev.type !== "message") return { action: "drop", why: `type:${ev.type}` };
  // Edits, deletes, joins carry a subtype; a file_share is a normal message with an attachment.
  if (ev.subtype && ev.subtype !== "file_share") return { action: "drop", why: `subtype:${ev.subtype}` };
  if (mentioned) return accept();                          // the app_mention event owns this one
  if (ev.channel_type === "im") return accept();
  if (ev.thread_ts && ev.thread_ts !== ev.ts) {
    if (botThreads.has(`${ev.channel}:${ev.thread_ts}`)) return accept();
    return { action: "check-thread", channel: ev.channel, ts: ev.ts, threadTs: ev.thread_ts, text, key };
  }
  return { action: "drop", why: "channel-message-without-mention" };
}

/** Fold `claude --output-format stream-json` lines into { sessionId, final, lastText, tools }. */
export function foldStream(lines, acc = { sessionId: null, final: "", lastText: "", tools: 0 }) {
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.session_id) acc.sessionId = o.session_id;
    if (o.type === "assistant") {
      for (const c of o.message?.content ?? []) {
        if (c.type === "text" && c.text?.trim()) acc.lastText = c.text.trim();
        if (c.type === "tool_use") acc.tools += 1;
      }
    } else if (o.type === "result" && typeof o.result === "string" && o.result.trim()) {
      acc.final = o.result.trim();
    }
  }
  return acc;
}

/** Build the argv for one claude run. */
export function claudeArgs({ prompt, sessionId, config }) {
  return [
    "-p",
    ...(sessionId ? ["--resume", sessionId] : []),
    ...(config.model ? ["--model", config.model] : []),
    ...(config.claude_args ?? []),
    "--output-format", "stream-json", "--verbose",
    "--append-system-prompt", SYSTEM_PROMPT + (config.system_prompt ? `\n\n${config.system_prompt}` : ""),
    "--", prompt,
  ];
}

// ---------- config, log, sessions ----------

export function loadConfig({ requireOwner = true } = {}) {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`no config at ${CONFIG_FILE}. Run \`node bot.mjs init\` or create it with bot_token, app_token and owner (see SKILL.md).`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  const config = { ...DEFAULTS, ...raw };
  for (const k of ["bot_token", "app_token", ...(requireOwner ? ["owner"] : [])]) {
    if (!config[k]) throw new Error(`config.${k} is missing in ${CONFIG_FILE}`);
  }
  if (!config.bot_token.startsWith("xoxb-")) throw new Error("config.bot_token should start with xoxb-");
  if (!config.app_token.startsWith("xapp-")) throw new Error("config.app_token should start with xapp-");
  if (requireOwner && !/^[UW][A-Z0-9]+$/.test(config.owner)) throw new Error("config.owner should be a Slack member ID like U0123456789");
  config.cwd = config.cwd.replace(/^~(?=$|\/)/, homedir());
  return config;
}

function writeConfig(config) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** The child claude must not think it is nested inside this Claude Code session. */
export function childEnv(env = process.env) {
  const e = { ...env };
  delete e.CLAUDECODE;
  delete e.CLAUDE_CODE_ENTRYPOINT;
  return e;
}

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function log(line) {
  const row = `${stamp()} ${line}`;
  console.log(row);
  try { mkdirSync(HOME, { recursive: true, mode: 0o700 }); appendFileSync(LOG_FILE, row + "\n", { mode: 0o600 }); } catch {}
}

function loadSessions() {
  try { return JSON.parse(readFileSync(SESSIONS_FILE, "utf8")); } catch { return {}; }
}
function saveSessions(map) {
  try { mkdirSync(HOME, { recursive: true, mode: 0o700 }); writeFileSync(SESSIONS_FILE, JSON.stringify(map, null, 1), { mode: 0o600 }); } catch (e) { log(`sessions save failed: ${e.message}`); }
}

// ---------- Slack API ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(config) {
  // Form-encoded works for every Slack Web API method (JSON bodies do not: conversations.replies rejects them).
  return async function api(method, params = {}, token = config.bot_token) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
    let lastErr;
    for (const wait of [0, 1000, 4000, 15000]) {
      if (wait) await sleep(wait);
      try {
        const res = await fetch(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  };
}

// ---------- claude ----------

/** Run claude once; resolves { text, partial, timedOut, sessionId, code, stderr }. Never rejects. */
export function runClaude(args, { cwd, capMs }) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const acc = { sessionId: null, final: "", lastText: "", tools: 0 };
    let buf = "", stderr = "", timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, capMs);
    child.stdout.on("data", (c) => {
      buf += c;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      foldStream(lines, acc);
    });
    child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-2000); });
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ text: "", partial: false, timedOut: false, sessionId: null, code: -1, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      foldStream([buf], acc);
      resolve({ text: acc.final || acc.lastText, partial: !acc.final && !!acc.lastText, timedOut, sessionId: acc.sessionId, code, stderr });
    });
  });
}

// ---------- the bot ----------

async function main() {
  const config = loadConfig();
  const api = makeApi(config);
  const capMs = config.cap_minutes * 60 * 1000;

  const me = await api("auth.test");
  if (!me.ok) { log(`auth.test failed: ${me.error}`); process.exit(1); }
  const botId = me.user_id;
  log(`slack-claude up as @${me.user} (${botId}), owner ${config.owner}, claude cwd ${config.cwd}`);

  const seen = new Set();
  const botThreads = new Set();
  const sessions = loadSessions();
  const chains = new Map();                    // one run at a time per thread, in order
  const react = (channel, ts, name) => api("reactions.add", { channel, timestamp: ts, name }).catch(() => {});

  async function botInThread(channel, threadTs) {
    const r = await api("conversations.replies", { channel, ts: threadTs, limit: 50 }).catch(() => ({ ok: false }));
    const mine = r.ok && (r.messages ?? []).some((m) => m.user === botId);
    if (mine) botThreads.add(`${channel}:${threadTs}`);
    return mine;
  }

  async function answer({ channel, ts, threadTs, text }) {
    react(channel, ts, "eyes");
    if (!text) { react(channel, ts, "question"); return; }
    const key = threadTs ? `${channel}:${threadTs}` : channel;
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      const maxAge = config.session_max_age_days * 86400_000;
      let sid = sessions[key]?.sid && Date.now() - sessions[key].at < maxAge ? sessions[key].sid : null;
      const started = Date.now();
      let r = await runClaude(claudeArgs({ prompt: text, sessionId: sid, config }), { cwd: config.cwd, capMs });
      if (sid && r.code !== 0 && !r.timedOut && !r.text) {
        log(`resume of ${sid} failed (${r.stderr.slice(0, 200)}); retrying fresh`);
        sid = null;
        r = await runClaude(claudeArgs({ prompt: text, sessionId: null, config }), { cwd: config.cwd, capMs });
      }
      if (r.sessionId) { sessions[key] = { sid: r.sessionId, at: Date.now() }; saveSessions(sessions); }
      const secs = Math.round((Date.now() - started) / 1000);
      let reply = r.text;
      if (!reply) {
        reply = r.timedOut
          ? `Hit the ${config.cap_minutes}-minute limit with nothing to show. Try a smaller ask.`
          : `Claude exited with code ${r.code} and no answer.${r.stderr ? `\n\`\`\`\n${r.stderr.slice(-800)}\n\`\`\`` : ""}`;
      } else if (r.timedOut) {
        reply += `\n\n_(stopped at the ${config.cap_minutes}-minute limit; this is the last thing Claude had)_`;
      }
      let ok = true;
      for (const part of chunk(reply)) {
        const posted = await api("chat.postMessage", { channel, text: part, thread_ts: threadTs ?? undefined, mrkdwn: true, unfurl_links: false });
        if (!posted.ok) { ok = false; log(`chat.postMessage failed: ${posted.error}`); break; }
      }
      if (threadTs) botThreads.add(key);
      react(channel, ts, ok && r.text && !r.timedOut ? "white_check_mark" : "x");
      log(`answered ${channel}/${ts} in ${secs}s, ${reply.length} chars, code ${r.code}${r.timedOut ? ", timed out" : ""}${sid ? ", resumed" : ""}`);
    }).catch((e) => { log(`answer failed: ${e.message}`); react(channel, ts, "x"); });
    chains.set(key, run);
  }

  function onEvent(ev) {
    const d = route(ev, { botId, owner: config.owner, seen, botThreads });
    if (d.action === "ask") return answer(d);
    if (d.action === "check-thread") {
      return botInThread(d.channel, d.threadTs).then((mine) => {
        if (!mine) return log(`drop [thread-without-bot] ${d.channel}/${d.ts}`);
        if (seen.has(d.key)) return;
        seen.add(d.key);
        answer(d);
      });
    }
    if (d.why !== "duplicate" && d.why !== "own-message") log(`drop [${d.why}] ${ev?.channel}/${ev?.ts}`);
  }

  // A socket that died while the laptop slept never fires close/error. Detect the
  // sleep as a wall-clock jump and recycle the socket.
  let recycle = null;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - last > 60_000 && recycle) { log(`socket recycle: clock jumped ${Math.round((now - last) / 1000)}s`); recycle(); }
    last = now;
  }, 15_000);

  for (;;) {
    try {
      const open = await api("apps.connections.open", {}, config.app_token);
      if (!open.ok) throw new Error(`apps.connections.open: ${open.error}`);
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(open.url);
        recycle = () => { ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch {} resolve(); };
        ws.onmessage = (msg) => {
          let data; try { data = JSON.parse(msg.data); } catch { return; }
          if (data.envelope_id) ws.send(JSON.stringify({ envelope_id: data.envelope_id })); // ack first, always
          if (data.type === "hello") log("socket connected");
          else if (data.type === "disconnect") { log(`slack asked to reconnect (${data.reason})`); ws.close(); }
          else if (data.type === "events_api") onEvent(data.payload?.event);
        };
        ws.onclose = () => resolve();
        ws.onerror = () => reject(new Error("websocket error"));
      });
    } catch (e) {
      log(`socket loop: ${e.message}`);
    }
    recycle = null;
    await sleep(3000);
  }
}

// ---------- utility commands ----------

async function check() {
  let fail = 0;
  const pass = (m) => console.log(`PASS ${m}`);
  const bad = (m) => { fail += 1; console.log(`FAIL ${m}`); };
  let config;
  try { config = loadConfig(); pass(`config ${CONFIG_FILE}`); } catch (e) { bad(e.message); return 1; }
  const api = makeApi(config);

  const v = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (v.status === 0) pass(`claude ${v.stdout.trim()}`); else bad("claude binary not found on PATH (install Claude Code and run `claude` once to log in)");

  const node = Number(process.versions.node.split(".")[0]);
  if (node >= 22) pass(`node ${process.versions.node}`); else bad(`node ${process.versions.node}: need 22 or newer (built-in WebSocket)`);

  const me = await api("auth.test").catch((e) => ({ ok: false, error: e.message }));
  if (me.ok) pass(`bot token: @${me.user} in ${me.team}`); else bad(`bot token: ${me.error}`);

  const open = await api("apps.connections.open", {}, config.app_token).catch((e) => ({ ok: false, error: e.message }));
  if (open.ok) pass("app token: Socket Mode URL issued"); else bad(`app token: ${open.error} (needs an app-level token with connections:write, and Socket Mode enabled)`);

  const who = await api("users.info", { user: config.owner }).catch((e) => ({ ok: false, error: e.message }));
  if (who.ok) pass(`owner: ${who.user.real_name || who.user.name} (${config.owner})`); else bad(`owner ${config.owner}: ${who.error}`);

  if (me.ok) {
    const res = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${config.bot_token}` } });
    const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim());
    const need = ["app_mentions:read", "channels:history", "groups:history", "im:history", "mpim:history", "im:read", "im:write", "chat:write", "reactions:write", "files:read", "users:read"];
    const missing = need.filter((s) => !scopes.includes(s));
    if (!missing.length) pass("bot scopes (all 11 from manifest.json)"); else bad(`bot scopes missing: ${missing.join(", ")} (add them under OAuth & Permissions, then reinstall the app)`);
  }
  console.log(fail ? `\n${fail} check(s) failed` : "\nall checks passed");
  return fail ? 1 : 0;
}

/** Every human in the workspace, across pages. */
async function listHumans(api) {
  const out = [];
  let cursor;
  do {
    const r = await api("users.list", { limit: 200, cursor });
    if (!r.ok) throw new Error(`users.list failed: ${r.error}`);
    out.push(...r.members.filter((u) => !u.is_bot && !u.deleted && u.id !== "USLACKBOT"));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}
const describeUser = (u) => `${u.id}  ${(u.real_name || u.name).padEnd(28)} ${u.is_primary_owner ? "primary owner" : u.is_admin ? "admin" : ""}`;

async function users() {
  const config = loadConfig({ requireOwner: false });
  for (const u of await listHumans(makeApi(config))) console.log(describeUser(u));
  return 0;
}

/**
 * Interactive setup in the person's own terminal: the tokens go from their clipboard into
 * config.json and nowhere else. Picks the owner from the workspace's humans. Ends with check().
 */
async function init() {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, terminal: false });
  // Queue every line as it arrives. rl.question() loses a line that lands before it is
  // asked for (piped or pasted input), and then waits forever on a closed stdin.
  const lines = [];
  let waiter = null, closed = false;
  rl.on("line", (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else lines.push(l); });
  rl.on("close", () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  const question = (prompt) => {
    process.stdout.write(prompt);
    if (lines.length) { const l = lines.shift(); process.stdout.write(`${l.length > 12 ? l.slice(0, 8) + "..." : l}\n`); return Promise.resolve(l); }
    if (closed) return Promise.resolve(null);
    return new Promise((r) => { waiter = r; });
  };
  const askFor = async (label, prefix) => {
    for (;;) {
      const v = await question(`${label}: `);
      if (v === null) throw new Error("input closed before setup finished");
      if (v.trim().startsWith(prefix)) return v.trim();
      console.log(`  that should start with ${prefix}`);
    }
  };
  try {
    console.log(`slack-claude setup. Config will be written to ${CONFIG_FILE} (mode 600).\n`);
    const existing = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
    const bot_token = await askFor("Bot User OAuth Token (xoxb-...)", "xoxb-");
    const app_token = await askFor("App-Level Token (xapp-...)", "xapp-");
    const api = makeApi({ bot_token, app_token });
    const me = await api("auth.test");
    if (!me.ok) { console.log(`bot token rejected: ${me.error}`); return 1; }
    console.log(`  connected as @${me.user} in ${me.team}`);
    const humans = await listHumans(api);
    let owner;
    if (humans.length === 1) {
      owner = humans[0].id;
      console.log(`  one human in this workspace: ${describeUser(humans[0])}`);
    } else {
      console.log("  humans in this workspace:");
      for (const u of humans) console.log(`    ${describeUser(u)}`);
      do {
        const v = await question("Your member ID (the bot will answer only you): ");
        if (v === null) throw new Error("input closed before setup finished");
        owner = v.trim();
      } while (!humans.some((u) => u.id === owner));
    }
    writeConfig({ ...existing, bot_token, app_token, owner });
    console.log(`\nwrote ${CONFIG_FILE}\n`);
  } finally { rl.close(); }
  return check();
}

async function ask(prompt) {
  const config = loadConfig();
  const r = await runClaude(claudeArgs({ prompt, sessionId: null, config }), { cwd: config.cwd, capMs: config.cap_minutes * 60_000 });
  console.log(r.text || `(no answer; exit ${r.code}${r.stderr ? `; stderr: ${r.stderr.slice(-500)}` : ""})`);
  return r.code === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const exit = (p) => p.then((c) => process.exit(c ?? 0), (e) => { console.error(e.message); process.exit(1); });
  if (!cmd) main().catch((e) => { console.error(`fatal: ${e.message}`); process.exit(1); });
  else if (cmd === "init") exit(init());
  else if (cmd === "check") exit(check());
  else if (cmd === "users") exit(users());
  else if (cmd === "ask") exit(ask(rest.join(" ")));
  else if (cmd === "logs") { try { console.log(readFileSync(LOG_FILE, "utf8").split("\n").slice(-60).join("\n")); } catch { console.log(`no log yet at ${LOG_FILE}`); } }
  else { console.error(`unknown command: ${cmd}`); process.exit(2); }
}
