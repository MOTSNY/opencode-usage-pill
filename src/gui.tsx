import { ComposerPill, Command, Plugin, SettingsPage, createKeyed } from "@opencode/plugin/gui"
import type { ComposerPillMenuProps, ComposerPillProps, Context } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { Show, For, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { multiplierFor, monthlyLimit } from "./catalog"
import {
  compact,
  percent,
  sessionBreakdown,
  tokensOf,
  totalTokens,
  usd,
  type MessageLike,
  type Plan,
  type SessionLike,
} from "./usage"

type MountedSession = ComposerPillProps["session"]
type Data = MountedSession["server"]["data"]
type SessionInfo = ReturnType<Data["session"]["get"]>
type ModelInfo = NonNullable<ReturnType<Data["location"]["model"]["list"]>>[number]
type HistoryMode = "auto" | "switch" | "button"

interface Meter {
  percent: number
  limited: boolean
  resetsAt: number
}

interface Account {
  rolling: Meter
  weekly: Meter
  monthly: Meter
}

interface Usage {
  total: number
  main: number
  subs: number
  subCount: number
  tokens: number
  cachePct: number
  pct?: number
  pctPartial: boolean
  account?: Account
  usageURL?: string
  models: ModelUsage[]
  switchTimeline: string[]
  switchCount: number
  partial: boolean
  historyLoading: boolean
}

interface ModelUsage {
  key: string
  name: string
  cost: number
  tokens: number
  sessions: number
  pct?: number
  limit?: number
}

function getUsage(session: MountedSession, plan: Plan): Usage | undefined {
  const data = session.server.data
  const rootID = data.session.root(session.id)
  const family = data.session.family(rootID)
  const ids = family.length > 0 ? family : [session.id]
  const models = data.location.model.list(session.location) ?? []
  const findModel = (providerID: string, id: string): ModelInfo | undefined =>
    models.find((model) => model.providerID === providerID && model.id === id)

  let main = 0
  let subs = 0
  let subCount = 0
  let tokens = 0
  let cacheRead = 0
  let pctSum = 0
  let pctKnown = false
  let pctPartial = false
  let rootBreakdown: ReturnType<typeof sessionBreakdown> | undefined

  const byModel = new Map<string, ModelUsage>()

  for (const id of ids) {
    if (data.session.missing(id)) continue
    const info = data.session.get(id)
    const breakdown = sessionBreakdown(
      info as SessionLike,
      findModel,
      data.session.message.list(id) as MessageLike[],
      multiplierFor,
    )
    const usage = tokensOf(info)
    tokens += totalTokens(usage)
    cacheRead += usage.cache.read

    if (id === rootID) {
      main += breakdown.total
      rootBreakdown = breakdown
    } else {
      subs += breakdown.total
      subCount++
    }

    for (const bucket of breakdown.models) {
      const entry = byModel.get(bucket.key) ?? {
        key: bucket.key,
        name: findModel(bucket.model.providerID, bucket.model.id)?.name ?? bucket.model.id,
        cost: 0,
        tokens: 0,
        sessions: 0,
        pct: undefined as number | undefined,
        limit: undefined as number | undefined,
      }
      entry.cost += bucket.cost
      entry.tokens += bucket.tokens
      entry.sessions++

      if (bucket.model.providerID === "opencode-go") {
        const limit = monthlyLimit(bucket.model.id, plan)
        if (limit && limit > 0) {
          const share = (bucket.cost / limit) * 100
          entry.pct = (entry.pct ?? 0) + share
          entry.limit = limit
          pctSum += share
          pctKnown = true
        } else if (bucket.cost > 0) {
          pctPartial = true
        }
      } else if (bucket.cost > 0) {
        pctPartial = true
      }
      byModel.set(bucket.key, entry)
    }
  }

  if (!rootBreakdown) return undefined
  const total = main + subs
  if (tokens === 0 && total === 0) return undefined

  const modelList = [...byModel.values()].sort((a, b) => b.cost - a.cost)
  const switchTimeline = rootBreakdown.timeline.map(
    (model) => findModel(model.providerID, model.id)?.name ?? model.id,
  )
  const limits = data.location.usage.limits(session.location)

  return {
    total,
    main,
    subs,
    subCount,
    tokens,
    cachePct: tokens > 0 ? (cacheRead / tokens) * 100 : 0,
    pct: pctKnown ? pctSum : undefined,
    pctPartial,
    account: limits?.go as Account | undefined,
    usageURL: limits?.workspace?.usageURL,
    models: modelList,
    switchTimeline,
    switchCount: rootBreakdown.switchCount,
    partial: data.session.message.more(rootID) || data.session.message.loading(rootID),
    historyLoading: data.session.message.loading(rootID),
  }
}

function labelOf(usage: Usage): string {
  return usage.pct !== undefined ? `${usd(usage.total)} · ≈${percent(usage.pct)}` : usd(usage.total)
}

function normalizePlan(value: unknown): Plan {
  return value === "go-plus" || value === "go-teams" ? value : "go"
}

function normalizeHistory(value: unknown): HistoryMode {
  return value === "auto" || value === "switch" ? value : "button"
}

function normalizeEnabled(value: unknown): boolean {
  return value !== false
}

function planLabel(plan: Plan): string {
  return plan === "go-plus" ? "Go Plus" : plan === "go-teams" ? "Go Teams" : "Go"
}

const PLAN_OPTIONS = [
  { value: "go", label: "Go" },
  { value: "go-plus", label: "Go Plus" },
  { value: "go-teams", label: "Go Teams" },
] as const

function switchText(timeline: string[], count: number): string {
  if (timeline.length <= 1) return ""
  const shown =
    timeline.length <= 5
      ? timeline.join(" → ")
      : `${timeline[0]} → … → ${timeline[timeline.length - 1]}`
  return `${shown} (${count})`
}

const muted = "var(--v2-text-text-muted, #8a8a8a)"
const base = "var(--v2-text-text-base, inherit)"
const border = "var(--v2-border-border-base, rgba(127, 127, 127, 0.22))"

const wrapStyle = {
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
  "min-width": "280px",
  padding: "2px 0",
  "font-size": "12px",
  "line-height": "17px",
} as const

const emptyStyle = {
  padding: "4px 0",
  color: muted,
  "font-size": "12px",
} as const

const headerStyle = {
  display: "flex",
  "align-items": "baseline",
  "justify-content": "space-between",
  gap: "10px",
} as const

const totalStyle = {
  color: base,
  "font-size": "15px",
  "font-weight": 600,
  "font-variant-numeric": "tabular-nums",
} as const

const planChipStyle = {
  border: "1px solid var(--v2-border-border-base, rgba(127, 127, 127, 0.22))",
  "border-radius": "4px",
  padding: "0 5px",
  background: "transparent",
  color: muted,
  "font-size": "11px",
  "line-height": "16px",
  cursor: "pointer",
} as const

const metaStyle = {
  color: muted,
  "font-size": "11px",
  "line-height": "16px",
} as const

const mainSubStyle = {
  display: "flex",
  "justify-content": "space-between",
  gap: "10px",
  "flex-wrap": "wrap",
  "font-size": "12px",
} as const

const mutedStyle = { color: muted } as const
const valueStyle = { color: base, "font-variant-numeric": "tabular-nums" } as const

const switchStyle = {
  color: muted,
  "font-size": "11px",
  "line-height": "16px",
  "overflow-wrap": "anywhere",
} as const

const sectionLabelStyle = {
  color: muted,
  "font-size": "11px",
  "text-transform": "uppercase",
  "letter-spacing": "0.04em",
} as const

const modelRowStyle = {
  display: "flex",
  "align-items": "baseline",
  "justify-content": "space-between",
  gap: "10px",
  "font-size": "12px",
  "line-height": "16px",
} as const

const modelNameStyle = {
  color: base,
  "min-width": "0",
  "white-space": "normal",
  "overflow-wrap": "anywhere",
} as const

const modelValueStyle = {
  color: base,
  "font-variant-numeric": "tabular-nums",
  "text-align": "right",
  "white-space": "nowrap",
} as const

const sumStyle = {
  color: muted,
  "font-size": "11px",
  "line-height": "16px",
} as const

const linkStyle = {
  alignSelf: "flex-start",
  border: "none",
  background: "transparent",
  color: muted,
  "font-size": "11px",
  "line-height": "16px",
  padding: "0",
  cursor: "pointer",
  "text-decoration": "underline",
} as const

const accountStyle = {
  display: "flex",
  "align-items": "baseline",
  gap: "8px",
  "flex-wrap": "wrap",
  "font-size": "11px",
  "line-height": "16px",
} as const

const accountValuesStyle = {
  color: base,
  "font-variant-numeric": "tabular-nums",
} as const

const consoleStyle = {
  alignSelf: "flex-end",
  border: "none",
  background: "transparent",
  color: muted,
  "font-size": "11px",
  "line-height": "16px",
  padding: "0",
  cursor: "pointer",
} as const

function Divider() {
  return <div style={{ height: "1px", background: border, margin: "2px 0" }} />
}

function UsageMenu(props: {
  input: ComposerPillMenuProps
  plan: () => Plan
  history: () => HistoryMode
  ctx: Context
}) {
  onMount(() => {
    const session = props.input.session
    const data = session.server.data
    void Promise.allSettled([
      data.session.sync(data.session.root(session.id), { children: true }),
      data.location.model.sync(session.location),
      data.location.usage.sync(session.location),
    ])
  })

  const [loading, setLoading] = createSignal(false)
  const usage = createMemo(() => getUsage(props.input.session, props.plan()))

  const loadHistory = async () => {
    const session = props.input.session
    const data = session.server.data
    setLoading(true)
    try {
      await data.session.message.loadMore(data.session.root(session.id), { all: true })
    } catch {
      props.ctx.toast.show({ title: props.ctx.t("row.loadHistoryFailed"), variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  let autoAttempted = false
  createEffect(() => {
    props.input.session.key
    autoAttempted = false
  })
  createEffect(() => {
    if (props.history() !== "auto" || autoAttempted) return
    const value = usage()
    if (!value?.partial || value.historyLoading || loading()) return
    autoAttempted = true
    void loadHistory()
  })

  return (
    <Show when={usage()} fallback={<div style={emptyStyle}>{props.ctx.t("menu.empty")}</div>}>
      {(value) => (
        <div style={wrapStyle}>
          <div style={headerStyle}>
            <span style={totalStyle}>≈{usd(value().total)}</span>
            <button
              type="button"
              style={planChipStyle}
              onClick={() => {
                props.input.close()
                props.ctx.layout.settings("usage-pill")
              }}
            >
              {planLabel(props.plan())} ▸
            </button>
          </div>

          <div style={metaStyle}>
            {compact(value().tokens)} · {props.ctx.t("row.cache", { pct: Math.round(value().cachePct) })}
            <Show when={value().partial}> · {props.ctx.t("row.partial")}</Show>
          </div>

          <Divider />

          <div style={mainSubStyle}>
            <span>
              <span style={mutedStyle}>{props.ctx.t("row.main")}</span> <span style={valueStyle}>{usd(value().main)}</span>
            </span>
            <Show when={value().subCount > 0}>
              <span>
                <span style={mutedStyle}>{props.ctx.t("row.subagents", { count: value().subCount })}</span>{" "}
                <span style={valueStyle}>{usd(value().subs)}</span>
              </span>
            </Show>
          </div>

          <Show when={value().switchCount > 0 && value().switchTimeline.length > 1}>
            <div
              style={switchStyle}
              title={props.ctx.t("row.switchedHint", { count: value().switchCount })}
            >
              <span style={mutedStyle}>{props.ctx.t("row.switched")}: </span>
              {switchText(value().switchTimeline, value().switchCount)}
            </div>
          </Show>

          <Divider />

          <div style={sectionLabelStyle}>{props.ctx.t("row.models")}</div>
          <For each={value().models}>
            {(model) => (
              <div
                style={modelRowStyle}
                title={`${model.name}${model.limit ? ` · ${usd(model.limit!)}${props.ctx.t("unit.month")}` : ""}`}
              >
                <span style={modelNameStyle}>
                  {model.name}
                  {model.sessions > 1 ? ` (${model.sessions})` : ""}
                </span>
                <span style={modelValueStyle}>
                  {usd(model.cost)}
                  {model.pct !== undefined ? ` · ≈${percent(model.pct)}` : ""}
                </span>
              </div>
            )}
          </For>

          <Divider />

          <div style={sumStyle} title={props.ctx.t("row.sumHint")}>
            {props.ctx.t("row.sumLimits")} {value().pct !== undefined ? `≈${percent(value().pct!)}` : "—"}
            {value().pctPartial ? ` ${props.ctx.t("row.sumPartial")}` : ""} {props.ctx.t("row.sumNote")}
          </div>

          <Show when={value().partial}>
            <button
              type="button"
              style={linkStyle}
              disabled={loading() || value().historyLoading}
              onClick={() => void loadHistory()}
            >
              {loading() || value().historyLoading
                ? props.ctx.t("row.loadingHistory")
                : props.ctx.t("row.loadHistory")}
            </button>
          </Show>

          <Show when={value().account}>
            {(account) => (
              <div style={accountStyle}>
                <span style={mutedStyle}>{props.ctx.t("row.accountOfficial")}</span>
                <span style={accountValuesStyle}>
                  {props.ctx.t("row.account5hShort")} {account().rolling.percent}% ·{" "}
                  {props.ctx.t("row.weekShort")} {account().weekly.percent}% ·{" "}
                  {props.ctx.t("row.monthShort")} {account().monthly.percent}%
                </span>
              </div>
            )}
          </Show>

          <Show when={value().usageURL}>
            {(url) => (
              <button type="button" style={consoleStyle} onClick={() => void props.ctx.system.openExternal(url())}>
                {props.ctx.t("row.console")} ↗
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

export default Plugin.define({
  i18n: {
    en: {
      "pill.title": "Session spend",
      "row.main": "Main",
      "row.subagents": "Subagents ({{count}})",
      "row.total": "Total",
      "row.limit": "{{model}} limit",
      "row.monthShare": "Month share",
      "row.plan": "Plan",
      "row.models": "Models",
      "row.tokens": "Tokens",
      "row.cache": "cache {{pct}}%",
      "row.account5h": "Account 5h",
      "row.week": "Week",
      "row.month": "Month",
      "row.console": "Console Activity",
      "row.sumLimits": "Σ by model limits",
      "row.sumNote": "(estimate, not billing)",
      "row.sumPartial": "(partial)",
      "row.sumHint": "Estimated list cost against the models' monthly Go limits. Not official billing or account usage.",
      "row.accountOfficial": "Account (official)",
      "row.account5hShort": "5h",
      "row.weekShort": "wk",
      "row.monthShort": "mo",
      "row.partial": "history partial",
      "row.loadHistory": "Load history",
      "row.loadingHistory": "Loading…",
      "row.loadHistoryFailed": "Couldn't load history",
      "row.switched": "Model changed",
      "row.switchedHint": "Switches: {{count}}",
      "row.switchedTimes": "{{count}} switches",
      "unit.month": "/mo",
      "menu.empty": "No usage data yet",
      "command.refresh": "Refresh session spend",
      "settings.title": "Session spend",
      "settings.description": "Session cost estimate and the monthly limit used for the percentage.",
      "settings.enabled": "Show counter",
      "settings.enabled.description": "Show the session spend pill above the composer. The settings page stays available when it is off.",
      "settings.section": "OpenCode Go",
      "settings.plan": "Plan",
      "settings.plan.description": "The plan that sets the monthly limit for the percentage.",
      "settings.history": "History",
      "settings.history.description": "Load the full transcript by button, when the popover opens, or when switching to a chat.",
      "settings.history.button": "By button",
      "settings.history.auto": "On popover open",
      "settings.history.switch": "On chat switch",
    },
    ru: {
      "pill.title": "Расход сессии",
      "row.main": "Основная",
      "row.subagents": "Субагенты ({{count}})",
      "row.total": "Итого",
      "row.limit": "Лимит {{model}}",
      "row.monthShare": "Доля месяца",
      "row.plan": "План",
      "row.models": "Модели",
      "row.tokens": "Токены",
      "row.cache": "кеш {{pct}}%",
      "row.account5h": "Аккаунт 5ч",
      "row.week": "Неделя",
      "row.month": "Месяц",
      "row.console": "Console Activity",
      "row.sumLimits": "Σ по лимитам моделей",
      "row.sumNote": "(оценка, не биллинг)",
      "row.sumPartial": "(часть)",
      "row.sumHint": "Оценка list cost по месячным лимитам моделей Go. Не официальный биллинг и не процент аккаунта.",
      "row.accountOfficial": "Аккаунт (офиц.)",
      "row.account5hShort": "5ч",
      "row.weekShort": "нед",
      "row.monthShort": "мес",
      "row.partial": "история частично",
      "row.loadHistory": "Догрузить историю",
      "row.loadingHistory": "Загружаю…",
      "row.loadHistoryFailed": "Не удалось загрузить историю",
      "row.switched": "Модель менялась",
      "row.switchedHint": "Переключений: {{count}}",
      "row.switchedTimes": "{{count}} смен",
      "unit.month": "/мес",
      "menu.empty": "Данных о расходе пока нет",
      "command.refresh": "Обновить расход сессии",
      "settings.title": "Расход сессии",
      "settings.description": "Оценка стоимости сессии и месячный лимит, от которого считается процент.",
      "settings.enabled": "Показывать счётчик",
      "settings.enabled.description": "Показывать пилюлю расхода над полем ввода. Страница настроек остаётся доступной, когда счётчик выключен.",
      "settings.section": "OpenCode Go",
      "settings.plan": "План",
      "settings.plan.description": "План задаёт месячный лимит, от которого считается процент.",
      "settings.history": "История",
      "settings.history.description": "Загружать всю историю по кнопке, при открытии поповера или при переключении на чат.",
      "settings.history.button": "По кнопке",
      "settings.history.auto": "При открытии",
      "settings.history.switch": "При переключении",
    },
  },
  setup(ctx) {
    const settings = ctx.storage.store("settings", {
      schema: Schema.Struct({
        enabled: Schema.Boolean,
        plan: Schema.Literals(["go", "go-plus", "go-teams"]),
        history: Schema.Literals(["button", "auto", "switch"]),
      }),
      initial: {
        enabled: normalizeEnabled(ctx.options.enabled),
        plan: normalizePlan(ctx.options.plan),
        history: normalizeHistory(ctx.options.history),
      },
    })
    const enabled = (): boolean => settings.value?.enabled ?? normalizeEnabled(ctx.options.enabled)
    const plan = (): Plan => settings.value?.plan ?? normalizePlan(ctx.options.plan)
    const history = (): HistoryMode => settings.value?.history ?? normalizeHistory(ctx.options.history)

    createKeyed(
      () => ctx.sessions.current()?.key,
      () => {
        const session = ctx.sessions.current()
        if (!session) return
        const data = session.server.data
        void Promise.allSettled([
          data.session.sync(data.session.root(session.id), { children: true }),
          data.location.model.sync(session.location),
          data.location.usage.sync(session.location),
        ])
      },
    )

    const historyAttempted = new Set<string>()
    createEffect(() => {
      if (!settings.ready()) return
      if (!enabled()) return
      const session = ctx.sessions.current()
      if (!session || history() !== "switch") return
      const data = session.server.data
      const root = data.session.root(session.id)
      if (historyAttempted.has(root)) return
      if (!data.session.message.more(root) && !data.session.message.loading(root)) return
      historyAttempted.add(root)
      if (data.session.message.loading(root)) return
      void data.session.message.loadMore(root, { all: true }).catch(() => {})
    })

    ctx.add(ComposerPill, {
      id: "usage",
      order: 10,
      show: (input) => {
        if (!enabled()) return undefined
        const usage = getUsage(input.session, plan())
        if (!usage) return undefined
        return {
          label: labelOf(usage),
          title: ctx.t("pill.title"),
          icon: "glasses",
        }
      },
      menu: (input) => <UsageMenu input={input} plan={plan} history={history} ctx={ctx} />,
    })

    ctx.add(SettingsPage, {
      id: "usage-pill",
      icon: "glasses",
      get title() {
        return ctx.t("settings.title")
      },
      get entries() {
        return [
          {
            id: "enabled",
            title: ctx.t("settings.enabled"),
            description: ctx.t("settings.enabled.description"),
          },
          {
            id: "plan",
            title: ctx.t("settings.plan"),
            description: ctx.t("settings.plan.description"),
          },
          {
            id: "history",
            title: ctx.t("settings.history"),
            description: ctx.t("settings.history.description"),
          },
        ]
      },
      render: () => {
        const historyOptions = [
          { value: "button", label: ctx.t("settings.history.button") },
          { value: "auto", label: ctx.t("settings.history.auto") },
          { value: "switch", label: ctx.t("settings.history.switch") },
        ] as const
        return (
          <ctx.ui.SettingsLayout title={ctx.t("settings.title")} description={ctx.t("settings.description")}>
            <ctx.ui.SettingsSection title={ctx.t("settings.section")}>
              <ctx.ui.SettingsRow
                id="enabled"
                title={ctx.t("settings.enabled")}
                description={ctx.t("settings.enabled.description")}
              >
                <ctx.ui.Switch
                  label={ctx.t("settings.enabled")}
                  hideLabel
                  checked={enabled()}
                  onChange={(value) => settings.update((draft) => { draft.enabled = value })}
                />
              </ctx.ui.SettingsRow>
              <ctx.ui.SettingsRow id="plan" title={ctx.t("settings.plan")} description={ctx.t("settings.plan.description")}>
                <ctx.ui.Select
                  options={PLAN_OPTIONS}
                  value={plan()}
                  onChange={(value) => settings.update((draft) => { draft.plan = normalizePlan(value) })}
                  label={ctx.t("settings.plan")}
                />
              </ctx.ui.SettingsRow>
              <ctx.ui.SettingsRow
                id="history"
                title={ctx.t("settings.history")}
                description={ctx.t("settings.history.description")}
              >
                <ctx.ui.Select
                  options={historyOptions}
                  value={history()}
                  onChange={(value) => settings.update((draft) => { draft.history = normalizeHistory(value) })}
                  label={ctx.t("settings.history")}
                />
              </ctx.ui.SettingsRow>
            </ctx.ui.SettingsSection>
          </ctx.ui.SettingsLayout>
        )
      },
    })

    ctx.add(Command, (): Command => ({
      id: "refresh",
      title: ctx.t("command.refresh"),
      section: "session",
      enabled: enabled() && !!ctx.sessions.current(),
      run: () => {
        const session = ctx.sessions.current()
        if (!session) return
        const data = session.server.data
        void Promise.allSettled([
          data.session.sync(data.session.root(session.id), { children: true }),
          data.location.model.sync(session.location),
          data.location.usage.sync(session.location),
        ])
      },
    }))
  },
})
