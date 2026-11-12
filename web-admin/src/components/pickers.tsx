import { useState } from "react"
import { Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import { groupsOf, inGroup, type Node, type PingTask } from "@/lib/api"

// Name, address, country and group: what a node is looked up by, in every node list.
export function searchNodes(nodes: Node[], query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return nodes
  return nodes.filter((n) =>
    [n.name, n.ip, n.ipv4, n.ipv6, n.ipv4_pin, n.ipv6_pin, n.country, n.group].some((v) => v?.toLowerCase().includes(needle)))
}

// A filter naming a group no node carries any more -- renamed, or its last node
// deleted -- falls back to all rather than showing an empty list; so does 未分组
// once no group is left, since the dropdown that would clear it is hidden then.
// Reset rather than masked, so the old filter does not return with a later group
// of the same name.
export function useGroupFilter(nodes: Node[]) {
  const [filter, setFilter] = useState("all")
  const valid = filter === "all"
    || (filter === "none" ? nodes.some((n) => n.group) : nodes.some((n) => n.group === filter.slice(1)))
  if (!valid) setFilter("all")
  return [valid ? filter : "all", setFilter] as const
}

// Offered once some node has a group. 未分组 is where a batch of freshly
// registered machines waits to be assigned one.
export function GroupFilter({ nodes, value, onChange, className = "" }: {
  nodes: Node[]
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  const groups = groupsOf(nodes)
  if (!groups.length) return null
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className} aria-label="按分组筛选"><SelectValue /></SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value="all">全部分组</SelectItem>
        {groups.map((g) => <SelectItem key={g} value={`=${g}`}>{g}</SelectItem>)}
        <SelectItem value="none">未分组</SelectItem>
      </SelectContent>
    </Select>
  )
}

export function NodeSearch({ value, onChange, className = "", placeholder = "名称/地址/地区/分组", label = "搜索节点" }: {
  value: string
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  label?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="pl-8"
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Inside a dialog's form, Enter would otherwise save the dialog.
        onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
      />
    </div>
  )
}

// Ticks items in a searchable list. 全选 and 全不选 act on the rows in view, so a
// search or a filter narrows what they touch: pick a group, then 全选. The
// callers own the search and pass in what it leaves visible.
function Picker<T extends { id: number }>({ visible, chosen, onPick, disabled = false, toolbar, empty, listClass, title, children }: {
  visible: T[]
  chosen: Set<number>
  onPick: (list: T[], on: boolean) => void
  disabled?: boolean
  toolbar: React.ReactNode
  empty: string
  listClass: string
  title: (item: T) => string
  children: (item: T) => React.ReactNode
}) {
  // The unfiltered list's height, held as its floor: in a centred dialog a
  // shrinking list would move the search box out from under the cursor.
  const [listHeight, setListHeight] = useState(0)
  const visibleChosen = visible.filter((n) => chosen.has(n.id)).length
  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        {toolbar}
        <Button type="button" size="sm" variant="ghost" className="px-2.5" disabled={disabled || visibleChosen === visible.length} onClick={() => onPick(visible, true)}>全选</Button>
        <Button type="button" size="sm" variant="ghost" className="px-2.5" disabled={disabled || visibleChosen === 0} onClick={() => onPick(visible, false)}>全不选</Button>
      </div>
      <div
        ref={(el) => { if (el && !listHeight) setListHeight(el.offsetHeight) }}
        // Capped like the height itself, which a min-height would otherwise
        // override once the viewport shrinks.
        style={{ minHeight: listHeight ? `min(${listHeight}px, 16rem, 40dvh)` : undefined }}
        className={`grid max-h-[min(16rem,40dvh)] content-start gap-0.5 overflow-y-auto p-1.5 ${listClass}`}
      >
        {visible.map((item) => (
          <label key={item.id} title={title(item)} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
            <input type="checkbox" checked={chosen.has(item.id)} disabled={disabled} onChange={(e) => onPick([item], e.target.checked)} className="shrink-0 accent-primary" />
            {children(item)}
          </label>
        ))}
        {!visible.length && <p className="col-span-full p-2 text-xs text-muted-foreground">{empty}</p>}
      </div>
    </div>
  )
}

// Offline nodes are dimmed but remain selectable.
export function NodePicker({ nodes, chosen, onPick, disabled = false }: {
  nodes: Node[]
  chosen: Set<number>
  onPick: (list: Node[], on: boolean) => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState("")
  const [group, setGroup] = useGroupFilter(nodes)
  return (
    <Picker
      visible={inGroup(searchNodes(nodes, query), group)}
      chosen={chosen}
      onPick={onPick}
      disabled={disabled}
      toolbar={<>
        <NodeSearch className="min-w-0 flex-1 basis-40" value={query} onChange={setQuery} />
        <GroupFilter nodes={nodes} value={group} onChange={setGroup} className="w-32" />
      </>}
      empty={nodes.length ? "没有匹配的节点" : "先添加节点"}
      // Three columns keep a few dozen nodes within one scroll. A phone gets
      // one: two cut a name to a few characters, and a tap shows no title.
      listClass="grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-3"
      title={(n) => (n.group ? `${n.name} · ${n.group}` : n.name)}
    >
      {(n) => <>
        <span className={`truncate ${n.online ? "" : "text-muted-foreground"}`}>{n.name}</span>
        {n.country && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{n.country}</span>}
      </>}
    </Picker>
  )
}

// One probe per row, with the target and interval that tell two of a name apart.
export function ProbePicker({ tasks, chosen, onPick }: {
  tasks: PingTask[]
  chosen: Set<number>
  onPick: (list: PingTask[], on: boolean) => void
}) {
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  return (
    <Picker
      visible={needle ? tasks.filter((t) => `${t.name} ${t.target}`.toLowerCase().includes(needle)) : tasks}
      chosen={chosen}
      onPick={onPick}
      toolbar={<NodeSearch className="min-w-0 flex-1 basis-32" value={query} onChange={setQuery} placeholder="名称/目标" label="搜索监控" />}
      empty={tasks.length ? "没有匹配的监控" : "还没有延迟监控，先点「添加监控」"}
      listClass="grid-cols-1"
      title={(t) => `${t.name} · ${t.target}`}
    >
      {(t) => <>
        <span className="min-w-0 flex-1 truncate">{t.name}</span>
        <span className="tnum max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{t.target}</span>
        <span className="tnum w-12 shrink-0 text-right text-xs text-muted-foreground">{t.interval}s</span>
      </>}
    </Picker>
  )
}

// Width in ems, near enough: a CJK character is one, anything else about half.
const ems = (word: string) => [...word].reduce((n, c) => n + (c > "\u2e7f" ? 1 : 0.55), 0)

// A node name, broken at its spaces and after the dots of a hostname --
// registered nodes are named after theirs. A word up to eight ems stays whole,
// a city, a label or a hyphenated one such as GIA-E, where the browser would
// leave its last letter to open the next line. A wider word, as a name typed
// without spaces usually is, breaks between its CJK characters, and a run of
// letters only where nothing else fits: kept whole, it would set the column's
// minimum width and push the table past the screen. A separator such as the ·
// in 香港 09 · DMIT, or a dash, is held to the word before it, so no line opens
// with one.
export function nameText(name: string) {
  return name
    .replace(/ (?=[·|/｜—–-] )/g, "\u00a0")
    .split(/( )/)
    .map((word, i) => {
      const parts = word.split(".").flatMap((part, j) => (j ? [".", <wbr key={j} />, part] : [part]))
      if (ems(word) > 8) return <span key={i} className="wrap-anywhere [word-break:normal]">{parts}</span>
      return word.includes("-") ? <span key={i} className="whitespace-nowrap">{word}</span> : parts
    })
}
