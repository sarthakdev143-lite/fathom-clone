# Capture Test — 8x Assignment

## 1. Setup

| | |
|---|---|
| **Tool** | opencode v1.18.32 (TUI + `opencode run`) |
| **Model** | `opencode/space-bunny-free` (provider `opencode`) |
| **Planner model** | Same. opencode does not split plan/execute across models here; a single model handles both, and the sub-agent tasks inherit it. |
| **Author** | `sarthakdev143-lite` (read from `git config user.name`) |
| **Project** | `8x-assignment-fantom-clone` |
| **Date** | 2026-09-27 |

opencode **does** have an automatic hook mechanism: a plugin system with typed lifecycle
hooks. It is documented at https://opencode.ai/docs/plugins/ and the hook signatures are
readable in the installed `@opencode-ai/plugin@1.4.7` type definitions. No manual step is
required from me at any point — the plugin fires on its own.

## 2. Mechanism used

**opencode plugin** (the native, automatic hook mechanism).

Files added to the repo:

- `.opencode/plugins/capture.ts` — the plugin. opencode loads every file in
  `.opencode/plugins/` automatically at startup, in any session, in any working copy.
- `.opencode/package.json` — declares `@opencode-ai/plugin` and `@opencode-ai/sdk` so the
  plugin's imports resolve. Both pinned to `1.4.7`, matching what is installed.

### Hooks used

| Hook | Fires | Used for |
|---|---|---|
| `chat.message` | every user prompt, before the model sees it | capture the prompt verbatim |
| `chat.params` | once the turn's model is resolved | write the prompt with its real model name |
| `event` → `message.part.updated` | each text part, as it streams | accumulate the assistant's reply |
| `event` → `message.updated` | assistant message completes | write the final response |
| `event` → `session.idle` | turn ends | safety net for turns that aborted or errored |

Text is accumulated from `text` parts only, so tool calls, file reads, diffs, reasoning and
retries are excluded. That matches the brief: the prompt and the final response, nothing in
between.

## 3. Canary log files

| Canary | Log file |
|---|---|
| CANARY-ONE-OK | `.agent-logs/2026-09-27_12-16-50_ses_f1d3429feffeMnu7KlaZ1EFo9d.md` |
| CANARY-TWO-OK | `.agent-logs/2026-09-27_12-18-30_ses_f1d329b86ffeu1cg52e4Wq0sYz.md` |
| CANARY-TOOLS-OK | `.agent-logs/2026-09-27_12-24-09_ses_f1d2d6fa1ffeo0t7f836v1pEub.md` |

Each is a **separate opencode process**, i.e. a separate session, proving the plugin is
installed at the project level and not tied to the session that created it.

## 4. Canary entries, pasted raw

### CANARY-TWO-OK — clean pass

```
---
session_id: ses_f1d329b86ffeu1cg52e4Wq0sYz
date: 2026-09-27
author: sarthakdev143-lite
model: opencode/space-bunny-free
tool: opencode
project: 8x-assignment-fantom-clone
total_exchanges: 1
first_prompt_time: 2026-09-27T12:18:30.379Z
last_prompt_time: 2026-09-27T12:18:30.379Z
---

# Session Log - 2026-09-27

Session: `ses_f1d3` | Project: 8x-assignment-fantom-clone | Author: sarthakdev143-lite

---

[LOG_ENTRY type=PROMPT num=1 session=ses_f1d329b86ffeu1cg52e4Wq0sYz]
timestamp: 2026-09-27T12:18:30.379Z
model: opencode/space-bunny-free

"CAPTURE TEST - 8x assignment, sarthakdev143-lite. Reply with exactly: CANARY-TWO-OK"


[LOG_ENTRY type=RESPONSE num=1 session=ses_f1d329b86ffeu1cg52e4Wq0sYz]
timestamp: 2026-09-27T12:18:42.608Z
model: opencode/space-bunny-free

CANARY-TWO-OK

```

### CANARY-TOOLS-OK — turn that used a tool

```
[LOG_ENTRY type=PROMPT num=1 session=ses_f1d2d6fa1ffeo0t7f836v1pEub]
timestamp: 2026-09-27T12:24:09.159Z
model: opencode/space-bunny-free

"CAPTURE TEST - 8x assignment, sarthakdev143-lite. Use the bash tool to run 'echo hi', then reply with exactly: CANARY-TOOLS-OK"


[LOG_ENTRY type=RESPONSE num=1 session=ses_f1d2d6fa1ffeo0t7f836v1pEub]
timestamp: 2026-09-27T12:24:23.689Z
model: opencode/space-bunny-free

CANARY-TOOLS-OK

```

The prompt asked for a `bash` call, the agent made one, and the response still captured
cleanly with no tool output leaking in.

### CANARY-ONE-OK — the failing first attempt, left in as-is

Kept deliberately, per the instruction not to tidy logs. It is the honest record of the
first working version of the plugin, before two bugs were found and fixed:

```
---
session_id: ses_f1d3429feffeMnu7KlaZ1EFo9d
date: 2026-09-27
author: sarthakdev143-lite
model: unknown
tool: opencode
project: 8x-assignment-fantom-clone
total_exchanges: 1
first_prompt_time: 2026-09-27T12:16:50.010Z
last_prompt_time: 2026-09-27T12:16:50.010Z
---

# Session Log - 2026-09-27

Session: `ses_f1d3` | Project: 8x-assignment-fantom-clone | Author: sarthakdev143-lite

---

[LOG_ENTRY type=PROMPT num=1 session=ses_f1d3429feffeMnu7KlaZ1EFo9d]
timestamp: 2026-09-27T12:16:50.010Z
model: unknown

"CAPTURE TEST - 8x assignment, sarthakdev143-lite. Reply with exactly: CANARY-ONE-OK"


[LOG_ENTRY type=RESPONSE num=1 session=ses_f1d3429feffeMnu7KlaZ1EFo9d]
timestamp: 2026-09-27T12:17:04.928Z
model: opencode/space-bunny-free

CANARY-ONE-OK


[LOG_ENTRY type=RESPONSE num=2 session=ses_f1d3429feffeMnu7KlaZ1EFo9d]
timestamp: 2026-09-27T12:17:04.999Z
model: unknown

"CAPTURE TEST - 8x assignment, sarthakdev143-lite. Reply with exactly: CANARY-ONE-OK"

```

Two defects are visible here, both caught by running the canary rather than assuming:

1. **A phantom third entry.** `RESPONSE num=2` is the user's own prompt, written a second
   time as if it were an answer. Cause: the text accumulator was fed by *every*
   `message.part.updated`, which includes the parts of the **user's** message. The idle
   safety net then flushed that buffer as a response.
2. **`model: unknown` on the prompt.** `chat.message` runs before the turn's model is
   resolved, so `input.model` was undefined there.

Both are fixed: user message IDs are now tracked and excluded from the response buffer, and
the prompt is staged in `chat.message` then written from `chat.params`, which carries the
resolved model. CANARY-TWO-OK and CANARY-TOOLS-OK are the post-fix evidence.

## 5. What I tried first that did not work

### 5a. `.github/hooks/capture.json` + `capture.ps1` (removed)

The repo already contained a committed PowerShell capture script wired through
`.github/hooks/capture.json` for `UserPromptSubmit` and `Stop` events.

**This does not work.** GitHub Copilot in VS Code has no such hook file; `.github/hooks/`
is not a configuration surface Copilot reads, and nothing in GitHub loads a
`capture.json` from there. The script was elaborate and plausible, and would have looked
convincing in the repo, but it would never have fired. It also depended on
`$APPDATA\Code\User\workspaceStorage` to recover the model name, and the one log it left
behind shows the giveaway:

```
model: not exposed by hook or VS Code session state
```

...and that file contains a `PROMPT` entry with **no matching `RESPONSE`**. Dead code that
looks like working infrastructure is worse than nothing, so I deleted it rather than
leaving it in the submission.

### 5b. Global plugin at `~/.config/opencode/plugins/capture.ts` (moved to project)

My first working version of the opencode plugin was installed **globally**, outside the
repo. Two problems:

- It does not ship with the repo, so a reviewer cloning this project would find no capture
  mechanism at all.
- It only started working *mid-session*. opencode loads plugins once at startup, so the
  plugin written during a live session is not picked up until the next one. That is also
  why the first several turns of this very session were never captured.

Both are fixed by moving it to `.opencode/plugins/` in the repo, where it loads at startup
in every session.

### 5c. A real bug carried over from that first version

The original global plugin captured responses with:

```ts
if (!found || found.parts.some((part) => part.type === "tool")) return
```

It refused to log **any** response that contained a tool call. Since almost every real turn
in an agentic coding session uses tools, this would have silently discarded nearly the whole
log while appearing to work. Replacing the fetch-and-filter approach with live accumulation
from `message.part.updated` removes the problem entirely — tool parts are simply not text
parts, so they are never accumulated in the first place. CANARY-TOOLS-OK tests this
specific case.

## 6. Confirmations

- [x] Prompt captured verbatim, untruncated
- [x] Final response captured in full
- [x] UTC timestamps present
- [x] Model name recorded per entry
- [x] Tool calls / intermediate steps excluded
- [x] Two independent sessions both captured (three, counting the tool test)
- [x] `.agent-logs/` is **not** in `.gitignore`
- [x] Log format matches the required format
- [x] Existing entries left unedited, including the broken first attempt
