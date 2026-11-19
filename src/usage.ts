export type Plan = "go" | "go-plus" | "go-teams"

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface ModelCost {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface ModelLike {
  id: string
  providerID: string
  name?: string
  cost?: readonly ModelCost[]
}

export interface ModelRefLike {
  providerID: string
  id: string
  variant?: string
}

export interface SessionLike {
  id: string
  parentID?: string
  model?: ModelRefLike
  cost?: number
  tokens?: Tokens
  time?: { created: number; updated: number }
  title?: string
}

export interface MessageLike {
  type: string
  model?: ModelRefLike
  previous?: ModelRefLike
  tokens?: Tokens
  cost?: number
  time?: { created: number }
}

export type MultiplierFor = (modelID: string | undefined, timestamp: number) => number

const ZERO: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export function tokensOf(session: Pick<SessionLike, "tokens">): Tokens {
  return session.tokens ?? ZERO
}

export function totalTokens(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function cacheShare(tokens: Tokens): number {
  const total = totalTokens(tokens)
  return total > 0 ? (tokens.cache.read / total) * 100 : 0
}

export function priceFor(model: ModelLike | undefined, tokens: Tokens): ModelCost | undefined {
  const costs = model?.cost
  if (!costs || costs.length === 0) return undefined

  let price = costs.find((cost) => !cost.tier) ?? costs[0]
  const context = tokens.input + tokens.cache.read
  for (const cost of costs) {
    if (cost.tier?.type === "context" && context >= cost.tier.size) price = cost
  }
  return price
}

export function costOf(tokens: Tokens, price: ModelCost | undefined): number {
  if (!price) return 0
  return (
    (tokens.input * price.input +
      (tokens.output + tokens.reasoning) * price.output +
      tokens.cache.read * price.cache.read +
      tokens.cache.write * price.cache.write) /
    1_000_000
  )
}

export interface ModelBucket {
  key: string
  model: ModelRefLike
  cost: number
  tokens: number
  first: number
}

export interface SessionBreakdown {
  total: number
  models: ModelBucket[]
  chain: ModelRefLike[]
  timeline: ModelRefLike[]
  switchCount: number
}

export function sessionBreakdown(
  session: SessionLike,
  findModel: (providerID: string, id: string) => ModelLike | undefined,
  messages: readonly MessageLike[] = [],
  multiplierFor: MultiplierFor = () => 1,
): SessionBreakdown {
  const tokens = tokensOf(session)
  const ordered = [...messages].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  const switches = ordered.filter((message) => message.type === "model-switched" && message.model)
  const used = ordered.filter(
    (message) => (message.type === "assistant" || message.type === "compaction") && message.tokens,
  )

  const buckets = new Map<string, ModelBucket>()
  const add = (model: ModelRefLike, cost: number, tokenCount: number, at: number) => {
    const key = `${model.providerID}/${model.id}`
    const bucket = buckets.get(key) ?? { key, model, cost: 0, tokens: 0, first: at }
    bucket.cost += cost
    bucket.tokens += tokenCount
    bucket.first = Math.min(bucket.first, at)
    buckets.set(key, bucket)
  }

  const covered: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const cover = (messageTokens: Tokens) => {
    covered.input += messageTokens.input
    covered.output += messageTokens.output
    covered.reasoning += messageTokens.reasoning
    covered.cache.read += messageTokens.cache.read
    covered.cache.write += messageTokens.cache.write
  }

  for (const message of used) {
    const messageTokens = message.tokens!
    const model = message.model ?? session.model
    if (!model) continue
    const price = priceFor(findModel(model.providerID, model.id), messageTokens)
    const at = message.time?.created ?? session.time?.updated ?? Date.now()
    if (!price) {
      add(model, message.cost ?? 0, totalTokens(messageTokens), at)
      cover(messageTokens)
      continue
    }
    const base = costOf(messageTokens, price)
    add(model, base * multiplierFor(model.id, at), totalTokens(messageTokens), at)
    cover(messageTokens)
  }

  const totalCount = totalTokens(tokens)
  const coveredCount = totalTokens(covered)
  if (coveredCount > 0 && coveredCount < totalCount) {
    const uncovered: Tokens = {
      input: Math.max(0, tokens.input - covered.input),
      output: Math.max(0, tokens.output - covered.output),
      reasoning: Math.max(0, tokens.reasoning - covered.reasoning),
      cache: {
        read: Math.max(0, tokens.cache.read - covered.cache.read),
        write: Math.max(0, tokens.cache.write - covered.cache.write),
      },
    }
    if (totalTokens(uncovered) > 0) {
      const fallback = switches[0]?.previous ?? used.find((message) => message.model)?.model ?? session.model
      if (fallback) {
        const price = priceFor(findModel(fallback.providerID, fallback.id), uncovered)
        const base = price ? costOf(uncovered, price) : 0
        if (base > 0) {
          const at =
            session.time?.created ??
            switches[0]?.time?.created ??
            used[0]?.time?.created ??
            Date.now()
          add(fallback, base * multiplierFor(fallback.id, at), 0, at)
        }
      }
    }
  } else if (coveredCount === 0 && session.model) {
    const price = priceFor(findModel(session.model.providerID, session.model.id), tokens)
    const at = session.time?.updated ?? session.time?.created ?? Date.now()
    const cost = price ? costOf(tokens, price) * multiplierFor(session.model.id, at) : (session.cost ?? 0)
    add(session.model, cost, totalTokens(tokens), session.time?.created ?? at)
  }

  const models = [...buckets.values()].sort((a, b) => a.first - b.first)
  const timeline: ModelRefLike[] = []
  const push = (model: ModelRefLike | undefined) => {
    if (!model) return
    const last = timeline[timeline.length - 1]
    if (last && last.providerID === model.providerID && last.id === model.id) return
    timeline.push(model)
  }
  for (const message of ordered) {
    if (message.type === "model-switched" && message.model) {
      push(message.previous)
      push(message.model)
    } else if ((message.type === "assistant" || message.type === "compaction") && message.model) {
      push(message.model)
    }
  }
  push(session.model)
  return {
    total: models.reduce((sum, model) => sum + model.cost, 0),
    models,
    chain: models.map((model) => model.model),
    timeline,
    switchCount: Math.max(switches.length, timeline.length - 1),
  }
}

export function usd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

export function percent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%"
  if (value < 0.001) return "<0.001%"
  if (value < 0.1) return `${value.toFixed(3)}%`
  if (value < 10) return `${value.toFixed(2)}%`
  return `${value.toFixed(1)}%`
}

export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return `${Math.round(value)}`
}
