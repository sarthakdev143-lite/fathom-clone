import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Part, TextPart } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"

const LOG_DIR = ".agent-logs"
const TOOL = "opencode"
const UNKNOWN_MODEL = "unknown"

type Kind = "PROMPT" | "RESPONSE"
type ModelRef = { providerID?: string; modelID?: string } | undefined

function modelLabel(model: ModelRef): string {
  const provider = model?.providerID
  const id = model?.modelID
  if (!provider && !id) return UNKNOWN_MODEL
  if (!provider) return String(id)
  if (!id) return String(provider)
  return `${provider}/${id}`
}

function isText(part: Part): part is TextPart {
  return part.type === "text"
}

/** Synthetic/ignored parts are machine-injected, not something the human or model actually wrote. */
function isRealText(part: TextPart): boolean {
  return !part.synthetic && !part.ignored && part.text.trim().length > 0
}

function joinText(parts: Part[]): string {
  return parts
    .filter(isText)
    .filter(isRealText)
    .map((part) => part.text)
    .join("")
    .trim()
}

function fileStamp(timestamp: string): string {
  return timestamp.slice(0, 19).replace("T", "_").replace(/:/g, "-")
}

function day(timestamp: string): string {
  return timestamp.slice(0, 10)
}

export const CapturePlugin: Plugin = async ({ client, $, directory }) => {
  const logRoot = join(directory, LOG_DIR)
  const project = directory.split(/[\\/]/).filter(Boolean).pop() ?? "unknown"

  const paths = new Map<string, string>()
  /** assistant messageID -> ordered partID -> text, accumulated live from message.part.updated */
  const pending = new Map<string, Map<string, string>>()
  const flushed = new Set<string>()
  const totals = new Map<string, number>()
  /** message ids we already logged as PROMPT, so they can never be logged as RESPONSE */
  const promptIDs = new Set<string>()
  /** prompts awaiting a resolved model name from chat.params */
  const staged = new Map<string, { sessionID: string; timestamp: string; text: string }>()
  /** assistant messageID -> model label, learned from message.updated even if the turn never completes */
  const models = new Map<string, string>()

  let tail: Promise<unknown> = Promise.resolve()
  let author: string | undefined

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task)
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }

  async function resolveAuthor(): Promise<string> {
    if (author !== undefined) return author
    try {
      author = (await $`git -C ${directory} config user.name`.text()).trim() || "unknown"
    } catch {
      author = "unknown"
    }
    return author
  }

  async function createLog(sessionID: string, timestamp: string, model: string): Promise<string> {
    await mkdir(logRoot, { recursive: true })
    const who = await resolveAuthor()
    const date = day(timestamp)
    const path = join(logRoot, `${fileStamp(timestamp)}_${sessionID}.md`)
    const header = [
      "---",
      `session_id: ${sessionID}`,
      `date: ${date}`,
      `author: ${who}`,
      `model: ${model}`,
      `tool: ${TOOL}`,
      `project: ${project}`,
      "total_exchanges: 0",
      `first_prompt_time: ${timestamp}`,
      `last_prompt_time: ${timestamp}`,
      "---",
      "",
      `# Session Log - ${date}`,
      "",
      `Session: \`${sessionID.slice(0, 8)}\` | Project: ${project} | Author: ${who}`,
      "",
      "---",
      "",
      "",
    ].join("\n")
    await writeFile(path, header, "utf8")
    paths.set(sessionID, path)
    totals.set(sessionID, 0)
    return path
  }

  async function findLog(sessionID: string): Promise<string | undefined> {
    const cached = paths.get(sessionID)
    if (cached) return cached
    let entries: string[]
    try {
      entries = await readdir(logRoot)
    } catch {
      return undefined
    }
    const match = entries.filter((name) => name.endsWith(`_${sessionID}.md`)).sort().pop()
    if (!match) return undefined
    const path = join(logRoot, match)
    paths.set(sessionID, path)
    return path
  }

  function nextNumber(body: string, kind: Kind): number {
    return (body.match(new RegExp(`\\[LOG_ENTRY type=${kind}`, "g")) ?? []).length + 1
  }

  function entry(kind: Kind, n: number, sessionID: string, timestamp: string, model: string, text: string): string {
    return `[LOG_ENTRY type=${kind} num=${n} session=${sessionID}]\ntimestamp: ${timestamp}\nmodel: ${model}\n\n${text}\n\n`
  }

  async function recordPrompt(sessionID: string, timestamp: string, model: string, prompt: string) {
    const path = (await findLog(sessionID)) ?? (await createLog(sessionID, timestamp, model))
    const body = await readFile(path, "utf8")
    const n = nextNumber(body, "PROMPT")
    const separator = body.endsWith("\n\n") || body.endsWith("\n") ? "" : "\n"
    await appendFile(path, `${separator}${entry("PROMPT", n, sessionID, timestamp, model, prompt)}\n`, "utf8")

    const current = await readFile(path, "utf8")
    const updated = current
      .replace(/^total_exchanges: .*$/m, `total_exchanges: ${n}`)
      .replace(/^last_prompt_time: .*$/m, `last_prompt_time: ${timestamp}`)
    await writeFile(path, updated, "utf8")
    totals.set(sessionID, n)
  }

  async function recordResponse(
    sessionID: string,
    timestamp: string,
    model: string,
    response: string,
  ): Promise<void> {
    const path = (await findLog(sessionID)) ?? (await createLog(sessionID, timestamp, model))
    const body = await readFile(path, "utf8")
    const n = nextNumber(body, "RESPONSE")
    const separator = body.endsWith("\n\n") || body.endsWith("\n") ? "" : "\n"
    await appendFile(path, `${separator}${entry("RESPONSE", n, sessionID, timestamp, model, response)}\n`, "utf8")
  }

  async function flush(messageID: string, sessionID: string, timestamp: string, model: string): Promise<boolean> {
    if (flushed.has(messageID)) return false
    const parts = pending.get(messageID)
    pending.delete(messageID)
    if (!parts || parts.size === 0) return false
    const text = [...parts.values()].join("").trim()
    if (!text) return false
    flushed.add(messageID)
    await recordResponse(sessionID, timestamp, model, text)
    return true
  }

  /** Drains the idle net. Only assistant buffers are eligible; prompts were never put in `pending`. */
  async function harvestIdle(sessionID: string): Promise<void> {
    for (const [messageID, parts] of [...pending]) {
      if (parts.size === 0) continue
      const text = [...parts.values()].join("").trim()
      if (!text) continue
      const model = models.get(messageID) ?? UNKNOWN_MODEL
      await flush(messageID, sessionID, new Date().toISOString(), model)
    }
  }

  async function drainStaged(): Promise<void> {
    for (const [messageID, item] of [...staged]) {
      staged.delete(messageID)
      if (flushed.has(messageID)) continue
      await recordPrompt(item.sessionID, item.timestamp, models.get(messageID) ?? UNKNOWN_MODEL, item.text)
    }
  }

  async function report(message: string, extra: Record<string, string>) {
    await client.app
      .log({ body: { service: "agent-capture", level: "error", message, extra } })
      .catch(() => {})
  }

  return {
    /**
     * Fires on every user prompt. The model is not resolved yet at this point, so the
     * prompt is staged and written by chat.params, which carries the real model.
     */
    "chat.message": async (input, output) => {
      try {
        const prompt = joinText(output.parts)
        if (!prompt) return
        const messageID = output.message.id
        promptIDs.add(messageID)
        staged.set(messageID, {
          sessionID: input.sessionID,
          timestamp: new Date(output.message.time.created).toISOString(),
          text: prompt,
        })
      } catch (error) {
        await report("failed to stage prompt", { sessionID: input.sessionID, error: String(error) })
      }
    },

    /** Fires once the model for this turn is known. */
    "chat.params": async (input) => {
      try {
        const messageID = input.message.id
        if (!staged.has(messageID)) return
        const model = modelLabel({ providerID: input.model.providerID, modelID: input.model.id })
        models.set(messageID, model)
        await serialize(() => drainStaged())
      } catch (error) {
        await report("failed to log prompt", { sessionID: input.sessionID, error: String(error) })
      }
    },

    event: async ({ event }) => {
      try {
        if (event.type === "message.part.updated") {
          const part = event.properties.part
          if (!isText(part) || !isRealText(part)) return
          // A prompt is not a response. Never buffer the user's own text.
          if (promptIDs.has(part.messageID)) return
          let bucket = pending.get(part.messageID)
          if (!bucket) {
            bucket = new Map<string, string>()
            pending.set(part.messageID, bucket)
          }
          // Keyed by partID so a re-sent delta replaces rather than duplicates.
          bucket.set(part.id, part.text)
          return
        }

        if (event.type === "message.updated") {
          const info = event.properties.info
          if (info.role !== "assistant") return
          const model = modelLabel({ providerID: info.providerID, modelID: info.modelID })
          models.set(info.id, model)
          if (!info.time.completed) return
          const timestamp = new Date(info.time.completed).toISOString()
          await serialize(() => flush(info.id, info.sessionID, timestamp, model))
          return
        }

        // Safety net: a turn that was aborted or errored never reports time.completed,
        // but its text is still a real answer. Harvest it when the session goes idle.
        if (event.type === "session.idle") {
          const sessionID = event.properties.sessionID
          await serialize(async () => {
            await drainStaged()
            await harvestIdle(sessionID)
          })
        }
      } catch (error) {
        await report("failed to log response", { event: event.type, error: String(error) })
      }
    },
  }
}

export default CapturePlugin
