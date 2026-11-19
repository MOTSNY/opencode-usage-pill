import { createSignal, type Accessor } from "solid-js"
import type { Plan } from "./usage"

interface When {
  utc_days?: { in?: string[] }
  utc_hours?: { gte?: string; lt?: string }
  any?: When[]
  all?: When[]
}

interface Multiplier {
  when?: When
  factor: number
}

interface CatalogModel {
  id: string
  name?: string
  monthly?: Partial<Record<Plan, number>>
  multipliers?: Multiplier[]
}

const FALLBACK: Record<string, Partial<Record<Plan, number>>> = {
  "deepseek-v4.1-flash": { go: 100, "go-plus": 200, "go-teams": 105 },
  "deepseek-v4-pro": { go: 15, "go-plus": 60, "go-teams": 20 },
  "glm-5.3": { go: 500, "go-plus": 1000, "go-teams": 505 },
  "glm-5.3-flash": { go: 60, "go-plus": 180, "go-teams": 65 },
  "glm-5.2": { go: 60, "go-plus": 180, "go-teams": 65 },
  "kimi-k3.1-pro": { go: 15, "go-plus": 60, "go-teams": 20 },
  "kimi-k3": { go: 15, "go-plus": 60, "go-teams": 20 },
  "kimi-k2.7-code": { go: 60, "go-plus": 180, "go-teams": 65 },
  "qwen3.8-max": { go: 15, "go-plus": 60, "go-teams": 20 },
  "qwen4-max": { go: 15, "go-plus": 60, "go-teams": 20 },
  "qwen3.8-flash": { go: 30, "go-plus": 90, "go-teams": 35 },
  "qwen3.7-plus": { go: 60, "go-plus": 180, "go-teams": 65 },
  "minimax-m3.1-flash": { go: 20, "go-plus": 80, "go-teams": 25 },
  "minimax-m3": { go: 60, "go-plus": 180, "go-teams": 65 },
  "gemini-4-argon": { go: 30, "go-plus": 120, "go-teams": 35 },
  "gpt-6-luna": { go: 15, "go-plus": 60, "go-teams": 20 },
  "gpt-5.6-luna": { go: 15, "go-plus": 60, "go-teams": 20 },
  "claude-haiku-5-5": { go: 15, "go-plus": 60, "go-teams": 20 },
  "grok-4.7": { go: 15, "go-plus": 60, "go-teams": 20 },
  "step-5-preview": { go: 15, "go-plus": 60, "go-teams": 20 },
  "hy4-preview": { go: 30, "go-plus": 120, "go-teams": 35 },
  "hy4": { go: 60, "go-plus": 240, "go-teams": 65 },
  "hy3": { go: 60, "go-plus": 240, "go-teams": 65 },
  "mimo-v2.6-pro": { go: 15, "go-plus": 60, "go-teams": 20 },
  "mimo-v2.6-flash": { go: 60, "go-plus": 120, "go-teams": 65 },
  "muse-spark-1.3-contributor": { go: 60, "go-plus": 120, "go-teams": 65 },
  "muse-spark-1.2-contributor": { go: 60, "go-plus": 120, "go-teams": 65 },
  "longcat-2.0": { go: 60, "go-plus": 240, "go-teams": 65 },
}

const FALLBACK_MULTIPLIERS: Record<string, Multiplier[]> = {
  "deepseek-v4.1-flash": [
    {
      when: {
        utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] },
        any: [
          { all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] },
          { all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] },
        ],
      },
      factor: 2,
    },
  ],
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

let signal: Accessor<Map<string, CatalogModel>> | undefined

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number)
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0)
}

function matches(when: When | undefined, date: Date): boolean {
  if (!when) return true

  if (when.utc_days?.in && !when.utc_days.in.includes(DAYS[date.getUTCDay()])) return false

  if (when.utc_hours) {
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
    if (when.utc_hours.gte && minutes < toMinutes(when.utc_hours.gte)) return false
    if (when.utc_hours.lt && minutes >= toMinutes(when.utc_hours.lt)) return false
  }

  if (when.any && when.any.length > 0 && !when.any.some((item) => matches(item, date))) return false
  if (when.all && when.all.length > 0 && !when.all.every((item) => matches(item, date))) return false
  return true
}

function load(): Accessor<Map<string, CatalogModel>> {
  if (signal) return signal

  const [value, setValue] = createSignal<Map<string, CatalogModel>>(new Map())
  signal = value

  void fetch("https://opencode.ai/inference/go/v1/models")
    .then((response) => {
      if (!response.ok) throw new Error(`Go catalog: ${response.status}`)
      return response.json()
    })
    .then((json: { data?: Array<{ id?: string; name?: string; go?: { monthly_usage?: Record<string, number> }; cost?: { multipliers?: Multiplier[] } }> }) => {
      const map = new Map<string, CatalogModel>()
      for (const item of json.data ?? []) {
        if (!item.id) continue
        map.set(item.id, {
          id: item.id,
          name: item.name,
          monthly: item.go?.monthly_usage as Partial<Record<Plan, number>> | undefined,
          multipliers: item.cost?.multipliers,
        })
      }
      setValue(map)
    })
    .catch(() => setValue(new Map()))

  return value
}

export function monthlyLimit(modelID: string | undefined, plan: Plan): number | undefined {
  if (!modelID) return undefined
  return load()().get(modelID)?.monthly?.[plan] ?? FALLBACK[modelID]?.[plan]
}

export function multiplierFor(modelID: string | undefined, timestamp: number): number {
  if (!modelID) return 1
  const model = load()().get(modelID)
  const list = model?.multipliers?.length ? model.multipliers : FALLBACK_MULTIPLIERS[modelID]
  if (!list || list.length === 0) return 1

  const date = new Date(timestamp)
  let factor: number | undefined
  for (const item of list) {
    if (!matches(item.when, date)) continue
    factor = factor === undefined ? item.factor : Math.max(factor, item.factor)
  }
  return factor ?? 1
}
