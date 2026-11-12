import { memo, useEffect, useRef, useState } from "react"
import { ArrowDownAZ, CalendarClock, Copy, Download, Layers, Pencil, Plus, Server, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { Command, ConfirmDialog, copy, Segments } from "@/components/common"
import { DragHandle, useDragOrder } from "@/components/drag"
import { GroupFilter, nameText, NodeSearch, searchNodes, useGroupFilter } from "@/components/pickers"
import { api, byName, groupsOf, inGroup, type Node, shortAddress, type Source } from "@/lib/api"
import { uninstallCommand } from "@/lib/commands"
import { bytes, FOREVER, money, uptime } from "@/lib/format"
import { useSettings } from "@/lib/settings"
import { InstallDialog, RegisterDialog, useRegisterWindow } from "@/pages/Install"
import { BillingForm, CreateNode, GroupDialog, NodeForm } from "@/pages/NodeDialogs"

const SOURCES: Record<Source, string> = {
  manual: "手动填写",
  interface: "网卡地址",
  exit: "hub 看到的出口，不在节点网卡上（NAT 或代理）",
  connection: "hub 看到的连接地址",
}

// The address a node is reached by, one per family, each click-to-copy: pasting
// one into an ssh command is why they are shown. Where each came from is in the
// tooltip, keeping the column to addresses alone.
//
// Drawn again only when the addresses change. The table re-renders on every
// push, and redrawing a tooltip per address would raise the panel's script time
// at a hundred nodes from 66 to 128 ms a second.
const Addresses = memo(
  function Addresses({ list }: { list: NonNullable<Node["addresses"]> }) {
    if (!list.length) return <span className="text-sm text-muted-foreground">—</span>
    return (
      // As wide as the longer address, so both tooltips open from one right
      // edge and the one for a short IPv4 does not cover the IPv6 below it.
      <div className="grid w-fit gap-y-0.5">
        {list.map(({ address, source }) => (
          // Beside the addresses rather than under one, where it would cover
          // the other; and gone once the pointer leaves it.
          <Tooltip key={address} disableHoverableContent>
            <TooltipTrigger asChild>
              <button
                type="button"
                // The toast names what was copied: a tap shows no tooltip, and
                // the cell may show the address shortened.
                onClick={() => copy(address, `已复制 ${address}`)}
                aria-label={`复制 ${address}`}
                className="tnum group inline-flex items-center gap-1 text-sm hover:text-foreground"
              >
                {shortAddress(address)}
                <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6} className="max-w-xs">
              <div className="tnum">{address}</div>
              <div className="opacity-70">{SOURCES[source]}，点击复制</div>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    )
  },
  // Rows arrive as fresh objects on every push, so the list is compared by value.
  (a, b) => JSON.stringify(a.list) === JSON.stringify(b.list),
)

// Quick filters over the node list, each gathering the rows already marked for
// it: the traffic tint, and the window the expiry reminder covers plus any date
// already past, which needs renewing all the more.
const ATTENTION: [key: string, label: string, test: (n: Node, warnAt: number, expiryDays: number) => boolean][] = [
  ["offline", "离线", (n) => !n.online],
  ["traffic", "流量预警", (n, warnAt) => trafficTone(n, warnAt) !== ""],
  ["expiring", "即将到期", (n, _, days) => n.expires_in !== null && n.expires_in <= days],
  ["private", "不公开", (n) => !n.public],
]

// Traffic turns a subdued orange at the alert threshold and a subdued red once
// the allowance is used up, so the table agrees with the alerts. With alerts
// off, the threshold's default of 80 % still marks a node running short.
function trafficTone(n: Node, warnAt: number) {
  if (n.traffic_limit <= 0) return ""
  if (n.month_used >= n.traffic_limit) return "text-over"
  return n.month_used * 100 >= n.traffic_limit * warnAt ? "text-near" : ""
}

export function Nodes({ nodes, refresh, site, refusal }: { nodes: Node[]; refresh: () => void; site: string; refusal: string }) {
  const settings = useSettings(true).s
  const warnAt = Number(settings?.notify_traffic) || 80
  const expiryDays = Number(settings?.notify_expiry) || 7
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Node | null>(null)
  const [billing, setBilling] = useState<Node | null>(null)
  const [installing, setInstalling] = useState<Node | null>(null)
  const [registering, setRegistering] = useState(false)
  const reg = useRegisterWindow()
  const [deleting, setDeleting] = useState<Node | null>(null)
  const [removing, setRemoving] = useState(false)
  const [query, setQuery] = useState("")
  const [group, setGroup] = useGroupFilter(nodes)
  const [status, setStatus] = useState("all")
  const [grouping, setGrouping] = useState(false)
  const [sorting, setSorting] = useState(false)
  // A row to bring into view once the list shows it: a new node, which lands
  // first while the list may be scrolled far down; or one that joined a group,
  // which the hub moved to the group's rows, once the list carries the move. A
  // filter hiding it cancels the scroll rather than leaving one to fire when it
  // is cleared.
  const reveal = useRef<{ id: number; group?: string } | null>(null)
  const drag = useDragOrder(nodes, "nodes", refresh)
  // For an undo pressed long after the render that offered it.
  const latest = useRef(drag.order)
  useEffect(() => { latest.current = drag.order })
  // Counted within the search and the group, so each count is what its filter
  // would then show.
  const found = inGroup(searchNodes(drag.order, query), group)
  const attention = ATTENTION.map(([key, label, test]) => ({ key, label, rows: found.filter((n) => test(n, warnAt, expiryDays)) }))
  const picked = attention.find((a) => a.key === status)
  const showChips = status !== "all" || ATTENTION.some(([, , test]) => nodes.some((n) => test(n, warnAt, expiryDays)))
  const chips = attention
    .filter((a) => a.key === status || a.rows.length)
    .map((a) => ({ key: a.key, label: <>{a.label} <span className="tnum ml-0.5 text-xs font-normal text-muted-foreground">{a.rows.length}</span></> }))
  const visible = picked?.rows ?? found
  useEffect(() => {
    if (!reveal.current) return
    const { id, group: joined } = reveal.current
    const node = nodes.find((n) => n.id === id)
    if (!node || (joined !== undefined && node.group !== joined)) return
    document.querySelector(`tbody tr[data-id="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
    reveal.current = null
  })
  const searching = query.trim() !== "" || group !== "all" || status !== "all"

  // The columns as the whole list lays them out, taken as a search or a filter
  // begins, while that list is still on screen. The narrowed table is laid out
  // by these shares, so the columns stay where they were rather than refit the
  // rows left. Shares rather than pixels, so it still follows the window.
  const head = useRef<HTMLTableRowElement>(null)
  const [layout, setLayout] = useState<{ width: number; shares: number[] } | null>(null)
  function narrow<T>(set: (v: T) => void) {
    return (v: T) => {
      const row = head.current
      if (!searching && row) {
        const width = row.getBoundingClientRect().width
        setLayout({ width, shares: [...row.cells].map((c) => c.getBoundingClientRect().width / width) })
      }
      set(v)
    }
  }
  const frozen = searching ? layout : null
  // A new width lays the page out afresh: the shares were taken at another, and
  // the narrowed rows are left to size the columns. A phone's address bar
  // collapsing resizes only the height.
  useEffect(() => {
    if (!frozen) return
    const width = innerWidth
    const thaw = () => innerWidth !== width && setLayout(null)
    addEventListener("resize", thaw)
    return () => removeEventListener("resize", thaw)
  }, [frozen])
  const col = (i: number) => frozen?.shares[i] ? { width: `${frozen.shares[i] * 100}%` } : undefined
  const uninstall = refusal ? "" : uninstallCommand(site)

  // Under a filter the rows on screen are not the order, so a handle cannot
  // move one. A press says why and offers the way out, which a disabled
  // button would not: it takes no press, and a touch screen shows no title.
  const locked = {
    onPointerDown: (e: React.PointerEvent) => e.button === 0 && hintLocked(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
      e.preventDefault()
      hintLocked()
    },
  }
  function hintLocked() {
    toast("筛选时不能拖动排序", {
      id: "drag-locked",
      action: { label: "清除筛选", onClick: () => { scrollTo(0, 0); setQuery(""); setGroup("all"); setStatus("all") } },
    })
  }

  function followGroup(id: number, group?: string) {
    if (group) reveal.current = { id, group }
    refresh()
  }

  // Confirmed first, since it replaces an order that may have taken many
  // drags; the toast then keeps an undo long enough to think it over.
  async function sortByName() {
    setSorting(false)
    const rows = head.current!.closest("table")!.tBodies[0]
    const before = drag.order.map((n) => n.id)
    if (!await drag.arrange(byName(drag.order).map((n) => n.id), rows)) return
    // Against the list as it is by then, which the hub requires in full: a node
    // added since goes first, where the hub placed it.
    const undo = () => {
      const now = latest.current.map((n) => n.id)
      drag.arrange([...now.filter((id) => !before.includes(id)), ...before.filter((id) => now.includes(id))], rows)
    }
    toast.success("已按名称排序", { duration: 15_000, action: { label: "撤销", onClick: undo } })
  }

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/nodes/${deleting.id}`, { method: "DELETE" })
      toast.success("已删除")
      setDeleting(null)
      refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="space-y-4">
      {refusal && <p className="text-sm text-muted-foreground">{refusal}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className={`mr-auto flex w-full gap-2 sm:w-auto ${showChips ? "xl:mr-0" : ""}`}>
          <NodeSearch className="min-w-0 flex-1 sm:w-64 sm:flex-none xl:w-48" value={query} onChange={narrow(setQuery)} />
          <GroupFilter nodes={nodes} value={group} onChange={narrow(setGroup)} className="w-32" />
        </div>
        {/* In the toolbar from xl up, so a filter appearing does not move the
            table. A filter with nothing to show is left out unless picked: the
            row then reads at a glance whether anything needs attention. Picked,
            it stays when its count drops to zero, so the list does not change
            under the reader. The slot is decided on the whole list, so searching
            or switching group does not move the toolbar or the table. */}
        {showChips && (
          <div className="order-last min-h-8 w-full xl:order-none xl:mr-auto xl:w-auto">
            {chips.length > 0 && <Segments label="按状态筛选" value={status} onPick={(key) => narrow(setStatus)(status === key ? "all" : key)} options={chips} />}
          </div>
        )}
        <Button variant="outline" disabled={!nodes.length} onClick={() => setGrouping(true)}>
          <Layers /> 分组
        </Button>
        {/* An open window is visible from the list itself, so nobody has to
            remember they left one open. */}
        <Button variant="outline" disabled={!!refusal} onClick={() => { reg.sync(); setRegistering(true) }}>
          <Server /> 批量添加{reg.left > 0 && ` · ${Math.ceil(reg.left / 60)} 分`}
        </Button>
        <Button disabled={!!refusal} onClick={() => setCreating(true)}>
          <Plus /> 添加节点
        </Button>
      </div>

      <Card className="overflow-x-auto p-0">
        <Table className={frozen ? "table-fixed" : ""} style={frozen ? { minWidth: frozen.width } : undefined}>
          <TableHeader>
            {/* Percentages, or the address column swallows every spare pixel
                and pushes status across the table. */}
            <TableRow ref={head}>
              <TableHead className="w-[26%]" style={col(0)}>
                {nodes.length > 1 ? (
                  <button
                    type="button"
                    className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    title={groupsOf(nodes).length ? "按分组名、再按名称排序" : "按名称排序"}
                    onClick={() => {
                      const ids = drag.order.map((n) => n.id).join()
                      if (byName(drag.order).map((n) => n.id).join() === ids) toast("已经是按名称排的顺序")
                      else setSorting(true)
                    }}
                  >
                    名称 <ArrowDownAZ className="size-3.5" />
                  </button>
                ) : (
                  "名称"
                )}
              </TableHead>
              <TableHead className="w-[18%]" style={col(1)}>IP</TableHead>
              <TableHead className="w-[12%]" style={col(2)}>状态</TableHead>
              <TableHead className="w-[16%]" style={col(3)}>流量</TableHead>
              {/* Below xl the expiry date moves under the price: seven
                  columns leave a 1024px window no room for names. */}
              <TableHead className="w-[10%]" style={col(4)}>价格<span className="xl:hidden"> / 到期</span></TableHead>
              <TableHead className="hidden w-[12%] xl:table-cell" style={col(5)}>到期</TableHead>
              <TableHead className="text-right" style={col(6)}>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((n) => (
              <TableRow key={n.id} {...drag.row(n.id)}>
                {/* Wraps: under the cell's default nowrap, one long name would
                    widen the table until the actions left the screen. */}
                <TableCell className="whitespace-normal">
                  <div className="flex items-center gap-2">
                    <DragHandle
                      {...(searching ? locked : drag.handle(n.id))}
                      name={n.name}
                      disabled={searching}
                      title={searching ? "清空搜索和筛选后可拖动排序" : undefined}
                    />
                    <div className="min-w-24">
                      {/* Lines are balanced, so none ends on a character or two. */}
                      <div className="font-medium text-balance break-keep">
                        {nameText(n.name)}
                        {/* In the name's flow, a fixed gap after its last word.
                            Beside the block it would sit at the cell's edge
                            whenever the name or group wraps, since a wrapped
                            block spans the whole width. The gap is a figure
                            space, which does not break: the badge moves down
                            with the last word rather than open a line alone. */}
                        {n.country && "\u2007"}
                        {n.country && (
                          <Badge
                            variant="outline"
                            title={n.country_pin ? "手动指定" : undefined}
                            className="align-middle font-normal text-muted-foreground"
                          >
                            {n.country}
                          </Badge>
                        )}
                      </div>
                      {n.group && <div className="text-xs text-balance text-muted-foreground">{n.group}</div>}
                    </div>
                  </div>
                </TableCell>
                {/* Addresses live only here, never on the public page. */}
                <TableCell>
                  <Addresses list={n.addresses ?? []} />
                </TableCell>
                <TableCell>
                  {/* Stacked and centred on one axis. The slot is as wide as
                      the three-character 不公开, so a lone pill sits where it
                      would above that one and every row lines up. */}
                  <div className="flex w-fit min-w-14 flex-col items-center gap-1">
                    <Badge variant={n.online ? "default" : "secondary"} className="font-normal">
                      {n.online ? "在线" : "离线"}
                    </Badge>
                    {!n.public && <Badge variant="outline" className="font-normal">不公开</Badge>}
                    {/* Under the badge, not inside it: the column is a tenth of
                        the table and the three do not share one line. A slot of
                        the pills' width that the text spills out of evenly, so a
                        long duration does not widen the slot and move the
                        pills off the axis the other rows share. */}
                    {!n.online && n.last_seen_ago !== null && n.last_seen_ago >= 60 && (
                      <div className="flex w-14 justify-center">
                        <span className="tnum text-xs whitespace-nowrap text-muted-foreground">
                          {uptime(n.last_seen_ago)}
                        </span>
                      </div>
                    )}
                  </div>
                </TableCell>
                {/* Counted by the node's own billing rule, as on the public
                    page. Two unbreakable halves, so a narrow table moves the
                    limit to a second line rather than splitting a figure. */}
                <TableCell className="tnum text-sm whitespace-normal">
                  <span className={`whitespace-nowrap ${trafficTone(n, warnAt)}`}>
                    {bytes(n.month_used)}
                  </span>{" "}
                  <span className="whitespace-nowrap text-muted-foreground">
                    / {n.traffic_limit > 0 ? bytes(n.traffic_limit) : FOREVER}
                  </span>
                </TableCell>
                <TableCell className="tnum text-sm">
                  {n.price > 0 ? money(n.price, n.currency) : "免费"}
                  <div className="text-xs text-muted-foreground xl:hidden">{n.expires_at || FOREVER}</div>
                </TableCell>
                <TableCell className="hidden text-sm xl:table-cell">{n.expires_at || FOREVER}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button variant="ghost" size="icon" disabled={!!refusal} onClick={() => setInstalling(n)} title="安装 Agent" aria-label="安装 Agent">
                    <Download />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setEditing(n)} title="编辑节点" aria-label="编辑节点">
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setBilling(n)} title="续费设置" aria-label="续费设置">
                    <CalendarClock />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(n)} title="删除节点" aria-label="删除节点">
                    <Trash2 className="text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {/* Below the table rather than a row spanning it: below xl the span
            would count the hidden expiry column and add a column of its own. */}
        {!visible.length && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {!nodes.length ? "还没有节点，右上角添加" : picked && found.length ? `当前没有${picked.label}的节点` : "没有匹配的节点"}
          </p>
        )}
      </Card>

      {creating && (
        <CreateNode
          onClose={() => setCreating(false)}
          onSaved={(id) => { reveal.current = { id }; refresh() }}
        />
      )}
      {editing && (
        <NodeForm
          node={editing}
          nodes={nodes}
          onClose={() => setEditing(null)}
          onSaved={(group) => followGroup(editing.id, group)}
        />
      )}
      {sorting && (
        <ConfirmDialog
          title="按名称重新排序？"
          description={`全部 ${nodes.length} 台节点将${groupsOf(nodes).length ? "先按分组名、组内再按名称" : "按名称"}重排${groupsOf(nodes).length ? "，未分组的排在最后" : ""}。当前的顺序会被替换，公开页同步变化；排序后 15 秒内可在提示里撤销。`}
          confirmLabel="排序"
          onClose={() => setSorting(false)}
          onConfirm={sortByName}
        />
      )}
      {grouping && <GroupDialog nodes={drag.order} onClose={() => setGrouping(false)} onSaved={followGroup} />}
      {billing && (
        <BillingForm node={billing} onClose={() => setBilling(null)} onSaved={refresh} />
      )}
      {registering && <RegisterDialog site={site} reg={reg} onClose={() => { setRegistering(false); refresh() }} />}

      {installing && (
        <InstallDialog
          node={installing}
          site={site}
          onClose={() => setInstalling(null)}
          onRotated={refresh}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`删除节点「${deleting.name}」？`}
          description="历史指标、流量记录和凭证一并删除，不可恢复。"
          confirmLabel="删除节点"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        >
          {/* Deleting the node leaves the agent running on the machine, retrying
              with a token the hub no longer accepts. */}
          {uninstall && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm font-medium">卸载 agent</Label>
                <Button variant="ghost" size="sm" onClick={() => copy(uninstall)}>
                  <Copy className="size-4" /> 复制
                </Button>
              </div>
              <Command>{uninstall}</Command>
              <p className="text-xs text-muted-foreground">
                在这台机器上以 root 执行，停止 agent，删除二进制、env 文件和服务文件。
              </p>
            </div>
          )}
        </ConfirmDialog>
      )}
    </div>
  )
}
