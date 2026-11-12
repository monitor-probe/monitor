import { useEffect, useId, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

import { Field, OptionRow } from "@/components/common"
import { NodePicker } from "@/components/pickers"
import { api, changes, GIB, type Node, trafficCorrection } from "@/lib/api"
import { addMonths, cycleMonths } from "@/lib/format"

// Counters the panel can correct after migration or an accounting error.
const TRAFFIC_FIELDS = [
  ["total_rx", "累计下行"],
  ["total_tx", "累计上行"],
  ["month_rx", "本月下行"],
  ["month_tx", "本月上行"],
] as const
const TRAFFIC_MODES: Record<string, string> = {
  sum: "上下行相加",
  max: "取较大值",
  up: "仅上行",
  down: "仅下行",
}

// Free text, with the groups already in use offered, so a group is picked
// rather than retyped, where a typo would start a second one. A list of its own
// rather than a <datalist>: Chrome draws that as a tooltip and filters it by the
// text already in the box, so a grouped node was offered only its own group.
// The whole list shows on opening; typing narrows it without highlighting, so
// Enter keeps a new name that merely prefixes an existing one.
function GroupInput({ nodes, value, onChange }: {
  nodes: Pick<Node, "group">[]
  value: string
  onChange: (value: string) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const counts = new Map<string, number>()
  for (const n of nodes) if (n.group) counts.set(n.group, (counts.get(n.group) ?? 0) + 1)
  const name = value.trim()
  const query = typed ? name.toLowerCase() : ""
  const matches = [...counts.keys()].filter((g) => g.toLowerCase().includes(query))
  // "" is 未分组, offered last while the list is not being narrowed.
  const items = query ? matches : [...matches, ""]
  const fresh = typed && name !== "" && !counts.has(name)
  const shown = open && (matches.length > 0 || fresh)

  useEffect(() => {
    if (shown) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" })
  }, [id, active, shown])

  const show = () => {
    setTyped(false)
    setActive(Math.max(0, [...counts.keys(), ""].indexOf(name)))
    setOpen(true)
  }
  const pick = (group: string) => {
    onChange(group)
    setTyped(false)
    setOpen(false)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!shown) return show()
      if (!items.length) return
      const down = e.key === "ArrowDown"
      setActive((i) => (i < 0 ? (down ? 0 : items.length - 1) : (i + (down ? 1 : -1) + items.length) % items.length))
    } else if (e.key === "Enter" && shown) {
      e.preventDefault()
      if (items[active] !== undefined) pick(items[active])
      else setOpen(false)
    }
  }

  if (!counts.size) {
    return <Input maxLength={13} value={value} onChange={(e) => onChange(e.target.value)} placeholder="未分组" />
  }
  return (
    <Popover open={shown} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            ref={input}
            role="combobox"
            aria-expanded={shown}
            aria-controls={id}
            aria-autocomplete="list"
            aria-activedescendant={shown && items[active] !== undefined ? `${id}-${active}` : undefined}
            maxLength={13}
            value={value}
            placeholder="未分组"
            className="pr-9"
            onChange={(e) => {
              onChange(e.target.value)
              setTyped(true)
              setActive(-1)
              setOpen(true)
            }}
            onClick={show}
            onKeyDown={onKeyDown}
          />
          {/* Not a tab stop, and keeps the focus in the box it opens a list for. */}
          <button
            type="button"
            tabIndex={-1}
            aria-label="选择分组"
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground"
            onMouseDown={(e) => {
              e.preventDefault()
              if (shown) return setOpen(false)
              input.current?.focus()
              show()
            }}
          >
            <ChevronDown className={`size-4 opacity-50 transition-transform ${shown ? "rotate-180" : ""}`} />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // The box and its button sit outside the list; pressing them is not a dismissal.
        onInteractOutside={(e) => input.current?.parentElement?.contains(e.target as Element) && e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div role="listbox" id={id} aria-label="已有分组" className="max-h-60 overflow-y-auto">
          {items.map((group, i) => (
            <div key={group || "\0"}>
              {group === "" && <div className="my-1 h-px bg-border" />}
              <div
                id={`${id}-${i}`}
                role="option"
                aria-selected={group === name}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(group)}
                className={`relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm select-none ${i === active ? "bg-accent text-accent-foreground" : ""}`}
              >
                <span className={`truncate ${group ? "" : "text-muted-foreground"}`}>{group || "未分组"}</span>
                {group && <span className="tnum ml-auto shrink-0 text-xs text-muted-foreground">{counts.get(group)} 台</span>}
                {group === name && <Check className="absolute right-2 size-4" />}
              </div>
            </div>
          ))}
          {fresh && <p className="px-2 py-1.5 text-xs text-muted-foreground">新分组「{name}」，保存后生效</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Puts the nodes ticked here into one group, or, with the name left empty, out
// of any. Renaming or dissolving a group is the same act: filter the picker to
// it, tick all, then type the new name or clear it. One request, applied to all
// of them or none.
export function GroupDialog({ nodes, onClose, onSaved }: { nodes: Node[]; onClose: () => void; onSaved: (id: number, group: string) => void }) {
  const [name, setName] = useState("")
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const group = name.trim()
  // Counted against the live list, so a node deleted meanwhile is not sent.
  const ids = nodes.filter((n) => chosen.has(n.id)).map((n) => n.id)
  const pick = (list: Node[], on: boolean) =>
    setChosen((old) => {
      const next = new Set(old)
      for (const n of list) {
        if (on) next.add(n.id)
        else next.delete(n.id)
      }
      return next
    })

  async function save() {
    setSaving(true)
    try {
      await api("/nodes/batch", { method: "PUT", body: JSON.stringify({ ids, patch: { group } }) })
      toast.success(group ? `已把 ${ids.length} 台设为「${group}」` : `已把 ${ids.length} 台移出分组`)
      onClose()
      // The first that moved: one already in the group stays where it was.
      onSaved(nodes.find((n) => chosen.has(n.id) && n.group !== group)?.id ?? ids[0], group)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>设置分组</DialogTitle>
          <DialogDescription className="leading-relaxed">
            勾选节点，设为同一个分组。改名或解散：先筛选出这个分组、全选，再填新名字或清空。
          </DialogDescription>
        </DialogHeader>
        <form noValidate className="contents" onSubmit={(e) => { e.preventDefault(); save() }}>
          <div className="space-y-4">
            <Field label="分组名" hint="公开页可见，最多 13 字；留空为移出分组">
              <GroupInput nodes={nodes} value={name} onChange={setName} />
            </Field>
            <NodePicker nodes={nodes} chosen={chosen} onPick={pick} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving || !ids.length} className="max-w-full gap-0">
              <span className="truncate">{group ? `设为「${group}」` : "移出分组"}</span>
              {ids.length > 0 && <span className="tnum shrink-0">（{ids.length} 台）</span>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CreateNode({ onClose, onSaved }: {
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return toast.error("请填写节点名称")
    setSaving(true)
    try {
      const { id } = await api<{ id: number }>("/nodes", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      })
      toast.success("节点已添加")
      onClose()
      onSaved(id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加节点</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={save}>
          <Field label="名称">
            <Input autoFocus maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="香港 · 甲商家" />
          </Field>
          <DialogFooter className="border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving}>添加</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function NodeForm({ node, nodes, onClose, onSaved }: {
  node: Node
  nodes: Node[]
  onClose: () => void
  onSaved: (group?: string) => void
}) {
  const [form, setForm] = useState(node)
  const [limitGib, setLimitGib] = useState(String(node.traffic_limit / GIB || ""))
  // Text, as the limit is: a number state turns an emptied box into 0.
  const [resetDay, setResetDay] = useState(String(node.traffic_reset_day))
  const [saving, setSaving] = useState(false)
  const gib = (bytes: number) => String(Number((bytes / GIB).toFixed(3)))
  const [traffic, setTraffic] = useState(() =>
    Object.fromEntries(TRAFFIC_FIELDS.map(([k]) => [k, gib(node[k])])) as Record<string, string>,
  )
  // Compared as entered rather than as bytes: rounding to GB would read as an
  // edit and zero a node that has transferred a few MB.
  const pristine = useRef(traffic)
  const set = <K extends keyof Node>(k: K, v: Node[K]) => setForm((f) => ({ ...f, [k]: v }))
  // What each address box falls back to when left empty.
  const automatic = (v6: boolean) => (v6 ? node.ipv6_auto : node.ipv4_auto) || "无"

  async function save() {
    if (!form.name.trim()) return toast.error("请填写节点名称")
    const resetOn = Number(resetDay)
    if (!Number.isInteger(resetOn) || resetOn < 1 || resetOn > 31) return toast.error("每月重置日要填 1–31 之间的整数")
    const patch = changes(node, {
      name: form.name.trim(),
      public: form.public,
      remark: form.remark,
      public_remark: (form.public_remark ?? "").trim(),
      group: (form.group ?? "").trim(),
      traffic_mode: form.traffic_mode,
      traffic_limit: Math.round(Number(limitGib) * GIB),
      traffic_reset_day: resetOn,
      notify: !!form.notify,
      ipv4_pin: (form.ipv4_pin ?? "").trim(),
      ipv6_pin: (form.ipv6_pin ?? "").trim(),
      country_pin: (form.country_pin ?? "").trim().toUpperCase(),
    })
    const correction = trafficCorrection(pristine.current, traffic)
    if ([patch.traffic_limit, ...Object.values(correction)].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v < 0))) {
      return toast.error("流量必须是有效的非负数，且不能超出精确计数范围")
    }
    setSaving(true)
    try {
      // The correction belongs to the new reset period, so its day is saved
      // first.
      if (Object.keys(patch).length) {
        await api(`/nodes/${node.id}`, { method: "PUT", body: JSON.stringify(patch) })
      }
      if (Object.keys(correction).length) {
        await api(`/nodes/${node.id}/traffic`, {
          method: "PUT",
          body: JSON.stringify(correction),
        })
      }
      toast.success("节点设置已保存")
      onClose()
      onSaved(patch.group)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        {/* noValidate here and in the other dialogs: save() checks every field.
            The browser's own check would refuse a fractional GB against the
            default step of 1, and cannot point at a field folded inside
            流量校正, so the save button would do nothing. */}
        <form noValidate className="contents" onSubmit={(e) => { e.preventDefault(); save() }}>
          <div className="space-y-6">
            <section className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="名称">
                  <Input maxLength={64} value={form.name} onChange={(e) => set("name", e.target.value)} />
                </Field>
                <Field label="分组" hint="公开页可见，留空为未分组">
                  <GroupInput nodes={nodes} value={form.group ?? ""} onChange={(v) => set("group", v)} />
                </Field>
                <Field label="公开备注">
                  <Input
                    value={form.public_remark ?? ""}
                    onChange={(e) => set("public_remark", e.target.value)}
                    placeholder="公开页可见，最多 100 字"
                  />
                </Field>
                <Field label="私有备注">
                  <Input value={form.remark ?? ""} onChange={(e) => set("remark", e.target.value)} placeholder="仅管理员可见" />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <OptionRow title="公开显示" hint="关闭后只在管理后台可见" toggle>
                  <Switch checked={form.public} onCheckedChange={(v) => set("public", v)} />
                </OptionRow>
                <OptionRow title="离线通知" hint="掉线超过宽限期、恢复时各推一条" toggle>
                  <Switch checked={!!form.notify} onCheckedChange={(v) => set("notify", v)} />
                </OptionRow>
              </div>
            </section>
            <section className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-medium">流量</h3>
              {/* On a phone the two short numbers share a row, the mode takes
                  the next; dense packing restores the order from sm up. */}
              <div className="grid grid-flow-row-dense grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="每月额度 (GB)" hint="留空或 0 不限">
                  <Input type="number" value={limitGib} onChange={(e) => setLimitGib(e.target.value)} placeholder="1024" />
                </Field>
                <Field label="计算方式" className="col-span-2 sm:col-span-1">
                  <Select value={form.traffic_mode} onValueChange={(v) => set("traffic_mode", v)}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper">
                      {Object.entries(TRAFFIC_MODES).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="每月重置日" hint="1–31，改后本月重算，总量不变">
                  <Input type="number" min={1} max={31} value={resetDay} onChange={(e) => setResetDay(e.target.value)} />
                </Field>
              </div>
              <details className="rounded-lg border bg-muted/30 px-3 py-2.5">
                <summary className="cursor-pointer text-sm font-medium">流量校正</summary>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  按 GB 填入需要校正的值，未修改的计数器继续正常累计。
                </p>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  {TRAFFIC_FIELDS.map(([key, label]) => (
                    <Field key={key} label={`${label} (GB)`}>
                      <Input
                        type="number"
                        step="0.001"
                        value={traffic[key]}
                        onChange={(e) => setTraffic((t) => ({ ...t, [key]: e.target.value }))}
                      />
                    </Field>
                  ))}
                </div>
              </details>
            </section>
            <section className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-medium">地址与地区</h3>
              <div className="grid grid-flow-row-dense grid-cols-[1fr_5rem] gap-4 sm:grid-cols-[1fr_1.4fr_6rem]">
                <Field label="IPv4">
                  <Input value={form.ipv4_pin ?? ""} onChange={(e) => set("ipv4_pin", e.target.value)} placeholder={`自动：${automatic(false)}`} />
                </Field>
                <Field label="IPv6" className="col-span-full sm:col-span-1">
                  <Input value={form.ipv6_pin ?? ""} onChange={(e) => set("ipv6_pin", e.target.value)} placeholder={`自动：${automatic(true)}`} />
                </Field>
                <Field label="国家/地区">
                  <Input
                    value={form.country_pin ?? ""}
                    maxLength={2}
                    onChange={(e) => set("country_pin", e.target.value.toUpperCase())}
                    placeholder={`自动：${node.country_auto || "无"}`}
                  />
                </Field>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                留空为自动。国家/地区填两位代码，如 CN；手填的值会一直显示，IP 变了要自己改。
              </p>
            </section>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const CURRENCY_NAMES = new Intl.DisplayNames(["zh-CN"], { type: "currency" })

// The name confirms a code the hub can only check the shape of. DisplayNames
// echoes back a code outside ISO 4217 and throws on anything but three letters,
// which the hub refuses with its own message.
function currencyHint(code: string) {
  try {
    const name = CURRENCY_NAMES.of(code)
    return name === code ? "未知代码，照原样显示" : name
  } catch {
    return undefined
  }
}

export function BillingForm({ node, onClose, onSaved }: {
  node: Node
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(node)
  // Text rather than a number: a numeric state cannot represent an empty field,
  // so clearing it would snap back to 0 mid-entry. Empty means free.
  const [price, setPrice] = useState(node.price > 0 ? String(node.price) : "")
  // Whole years are entered in years, the way a five-year plan is sold.
  const months = cycleMonths(node.billing_cycle)
  const [unit, setUnit] = useState(months === 0 ? "once" : months % 12 ? "months" : "years")
  const [count, setCount] = useState(String(months % 12 ? months : months / 12 || 1))
  const [saving, setSaving] = useState(false)
  const [renewals, setRenewals] = useState(0)
  const set = <K extends keyof Node>(k: K, v: Node[K]) => setForm((f) => ({ ...f, [k]: v }))
  const length = Number(count) * (unit === "years" ? 12 : 1)
  const renewable = unit !== "once" && Number.isInteger(length) && length > 0 && !!form.expires_at

  async function save() {
    // The hub refuses a length out of range and stores a named one by name, so
    // an unchanged length is compared in months, not in spelling.
    const cycle = unit === "once" ? "once" : `${length}m`
    setSaving(true)
    try {
      await api(`/nodes/${node.id}`, {
        method: "PUT",
        body: JSON.stringify(changes(node, {
          price: Math.max(0, Number(price) || 0),
          currency: form.currency,
          billing_cycle: cycleMonths(cycle) === months ? node.billing_cycle : cycle,
          expires_at: form.expires_at || null,
        })),
      })
      toast.success("续费设置已保存")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <form noValidate className="contents" onSubmit={(e) => { e.preventDefault(); save() }}>
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <Field label="价格" hint="留空或 0 为免费">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="免费"
                />
              </Field>
              <Field
                label="货币"
                hint={currencyHint(form.currency.toUpperCase())}
                helpWidth="max-w-72"
                help={
                  <>
                    <p>填三个字母的货币代码，大小写都行。</p>
                    <p>
                      例如：
                      {["美元 USD", "人民币 CNY", "港币 HKD", "新台币 TWD", "欧元 EUR", "日元 JPY"].map((c, i) => (
                        <span key={c}>{i > 0 && "、"}<span className="whitespace-nowrap">{c}</span></span>
                      ))}
                    </p>
                  </>
                }
              >
                {/* Uppercased by CSS: rewriting the value mid-composition would
                    break an input method, and the hub stores it uppercased. */}
                <Input
                  maxLength={3}
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="uppercase"
                  value={form.currency}
                  onChange={(e) => set("currency", e.target.value)}
                  placeholder="USD"
                />
              </Field>
            </div>
            <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
              <Field label="付款周期">
                {/* On a phone the two controls sit under the price and currency columns. */}
                <div className="flex gap-4 sm:gap-2">
                  {unit !== "once" && (
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      aria-label="周期长度"
                      className="w-0 flex-1 sm:w-16 sm:flex-none"
                      value={count}
                      onChange={(e) => setCount(e.target.value)}
                    />
                  )}
                  <Select value={unit} onValueChange={setUnit}>
                    <SelectTrigger className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="months">月</SelectItem>
                      <SelectItem value="years">年</SelectItem>
                      <SelectItem value="once">一次性</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Field>
              <Field
                label="到期时间"
                action={renewable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="-my-1"
                    title="提前续费后点这里，到期时间往后加一个付款周期，保存后生效"
                    onClick={() => {
                      set("expires_at", addMonths(form.expires_at!, length))
                      setRenewals((n) => n + 1)
                    }}
                  >
                    续期
                  </Button>
                )}
              >
                <div className="relative">
                  <Input type="date" value={form.expires_at ?? ""} onChange={(e) => set("expires_at", e.target.value)} />
                  {/* Keyed by the count so that every click replays the animation. */}
                  {renewals > 0 && (
                    <span
                      key={renewals}
                      aria-hidden
                      className="pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 text-sm font-semibold text-primary animate-[renewed_900ms_ease-out_forwards] motion-reduce:hidden"
                    >
                      +1
                    </span>
                  )}
                </div>
              </Field>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
