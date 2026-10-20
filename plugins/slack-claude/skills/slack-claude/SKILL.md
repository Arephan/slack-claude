---
name: slack-claude
description: Use when someone wants to talk to Claude Code on their own machine from Slack or from their phone, asks to "set up slack-claude", wants a Slack bot that runs Claude Code, or has an existing slack-claude bot that is silent, not reconnecting, or answering twice.
---

# slack-claude

Stand up a Slack bot that runs the owner's messages through `claude -p` on this machine and
answers in Slack. The bot, the Slack app manifest, and the service installer are in this
directory and are tested. Use them as they are; do not write a new bot or add npm packages.

Files, relative to this SKILL.md:

| File | What it is |
|------|------------|
| `bot.mjs` | the bot (Node 22+, stdlib only). Commands: `check`, `users`, `ask "..."`, `logs` |
| `manifest.json` | Slack app manifest with the exact scopes and events |
| `scripts/install-service.sh` | launchd (macOS) / systemd user (Linux) installer |
| `reference/gotchas.md` | Slack behaviours that break naive bots; read when debugging |

Config lives at `~/.slack-claude/config.json`. Tokens never go in the repo, in chat, or in the service file.

## Setup

Work through these in order. Each step has a check; do not move on until it passes.

**1. Prerequisites.** `node --version` is 22 or newer. `claude --version` works and
`claude -p "say ok"` answers (if it does not, the person must run `claude` once and log in).
A Slack workspace where they can create apps; a free workspace of their own is the usual choice.

**2. The Slack app (the person does this in a browser, you give them the steps).**
Read `manifest.json` and hand them its content, then:
1. Open https://api.slack.com/apps?new_app=1 → **From a manifest** → pick the workspace → paste the JSON → **Create**.
   If they want a different bot name, change `display_information.name` and `bot_user.display_name` before pasting.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**: any name, add scope `connections:write`, Generate. Copy the token starting `xapp-`. It is shown once.
3. **Install App → Install to Workspace → Allow**. Copy the **Bot User OAuth Token** starting `xoxb-`.
Ask them to paste both tokens to you. Say they can revoke them from the same pages if they ever leak.

**3. Config.** Write `~/.slack-claude/config.json` (mkdir first, then `chmod 600` the file):
```json
{ "bot_token": "xoxb-...", "app_token": "xapp-...", "owner": "" }
```
Then `node bot.mjs users` lists the humans in the workspace with IDs. The owner is the person
you are talking to; if more than one human is listed, ask which is them, never guess. Put that
`U...` ID in `owner`. Optional keys and their defaults: `model` (claude's default), `cwd` (home
directory; where claude runs), `cap_minutes` (15), `claude_args`
(`["--dangerously-skip-permissions"]`), `system_prompt` (extra standing instructions).

**4. Check.** `node bot.mjs check` must print `all checks passed`. A FAIL line says what to fix.
`node bot.mjs ask "say ok"` must answer; this runs claude exactly the way the bot will.

**5. Foreground run.** `node bot.mjs` in the foreground. Ask the person to DM the bot "hello"
from Slack (the bot appears under Apps). They should see 👀, then a reply, then ✅. Watch the
log for `drop [not-owner:...]`: that means `owner` is wrong. Stop it with Ctrl-C.

**6. Service.** `bash scripts/install-service.sh`. It copies `bot.mjs` to `~/.slack-claude/`
and starts the service. `bash scripts/install-service.sh status` shows state and the last log
lines. Ask for one more DM to confirm the service answers.

**7. Hand-off.** Tell them: DM the bot for a chat (one Claude session per DM, so follow-ups
remember), @mention it in a channel it has been invited to (reply comes in a thread, one session
per thread), reply in that thread to continue. Logs: `node ~/.slack-claude/bot.mjs logs`.
Update after a plugin update: run the installer again.

## Security

The bot runs claude with `--dangerously-skip-permissions` by default. The whole security model
is `owner`: a message from any other user ID is dropped before claude is spawned, and logged.
Say this plainly to the person. One owner per bot. If they want claude to ask before acting, set
`"claude_args": ["--permission-mode", "acceptEdits"]`; the bot then reports the stop instead of
walking past it, and they lose the point of a phone bot. Never put the bot in a workspace the
person does not control.

## When it misbehaves

| Symptom | Cause | Fix |
|---------|-------|-----|
| No 👀 at all | service down, wrong owner, or socket dead | `install-service.sh status`; look for `drop [not-owner`; see gotchas |
| 👀 but nothing after | claude failed or hit the cap | the thread shows the exit code and stderr; `node bot.mjs ask "..."` reproduces |
| Answers twice | two bot processes | `pkill -f slack-claude/bot.mjs`, then `install-service.sh restart` |
| Deaf after laptop sleep | socket died silently | bot recycles on clock jump; if not, check `bot.log` for `socket recycle` |
| Follow-up forgot context | DM vs thread, or session older than 7 days | explained in gotchas |
| `missing_scope` | app installed before manifest scopes | re-install the app from OAuth & Permissions |

Read `reference/gotchas.md` before changing bot.mjs. Every entry there is a bug that already happened.
