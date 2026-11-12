import { useState } from "react"
import { ChevronRight, Send } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

import { Field, TEXTAREA } from "@/components/common"
import { NodePicker } from "@/components/pickers"
import { api, type Node } from "@/lib/api"
import { useSettings } from "@/lib/settings"

// One offline alert, filled in the way the hub fills a template: in a single pass,
// JSON-escaped for the webhook body. Previews only; nothing here is sent.
const SAMPLE_NOTE: Record<string, string> = {
  event: "offline",
  node: "香港 · 甲商家",
  title: "🔴 香港 · 甲商家 离线",
  message: "最后上报 09-15 20:13 +08:00",
  time: "09-15 20:16 +08:00",
}

const PLACEHOLDERS = "{{title}} {{message}} {{node}} {{event}} {{site}} {{time}}"

function TemplatePreview({ template, site, json = false }: { template: string; site: string; json?: boolean }) {
  if (!template.trim()) return <p className="text-xs text-muted-foreground">留空保存即恢复默认模板</p>
  const values = { ...SAMPLE_NOTE, site }
  let out = template.replace(/\{\{(event|node|title|message|site|time)\}\}/g, (_, key: keyof typeof values) =>
    json ? JSON.stringify(values[key]).slice(1, -1) : values[key],
  )
  if (json) {
    try {
      out = JSON.stringify(JSON.parse(out), null, 2)
    } catch {
      return (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          代入后不是合法 JSON，保存会被拒绝。占位符要写在引号里，例如 "text": "{"{{title}}"}"
        </p>
      )
    }
  }
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">预览（以一条离线通知为例）</div>
      <pre className="overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">{out}</pre>
    </div>
  )
}

// A channel's form, collapsed until needed. The summary carries whether the
// channel is configured, so the closed card still answers the common question.
function ChannelCard({ title, configured, children }: { title: string; configured: boolean; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2 text-sm font-medium">
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
            {title}
          </span>
          <Badge variant={configured ? "secondary" : "outline"}>{configured ? "已配置" : "未配置"}</Badge>
        </summary>
        <div className="mt-4 space-y-4">{children}</div>
      </details>
    </Card>
  )
}

// Offline alerts are opt-in per node, so turning them on for a fleet needs one
// place rather than one dialog per node. Ticks are a draft until 保存, like every
// other form in the panel: a request per click would make each tick wait on a
// round trip and a refresh before showing.
function OfflineNodes({ nodes, refresh }: { nodes: Node[]; refresh: () => void }) {
  // Only the ticks changed here, by node id. A snapshot of every node's state
  // would send back a node another session switched meanwhile.
  const [draft, setDraft] = useState<Map<number, boolean>>(new Map())
  const [saving, setSaving] = useState(false)
  const on = (n: Node) => draft.get(n.id) ?? !!n.notify
  const chosen = new Set(nodes.filter(on).map((n) => n.id))
  // Against the live list, so a node deleted meanwhile is neither counted nor sent.
  const turnOn = nodes.filter((n) => on(n) && !n.notify).map((n) => n.id)
  const turnOff = nodes.filter((n) => !on(n) && n.notify).map((n) => n.id)
  const dirty = turnOn.length + turnOff.length > 0

  // Kept after a save until the list reports it, so the ticks do not flash back
  // to the old state for a round trip. Adjusted during render rather than in an
  // effect, as it follows from props alone.
  if (draft.size && !dirty && !saving) setDraft(new Map())

  const pick = (list: Node[], value: boolean) =>
    setDraft((old) => {
      const next = new Map(old)
      for (const n of list) next.set(n.id, value)
      return next
    })

  async function save() {
    setSaving(true)
    try {
      for (const [ids, on] of [[turnOn, true], [turnOff, false]] as const) {
        if (ids.length) await api("/nodes/batch", { method: "PUT", body: JSON.stringify({ ids, patch: { notify: on } }) })
      }
      toast.success("离线通知已保存")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      refresh()
      setSaving(false)
    }
  }

  const pending = [turnOn.length && `打开 ${turnOn.length} 台`, turnOff.length && `关闭 ${turnOff.length} 台`].filter(Boolean)
  return (
    <Card className="gap-4 p-5">
      <div>
        <h3 className="text-sm font-medium">离线通知</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          按节点打开，默认关。已打开 {nodes.filter((n) => n.notify).length} / {nodes.length} 台
          {pending.length > 0 && <span className="text-foreground">，待保存：{pending.join("、")}</span>}
        </p>
      </div>
      <NodePicker nodes={nodes} chosen={chosen} onPick={pick} disabled={saving} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(new Map())}>撤销</Button>
        <Button size="sm" disabled={!dirty || saving} onClick={save}>保存</Button>
      </div>
    </Card>
  )
}

export function Notify({ nodes, refresh }: { nodes: Node[]; refresh: () => void }) {
  const { s, set, save } = useSettings()
  const [testing, setTesting] = useState(false)
  if (!s) return null
  const text = (k: string) => String(s[k] ?? "")
  // A credential is sent only when something was typed: the field starts empty
  // because the hub never returns the stored value.
  const typed = (...keys: string[]) =>
    Object.fromEntries(keys.filter((k) => typeof s[k] === "string" && s[k] !== "").map((k) => [k, text(k)]))
  const secretHint = (k: string) => (s[`${k}_set`] ? "已设置，留空不变" : "未设置")

  async function test() {
    setTesting(true)
    try {
      const { sent } = await api<{ sent: string[] }>("/notify/test", { method: "POST" })
      toast.success(`测试通知已发送：${sent.join("、")}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">通知渠道</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Telegram 和 Webhook 配了哪个就发哪个，也可以同时用。离线通知在下方按节点打开；流量和到期提醒对填了额度、到期日的节点生效。
            </p>
          </div>
          <Button size="sm" variant="secondary" disabled={testing} onClick={test}>
            <Send /> {testing ? "发送中…" : "发送测试"}
          </Button>
        </div>
      </Card>

      <ChannelCard title="Telegram" configured={!!s.notify_telegram_token_set && text("notify_telegram_chat") !== ""}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bot Token" hint={secretHint("notify_telegram_token")}>
            <Input
              type="password"
              autoComplete="off"
              placeholder={s.notify_telegram_token_set ? "••••••••" : "123456:ABC-DEF…"}
              value={text("notify_telegram_token")}
              onChange={(e) => set("notify_telegram_token", e.target.value)}
            />
          </Field>
          <Field label="Chat ID" hint="数字 ID，群组是负数；公开频道可填 @频道名">
            <Input value={text("notify_telegram_chat")} onChange={(e) => set("notify_telegram_chat", e.target.value)} placeholder="-1001234567890" />
          </Field>
        </div>
        <Field label="消息模板" hint={`纯文本。占位符 ${PLACEHOLDERS}`}>
          <textarea rows={3} className={TEXTAREA} value={text("notify_telegram_text")} onChange={(e) => set("notify_telegram_text", e.target.value)} />
        </Field>
        <TemplatePreview template={text("notify_telegram_text")} site={text("site_name") || "Monitor"} />
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() =>
              save({
                notify_telegram_chat: text("notify_telegram_chat"),
                notify_telegram_text: text("notify_telegram_text"),
                ...typed("notify_telegram_token"),
              })
            }
          >
            保存 Telegram
          </Button>
          {s.notify_telegram_token_set && (
            <Button size="sm" variant="ghost" onClick={() => save({ notify_telegram_token: "", notify_telegram_chat: "" }, "已清除 Telegram")}>
              清除
            </Button>
          )}
        </div>
      </ChannelCard>

      <ChannelCard title="Webhook" configured={!!s.notify_webhook_url_set}>
        <Field label="URL" hint={secretHint("notify_webhook_url")}>
          <Input
            type="password"
            autoComplete="off"
            placeholder={s.notify_webhook_url_set ? "••••••••" : "https://…"}
            value={text("notify_webhook_url")}
            onChange={(e) => set("notify_webhook_url", e.target.value)}
          />
        </Field>
        <Field label="请求头" hint={`可选，一行一个。${s.notify_webhook_headers_set ? "已设置，留空不变" : ""}`}>
          <textarea
            rows={2}
            className={TEXTAREA}
            placeholder={s.notify_webhook_headers_set ? "••••••••" : "Authorization: Bearer xxx"}
            value={text("notify_webhook_headers")}
            onChange={(e) => set("notify_webhook_headers", e.target.value)}
          />
        </Field>
        <Field label="请求体" hint={`以 POST 发送，Content-Type 为 application/json。占位符 ${PLACEHOLDERS}，须写在引号内`}>
          <textarea rows={4} className={TEXTAREA} value={text("notify_webhook_body")} onChange={(e) => set("notify_webhook_body", e.target.value)} />
        </Field>
        <TemplatePreview template={text("notify_webhook_body")} site={text("site_name") || "Monitor"} json />
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => save({ notify_webhook_body: text("notify_webhook_body"), ...typed("notify_webhook_url", "notify_webhook_headers") })}
          >
            保存 Webhook
          </Button>
          {s.notify_webhook_headers_set && (
            <Button size="sm" variant="ghost" onClick={() => save({ notify_webhook_headers: "" }, "已清除请求头")}>
              清除请求头
            </Button>
          )}
          {s.notify_webhook_url_set && (
            <Button size="sm" variant="ghost" onClick={() => save({ notify_webhook_url: "", notify_webhook_headers: "" }, "已清除 Webhook")}>
              清除
            </Button>
          )}
        </div>
      </ChannelCard>

      <OfflineNodes nodes={nodes} refresh={refresh} />

      <Card className="gap-4 p-5">
        <h3 className="text-sm font-medium">事件</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="离线宽限期（分钟）" hint="断开超过这么久才算离线，1–30">
            <Input type="number" min={1} max={30} value={text("notify_grace")} onChange={(e) => set("notify_grace", e.target.value)} />
          </Field>
          <Field label="流量提醒（%）" hint="本期用量达到该比例和 100% 时各提醒一次，0 关闭">
            <Input type="number" min={0} max={100} value={text("notify_traffic")} onChange={(e) => set("notify_traffic", e.target.value)} />
          </Field>
          <Field label="到期提醒（天）" hint="每天 9 点汇总这么多天内到期的节点，自动续期时也提醒，0 关闭">
            <Input type="number" min={0} max={365} value={text("notify_expiry")} onChange={(e) => set("notify_expiry", e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch aria-labelledby="notify-login-label" checked={s.notify_login !== "off"} onCheckedChange={(v) => set("notify_login", v ? "on" : "off")} />
          <span id="notify-login-label">登录后台时提醒</span>
        </div>
        <div>
          <Button
            size="sm"
            onClick={() =>
              save({
                notify_grace: text("notify_grace"),
                notify_traffic: text("notify_traffic"),
                notify_expiry: text("notify_expiry"),
                notify_login: s.notify_login === "off" ? "off" : "on",
              })
            }
          >
            保存事件设置
          </Button>
        </div>
      </Card>
    </div>
  )
}
