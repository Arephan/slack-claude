# Slack + headless Claude: the behaviours that bite

Each of these broke a real bot. `bot.mjs` handles all of them; this file explains why the
code looks the way it does, so a change does not reintroduce one.

## Slack

**One mention, two events.** An @mention in a channel arrives as BOTH an `app_mention` event
and a `message` event, in either order. Dedup on `channel:ts`, never on event type. Without
this the bot answers every mention twice.

**Socket Mode does not replay.** Events that arrive while the socket is down are gone. There
is no queue to drain on reconnect. A message sent during a 10-second reconnect gap gets no 👀
and no answer. The 👀 reaction is the receipt: no 👀 means the bot never saw it.

**A socket can die without telling you.** After the laptop sleeps, or the Wi-Fi changes, the
WebSocket often stays "open" from the process's point of view, with no close and no error,
while nothing arrives. launchd shows a healthy PID. The bot detects this as a wall-clock jump
(every 15 s it checks whether more than 60 s passed) and recycles the socket. If you remove
that, the bot will one day be deaf for hours while looking fine.

**Ack every envelope first.** Slack expects the `envelope_id` echoed back promptly. Do that
before any other work, or Slack retries the event and you get duplicates.

**Subtypes.** `message_changed`, `message_deleted`, `channel_join` and friends are `message`
events with a `subtype`. Drop them. The one exception is `file_share`: that is a normal message
that happens to carry a file, and dropping it means a screenshot plus a question vanish silently.

**Text is HTML-escaped and links are wrapped.** `&` arrives as `&amp;`, `<` as `&lt;`, and a
URL as `<https://x|label>`. Unescape before handing the text to claude or it will see entities.

**`conversations.replies` rejects a JSON body.** Most Slack methods accept JSON; this one
wants query or form parameters. The bot uses form-encoding for every call, so there is one
code path and no surprise.

**Reactions need `reactions:write`.** Reading reactions needs `reactions:read`, which the
manifest does not request; use `conversations.history` if you ever need to see them.

**Message size.** `chat.postMessage` caps text around 40k characters and gets hard to read
past 4k on a phone. The bot splits on newlines at 3800.

**DMs vs threads.** In a DM, replying inline and keeping one Claude session for the whole DM
matches how people chat on a phone. In a channel, replying in a thread under the message keeps
the channel clean and gives each thread its own session. Mixing these up looks like "the bot
forgot what I said".

## Headless Claude Code

**Background work dies with the run.** `claude -p` is a child of the bot; anything claude starts
in the background (a `&` command, a background subagent, a watcher) is a grandchild and dies
the moment the reply prints. Claude will cheerfully report "running in the background" about a
process that is already dead. The system prompt forbids that promise. If you need long-running
work, spawn it detached from the bot process, not from inside claude.

**Use `stream-json`, not `json`.** With `--output-format json` a run killed at the time cap
loses everything. With `stream-json --verbose` every assistant turn is captured as it happens,
so a capped run still posts the last thing claude said, with a note that it was cut off.

**`--resume` can fail.** Sessions older than a few days, or sessions from a project directory
that moved, may not resume. The bot retries once without `--resume` and starts a fresh session.

**The service PATH is nearly empty.** launchd and systemd do not read your shell profile. The
service file carries the directories `node` and `claude` live in, plus Homebrew's. If claude
starts failing only under the service, this is why.

**The service runs as you, with your login.** `claude -p` under launchd uses the same
credentials as your terminal, because it is the same user in the same login session. On Linux,
`loginctl enable-linger` keeps the user service alive after logout.

**Prompt after `--`.** A message that starts with `-` would otherwise be parsed as a flag.

## Operations

**Two processes, two answers.** A foreground `node bot.mjs` left running next to the service
means every message gets answered twice. `pkill -f slack-claude/bot.mjs` then restart the service.

**Copy, don't symlink, the bot into the service.** Plugin cache paths change on update. The
installer copies `bot.mjs` to `~/.slack-claude/`; rerun it after updating.

**Logs.** `~/.slack-claude/bot.log` has one line per event the bot acted on or dropped (with
the reason), `socket connected`, `socket recycle: ...`, and one line per answer with duration
and exit code. Anything printed before the log file existed, such as a fatal config error at
start, goes to `~/.slack-claude/service.log` on macOS and to `journalctl --user -u slack-claude`
on Linux.

**Started from inside a Claude Code session?** The bot strips `CLAUDECODE` and
`CLAUDE_CODE_ENTRYPOINT` from the child environment so the spawned `claude -p` does not think
it is nested. If you start a foreground test run from inside Claude Code, kill it by PID before
installing the service, or you get two bots and two answers.
