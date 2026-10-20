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
| `bot.mjs` | the bot (Node 22+, stdlib only). Commands: `init`, `check`, `users`, `ask "..."`, `logs` |
| `manifest.json` | Slack app manifest with the exact scopes and events |
| `scripts/install-service.sh` | launchd (macOS) / systemd user (Linux) installer |
| `reference/gotchas.md` | Slack behaviours that break naive bots; read when debugging |

Config lives at `~/.slack-claude/config.json` (directory 700, file 600). The two Slack tokens
live in that file and nowhere else: not in the repo, not in the service file, not in any note
you write. The person may paste them to you in the session so you can write the file; that is
the fallback, `node bot.mjs init` in their own terminal is the preferred path.

## Setup

Work through these in order. Each step has a check; do not move on until it passes.

**1. Prerequisites.** `node --version` is 22 or newer. `claude --version` works and
`claude -p "say ok"` answers (if it does not, the person must run `claude` once and log in).
A Slack workspace where they can create apps; a free workspace of their own is the usual choice.

**2. The Slack app (the person does this in a browser, you give them the steps).**
Read `manifest.json` and hand them its content, then:
1. Open https://api.slack.com/apps?new_app=1 → **From a manifest** → pick the workspace → paste the JSON → **Create**.
   The bot is called `claude-local` so it cannot collide with Anthropic's own Claude app for Slack
   if that is installed too. To rename it, change `display_information.name` and `bot_user.display_name` before pasting.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**: any name, add scope `connections:write`, Generate. Copy the token starting `xapp-`. It is shown once.
3. **Install App → Install to Workspace → Allow**. Copy the **Bot User OAuth Token** starting `xoxb-`.
Ask them to paste both tokens to you. Say they can revoke them from the same pages if they ever leak.

**3. Config.** Preferred: the person runs `node <this directory>/bot.mjs init` in a terminal of
their own (give them the full path). It asks for the two tokens, lists the humans in the
workspace, picks the owner (asks when there is more than one), writes the config, and runs the
checks. The tokens never pass through you.

Fallback, if they paste the tokens to you: `mkdir -p ~/.slack-claude && chmod 700 ~/.slack-claude`,
write `~/.slack-claude/config.json` with just the two tokens, `chmod 600` it:
```json
{ "bot_token": "xoxb-...", "app_token": "xapp-..." }
```
Then `node bot.mjs users` lists the humans with IDs (it works without an owner). The owner is
the person you are talking to; if more than one human is listed, ask which is them, never
guess. Add `"owner": "U..."` to the file.

Optional keys and their defaults: `model` (claude's default), `cwd` (home directory; where
claude runs), `cap_minutes` (15), `claude_args` (`["--dangerously-skip-permissions"]`),
`system_prompt` (extra standing instructions).

**4. Check.** `node bot.mjs check` must print `all checks passed`. A FAIL line says what to fix.
`node bot.mjs ask "say ok"` must answer; this runs claude exactly the way the bot will.

**5. Test run.** Start `node bot.mjs` in the background (your shell tool's background mode, or
`node bot.mjs & echo $!`) and keep the PID. Ask the person to DM the bot "hello" from Slack (it
appears under Apps). They should see 👀, then a reply, then ✅; `node bot.mjs logs` shows an
`answered` line. A `drop [not-owner:...]` line means `owner` is wrong. Then kill that PID and
confirm `pgrep -f slack-claude/bot.mjs` prints nothing. A test run left alive next to the
service means every message gets two answers.

**6. Service.** `bash scripts/install-service.sh`. It copies `bot.mjs` to `~/.slack-claude/`
and starts the service (launchd on macOS, systemd user unit on Linux). On Linux also run
`loginctl enable-linger $USER`, or the bot stops when they log out.
`bash scripts/install-service.sh status` shows state and the last log lines. Ask for one more
DM to confirm the service answers.

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
