// ─────────────────────────────────────────────────────────────────────────────
// Parser for an agent container's output.
//
// Three kinds of lines:
//   ::routini::{json}   control lines from the entrypoint (check, commit, pushed,
//                       no_changes, error)
//   {"type": …}         Claude Code --output-format stream-json messages, or
//                       Omnimancer's variant of it (string content, top-level
//                       tool_use / tool_result / error lines)
//   anything else       plain log output
// The parser turns each line into zero or more timeline events and keeps the
// facts the executor needs at the end (cost, check result, pushed branch…).
// ─────────────────────────────────────────────────────────────────────────────

export interface TimelineEvent {
  type: 'log' | 'agent.init' | 'agent.message' | 'agent.tool_call' | 'agent.tool_result' | 'agent.result' | 'cost'
  data: Record<string, unknown>
}

export interface AgentFacts {
  model?: string
  costUsd: number
  turns?: number
  resultText?: string
  resultIsError?: boolean
  check?: { exitCode: number }
  commit?: { sha: string; files: number }
  pushed?: { branch: string }
  noChanges?: boolean
  errors: string[]
  /** Last lines of plain output, for failure messages. */
  tail: string[]
}

const CONTROL_PREFIX = '::routini::'
const PREVIEW = 2000
const TAIL = 20

const clip = (s: string, n = PREVIEW) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('')
  }
  return ''
}

export class AgentStreamParser {
  readonly facts: AgentFacts = { costUsd: 0, errors: [], tail: [] }
  private readonly toolNames = new Map<string, string>()

  line(raw: string, stream: 'stdout' | 'stderr' = 'stdout'): TimelineEvent[] {
    const line = raw.trimEnd()
    if (!line) return []

    if (line.startsWith(CONTROL_PREFIX)) return this.control(line.slice(CONTROL_PREFIX.length))

    if (line.startsWith('{')) {
      let msg: Record<string, unknown> | null = null
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        msg = null
      }
      if (msg && typeof msg['type'] === 'string') return this.claude(msg)
    }

    this.facts.tail.push(line)
    if (this.facts.tail.length > TAIL) this.facts.tail.shift()
    return [{ type: 'log', data: { message: clip(line), ...(stream === 'stderr' ? { stream } : {}) } }]
  }

  private control(json: string): TimelineEvent[] {
    let c: Record<string, unknown>
    try {
      c = JSON.parse(json) as Record<string, unknown>
    } catch {
      return [{ type: 'log', data: { message: `Unreadable control line: ${clip(json, 200)}` } }]
    }
    switch (c['type']) {
      case 'check':
        this.facts.check = { exitCode: Number(c['exitCode']) }
        return [{ type: 'log', data: { message: `Check command exited with ${this.facts.check.exitCode}` } }]
      case 'commit':
        this.facts.commit = { sha: String(c['sha']), files: Number(c['files'] ?? 0) }
        return [{ type: 'log', data: { message: `Committed ${this.facts.commit.sha.slice(0, 10)} (${this.facts.commit.files} files)` } }]
      case 'pushed':
        this.facts.pushed = { branch: String(c['branch']) }
        return [{ type: 'log', data: { message: `Pushed ${this.facts.pushed.branch}` } }]
      case 'no_changes':
        this.facts.noChanges = true
        return [{ type: 'log', data: { message: 'The agent made no changes to the repository' } }]
      case 'error': {
        const m = String(c['message'] ?? 'unknown error')
        this.facts.errors.push(m)
        return [{ type: 'log', data: { message: `Error: ${m}` } }]
      }
      default:
        return []
    }
  }

  private claude(msg: Record<string, unknown>): TimelineEvent[] {
    const type = msg['type']
    if (type === 'system' && msg['subtype'] === 'init') {
      if (typeof msg['model'] === 'string') this.facts.model = msg['model']
      return [{ type: 'agent.init', data: { model: this.facts.model ?? null, tools: Array.isArray(msg['tools']) ? (msg['tools'] as unknown[]).length : null } }]
    }

    if (type === 'assistant' || type === 'user') {
      const message = msg['message'] as { content?: unknown } | undefined
      // Omnimancer: the assistant's text as a plain string.
      if (typeof message?.content === 'string') {
        return message.content.trim() ? [{ type: 'agent.message', data: { text: clip(message.content, 8000) } }] : []
      }
      const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : []
      const out: TimelineEvent[] = []
      for (const block of content) {
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
          out.push({ type: 'agent.message', data: { text: clip(block['text'], 8000) } })
        } else if (block['type'] === 'tool_use') {
          const name = String(block['name'] ?? 'tool')
          if (typeof block['id'] === 'string') this.toolNames.set(block['id'], name)
          out.push({ type: 'agent.tool_call', data: { id: block['id'] ?? null, name, input: clip(JSON.stringify(block['input'] ?? {})) } })
        } else if (block['type'] === 'tool_result') {
          const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : null
          out.push({
            type: 'agent.tool_result',
            data: { id, name: id ? this.toolNames.get(id) ?? null : null, ok: block['is_error'] !== true, output: clip(textOf(block['content'])) },
          })
        }
      }
      return out
    }

    // Omnimancer: one line per tool call and per result, without ids.
    if (type === 'tool_use' || type === 'tool_result') {
      const tool = (msg['tool'] && typeof msg['tool'] === 'object' ? msg['tool'] : {}) as Record<string, unknown>
      const name = String(tool['name'] ?? 'tool')
      if (type === 'tool_use') return [{ type: 'agent.tool_call', data: { id: null, name, input: clip(JSON.stringify(tool['arguments'] ?? {})) } }]
      const error = typeof tool['error'] === 'string' && tool['error'] ? tool['error'] : null
      return [{ type: 'agent.tool_result', data: { id: null, name, ok: !error, output: clip(error ?? textOf(tool['content'])) } }]
    }

    // Omnimancer: a run-ending error (it then exits non-zero).
    if (type === 'error') {
      const message = typeof msg['message'] === 'string' && msg['message'] ? msg['message'] : 'unknown error'
      this.facts.errors.push(message)
      this.facts.resultIsError = true
      this.facts.resultText = message
      return [{ type: 'log', data: { message: `Error: ${clip(message, 500)}` } }]
    }

    if (type === 'result') {
      const cost = Number(msg['total_cost_usd'] ?? msg['cost_usd'] ?? 0)
      if (Number.isFinite(cost)) this.facts.costUsd = cost
      this.facts.turns = typeof msg['num_turns'] === 'number' ? msg['num_turns'] : undefined
      this.facts.resultIsError = msg['is_error'] === true || (typeof msg['subtype'] === 'string' && msg['subtype'] !== 'success')
      this.facts.resultText = typeof msg['result'] === 'string' ? msg['result'] : undefined
      return [
        {
          type: 'agent.result',
          data: {
            ok: !this.facts.resultIsError,
            subtype: msg['subtype'] ?? null,
            turns: this.facts.turns ?? null,
            durationMs: msg['duration_ms'] ?? null,
            summary: this.facts.resultText ? clip(this.facts.resultText, 8000) : null,
          },
        },
        { type: 'cost', data: { usd: this.facts.costUsd } },
      ]
    }
    return []
  }
}
