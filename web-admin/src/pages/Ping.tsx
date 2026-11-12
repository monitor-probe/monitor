import { useEffect, useRef, useState } from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

import { ConfirmDialog, Field, OptionRow, Segments } from "@/components/common"
import { DragHandle, useDragOrder } from "@/components/drag"
import { GroupFilter, nameText, NodePicker, NodeSearch, ProbePicker, searchNodes, useGroupFilter } from "@/components/pickers"
import { api, inGroup, type Node, type PingTask } from "@/lib/api"

function PingForm({ task, nodes, onClose, onSaved }: {
  task: Partial<PingTask>
  nodes: Node[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(task)
  // Text until saved, so the box can be emptied and retyped.
  const [every, setEvery] = useState(String(task.interval ?? 60))
  const [saving, setSaving] = useState(false)
  // The assignments as the hub holds them, as far as this dialog can tell: those
  // loaded, plus any node that registers while it is open, which an auto_join
  // probe takes at once. Shown ticked, so unticking one removes it.
  const base = useRef(task.nodes ?? [])
  const seen = useRef(new Set(nodes.map((n) => n.id)))
  useEffect(() => {
    const fresh = nodes.filter((n) => !seen.current.has(n.id)).map((n) => n.id)
    for (const id of fresh) seen.current.add(id)
    if (!task.auto_join || !fresh.length) return
    base.current = [...base.current, ...fresh]
    setForm((f) => ({ ...f, nodes: [...(f.nodes ?? []), ...fresh] }))
  }, [nodes, task.auto_join])
  const chosen = new Set(form.nodes)
  // Counted against the live list: `form.nodes` can still name a node deleted
  // since the probes were loaded.
  const chosenCount = nodes.filter((n) => chosen.has(n.id)).length

  const pick = (list: Node[], on: boolean) =>
    setForm((f) => {
      const next = new Set(f.nodes)
      for (const n of list) {
        if (on) next.add(n.id)
        else next.delete(n.id)
      }
      return { ...f, nodes: [...next] }
    })

  async function save() {
    if (!form.name?.trim() || !form.target?.trim()) return toast.error("请填写名称和目标")
    const interval = Number(every)
    if (!Number.isInteger(interval) || interval < 5 || interval > 3600) return toast.error("间隔要填 5–3600 之间的整数秒")
    setSaving(true)
    try {
      // `base` limits the save to what was ticked or unticked here; a node that
      // joined through auto_join while the dialog was open keeps its assignment.
      const body = { ...form, interval, ...(task.id ? { base: base.current } : {}) }
      await api("/ping-tasks", { method: "POST", body: JSON.stringify(body) })
      toast.success("已保存，正在下发")
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
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{task.id ? "编辑监控" : "添加监控"}</DialogTitle>
        </DialogHeader>
        <form noValidate className="contents" onSubmit={(e) => { e.preventDefault(); save() }}>
          <div className="space-y-6">
            {/* On a phone the name takes the first row and the target shares the
                second with the interval, so the tab order matches the screen. */}
            <section className="grid grid-cols-[1fr_6rem] gap-4 sm:grid-cols-[1fr_1.4fr_6rem]">
              <Field label="名称" className="col-span-full sm:col-span-1">
                {/* A new monitor starts empty, so the cursor belongs here;
                    editing an existing one starts with nothing selected. */}
                <Input autoFocus={!task.id} maxLength={64} value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Cloudflare" />
              </Field>
              <Field label="目标地址" hint="host:port，每个节点各自 TCP 连接">
                <Input value={form.target ?? ""} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="1.1.1.1:443" />
              </Field>
              <Field label="间隔（秒）" hint="5–3600">
                <Input type="number" min="5" max="3600" value={every} onChange={(e) => setEvery(e.target.value)} />
              </Field>
            </section>
            <section className="space-y-3 border-t pt-5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">运行节点</h3>
                <span className="tnum text-xs text-muted-foreground">已选 {chosenCount} / {nodes.length}</span>
              </div>
              <NodePicker nodes={nodes} chosen={chosen} onPick={pick} />
              <OptionRow title="新节点自动加入" hint="以后添加的节点自动运行此监控" toggle>
                <Switch checked={!!form.auto_join} onCheckedChange={(v) => setForm({ ...form, auto_join: v })} />
              </OptionRow>
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

// One node's probes, ticked from the node's side. Saves only what changed from
// the list it opened with, as PingForm does for a probe's nodes.
function NodeProbesForm({ node, tasks, onClose, onSaved }: {
  node: Node
  tasks: PingTask[]
  onClose: () => void
  onSaved: () => void
}) {
  const [base] = useState(() => tasks.filter((t) => t.nodes.includes(node.id)).map((t) => t.id))
  const [chosen, setChosen] = useState(() => new Set(base))
  const [saving, setSaving] = useState(false)
  // Taken from the live list: `chosen` can still hold a probe deleted since the
  // dialog opened, which the list no longer shows to untick.
  const ticked = tasks.filter((t) => chosen.has(t.id)).map((t) => t.id)

  const pick = (list: PingTask[], on: boolean) =>
    setChosen((c) => {
      const next = new Set(c)
      for (const t of list) {
        if (on) next.add(t.id)
        else next.delete(t.id)
      }
      return next
    })

  async function save() {
    setSaving(true)
    try {
      await api(`/nodes/${node.id}/ping-tasks`, { method: "PUT", body: JSON.stringify({ tasks: ticked, base }) })
      toast.success("已保存，正在下发")
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
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="break-all">「{node.name}」的延迟监控</DialogTitle>
        </DialogHeader>
        <form noValidate className="contents" onSubmit={(e) => { e.preventDefault(); save() }}>
          {/* min-w-0: as a grid item the list would otherwise grow to its
              widest target and push the dialog past a phone's edge. */}
          <section className="min-w-0 space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">运行的监控</h3>
              <span className="tnum text-xs text-muted-foreground">已选 {ticked.length} / {tasks.length}</span>
            </div>
            <ProbePicker tasks={tasks} chosen={chosen} onPick={pick} />
          </section>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// The probes seen from the nodes: one row per node, so a machine's whole set is
// read and edited in one place.
function PingByNode({ nodes, tasks, reload }: { nodes: Node[]; tasks: PingTask[]; reload: () => void }) {
  const [query, setQuery] = useState("")
  const [group, setGroup] = useGroupFilter(nodes)
  const [editing, setEditing] = useState<Node | null>(null)
  const visible = inGroup(searchNodes(nodes, query), group)
  const owned = new Map(nodes.map((n) => [n.id, [] as PingTask[]]))
  for (const t of tasks) for (const id of t.nodes) owned.get(id)?.push(t)

  return (
    <>
      <div className="flex gap-2">
        <NodeSearch className="min-w-0 flex-1 sm:w-64 sm:flex-none" value={query} onChange={setQuery} />
        <GroupFilter nodes={nodes} value={group} onChange={setGroup} className="w-32" />
      </div>
      <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[30%]">节点</TableHead>
              <TableHead>监控</TableHead>
              {/* Sized for its one button, which an empty list would not hold. */}
              <TableHead className="w-13 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((n) => {
              const mine = owned.get(n.id) ?? []
              const names = mine.map((t) => t.name).join("、")
              return (
                <TableRow key={n.id}>
                  <TableCell className="whitespace-normal">
                    <div className="font-medium text-balance break-keep">{nameText(n.name)}</div>
                    {n.group && <div className="text-xs text-balance text-muted-foreground">{n.group}</div>}
                  </TableCell>
                  {/* max-w-0 lets the cell take what is left and no more, so a
                      long list truncates instead of widening the table. */}
                  <TableCell className="max-w-0 text-sm">
                    {mine.length ? (
                      <div className="truncate" title={names}>
                        <span className="tnum">{mine.length} 个</span>
                        <span className="text-muted-foreground"> · {names}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">未配置</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => setEditing(n)} title="选择监控" aria-label="选择监控"><Pencil /></Button>
                  </TableCell>
                </TableRow>
              )
            })}
            {!visible.length && (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center text-sm text-muted-foreground">
                  {nodes.length ? "没有匹配的节点" : "还没有节点"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      {editing && <NodeProbesForm node={editing} tasks={tasks} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  )
}

export function Ping({ nodes }: { nodes: Node[] }) {
  // null until loaded, so the empty state does not flash before the list.
  const [tasks, setTasks] = useState<PingTask[] | null>(null)
  const [editing, setEditing] = useState<Partial<PingTask> | null>(null)
  const [deleting, setDeleting] = useState<PingTask | null>(null)
  const [removing, setRemoving] = useState(false)
  const [view, setView] = useState<"task" | "node">("task")

  // A failed first load draws the page empty, keeping 添加监控 in reach.
  const load = () =>
    api<{ tasks: PingTask[] }>("/ping-tasks")
      .then((d) => setTasks(d.tasks))
      .catch((e: Error) => {
        toast.error(e.message)
        setTasks((tasks) => tasks ?? [])
      })
  // A node added or removed changes assignments on the hub: auto_join adds, a
  // deletion cascades.
  useEffect(() => { load() }, [nodes.length])
  // Unfiltered, so the handles are never disabled.
  const drag = useDragOrder(tasks ?? [], "ping-tasks", load)

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/ping-tasks/${deleting.id}`, { method: "DELETE" })
      toast.success("监控已删除")
      setDeleting(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  if (!tasks) return null
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Segments
          label="视图"
          value={view}
          onPick={setView}
          options={[{ key: "task", label: "按监控" }, { key: "node", label: "按节点" }]}
        />
        <Button onClick={() => setEditing({ name: "", target: "", interval: 60, nodes: nodes.map((n) => n.id), auto_join: true })}>
          <Plus /> 添加监控
        </Button>
      </div>

      {view === "node" ? <PingByNode nodes={nodes} tasks={tasks} reload={load} /> : <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[22%]">名称</TableHead>
              <TableHead className="w-[34%]">目标</TableHead>
              <TableHead className="w-[10%]">间隔</TableHead>
              <TableHead className="w-[22%]">节点</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drag.order.map((t) => (
              <TableRow key={t.id} {...drag.row(t.id)}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <DragHandle {...drag.handle(t.id)} name={t.name} />
                    {t.name}
                  </div>
                </TableCell>
                <TableCell className="tnum text-sm">{t.target}</TableCell>
                <TableCell className="tnum text-sm">{t.interval}s</TableCell>
                <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                  {t.nodes.length > 0 && t.nodes.length === nodes.length ? "全部" : `${t.nodes.length} 个`}
                  {t.auto_join && <Badge variant="outline" className="ml-2 font-normal">自动加入</Badge>}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(t)} title="编辑监控" aria-label="编辑监控"><Pencil /></Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(t)} title="删除监控" aria-label="删除监控">
                    <Trash2 className="text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {tasks.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  还没有延迟监控。每个节点独立 TCP 连接目标端口并上报耗时。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>}

      {editing && <PingForm task={editing} nodes={nodes} onClose={() => setEditing(null)} onSaved={load} />}
      {deleting && (
        <ConfirmDialog
          title={`删除监控「${deleting.name}」？`}
          description="该监控及其历史延迟记录一并删除，不可恢复。"
          confirmLabel="删除监控"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  )
}
