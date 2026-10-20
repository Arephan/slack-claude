# slack-claude

Talk to the Claude Code on your laptop from your phone, through Slack.

You DM a bot in your own Slack workspace. The bot runs your message through `claude -p` on your machine (same login, same files, same git repos you'd have at the keyboard) and posts the answer back in the thread. Replies in that thread continue the same Claude session, so "now do the same for the other file" works.

This repo is a Claude Code skill. Install it, then tell Claude "set up slack-claude". It walks you through the Slack admin part, which is about five minutes of clicking and pasting, and does everything on the laptop side itself.

```
phone  ──Slack──▶  Slack cloud  ──WebSocket──▶  bot.mjs on your laptop  ──▶  claude -p
                                                     ▲                           │
                                                     └─────── answer ◀───────────┘
```

There is no public URL involved. The bot opens an outbound WebSocket (Slack calls this Socket Mode) and Slack pushes your messages down it, which also means no ngrok and nothing listening on a port.

## Install

As a plugin:

```
claude plugin marketplace add Arephan/slack-claude
claude plugin install slack-claude@slack-claude
```

If you'd rather skip the plugin system, clone it and symlink the skill folder:

```
git clone https://github.com/Arephan/slack-claude ~/slack-claude
ln -s ~/slack-claude/plugins/slack-claude/skills/slack-claude ~/.claude/skills/slack-claude
```

Then open Claude Code and say "set up slack-claude".

## What you end up with

`~/.slack-claude/config.json` holds your two Slack tokens and your Slack member ID (mode 600). Next to it, `bot.mjs` runs as a launchd agent on macOS or a systemd user service on Linux. It restarts itself if it dies, and it reconnects on its own after the laptop sleeps, which turned out to be the hard part. A socket that died during sleep doesn't close or error; it just sits there looking healthy while nothing arrives. The bot watches for the clock jump instead.

In Slack you get a bot that answers in DMs, when @mentioned in a channel, and in any thread it has already answered in. It reacts 👀 the moment a message lands, then ✅ once the answer is posted. ❌ means Claude failed and the thread will say why. ❓ means the message was empty after stripping the mention.

## Security

By default the bot runs Claude with `--dangerously-skip-permissions`. A bot you can't approve prompts for isn't worth much, and it is your own machine. So the whole security model is one comparison: the Slack user ID on the incoming message has to equal `owner` in your config. Anything else gets dropped before Claude is even spawned, and the drop goes in the log.

That holds up fine if you don't undermine it. Keep one owner; a second person should get their own bot on their own laptop. Think twice before putting the bot in a workspace you don't control, since workspace admins can read DMs under some plans. And treat the two tokens in `config.json` as the keys to the machine, because that's what they are.

If you'd rather Claude ask before editing files, set `"claude_args": ["--permission-mode", "acceptEdits"]` in the config. It'll stop on anything it isn't allowed to do and you'll see that in the thread, and then you'll have to walk to the laptop, which is the thing you were trying to avoid.

## Requirements

Node 22 or newer (the bot uses the built-in `WebSocket`, there are no npm packages to install). Claude Code installed and logged in on the machine that will run the bot. A Slack workspace where you're allowed to create apps; a free workspace of your own is the usual answer.

## Files

```
plugins/slack-claude/skills/slack-claude/
  SKILL.md                     what Claude follows when you say "set up slack-claude"
  bot.mjs                      the bot, around 300 lines, stdlib only
  manifest.json                Slack app manifest, so you paste once instead of clicking through scopes
  scripts/install-service.sh   launchd / systemd installer
  reference/gotchas.md         Slack behaviours that cost me an afternoon each
test/bot.test.mjs              node --test test/bot.test.mjs
```

## Isn't there an official Claude app for Slack?

Yes, and it talks to Claude in Anthropic's cloud. This talks to the Claude Code on your computer, with access to whatever your computer has access to. If you just want to chat with Claude from Slack, use the official one.

## Where this came from

I've been running a version of this since August 2026 as a remote control for my laptop. Most of what's in `gotchas.md` was learned by having the bot go silent on me at an inconvenient moment, then reading Slack's docs more carefully than the first time.

MIT licence.
