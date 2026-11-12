import { useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { GripVertical } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"

// Displaced rows slide from where they were drawn to their new place: each is
// offset back by the distance it moved, then released. Transforms leave layout
// and stacking alone, so hit-testing mid-slide reads layout positions and the
// sticky header stays on top. A slide cut short restarts from where it was drawn.
function slide(rows: HTMLTableSectionElement | null, update: () => void) {
  const before = new Map([...(rows?.rows ?? [])].map((row) => [row, row.getBoundingClientRect().top]))
  for (const row of before.keys()) row.getAnimations().forEach((a) => a.id === "slide" && a.cancel())
  flushSync(update)
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
  for (const [row, top] of before) {
    const dy = top - row.getBoundingClientRect().top
    if (dy) row.animate({ transform: [`translateY(${dy}px)`, "none"] }, { id: "slide", duration: 150, easing: "ease-out" })
  }
}

// Drag-to-reorder for a table whose order the hub stores at `/${path}/order`.
// Rows are displaced while the pointer is down and the whole order is saved on
// release, so a filtered table must disable its handles: the rows on screen are
// then not `order`.
//
// Pointer events, not HTML5 drag and drop: a touch never starts a native drag,
// and where Android synthesizes one from a long press, `dropEffect` reads
// "none" on every release, so each drop would count as cancelled.
export function useDragOrder<T extends { id: number }>(items: T[], path: string, reload: () => void) {
  const [manualOrder, setManualOrder] = useState<number[]>([])
  const [dragging, setDragging] = useState<number | null>(null)
  const orderBeforeDrag = useRef<number[]>([])
  const body = useRef<HTMLTableSectionElement | null>(null)
  // The pointer that owns the drag, where it was pressed, and where it last
  // was: a scroll moves rows under a pointer that holds still.
  const pointer = useRef({ id: 0, x: 0, y: 0, y0: 0 })
  // One save in flight at a time, so two quick reorders reach the hub in order.
  const saving = useRef<Promise<unknown>>(Promise.resolve())
  const byId = new Map(items.map((item) => [item.id, item]))
  const orderedIds = new Set(manualOrder)
  const order = [
    ...manualOrder.map((id) => byId.get(id)).filter((item): item is T => Boolean(item)),
    ...items.filter((item) => !orderedIds.has(item.id)),
  ]
  const ids = () => order.map((item) => item.id)

  // Once the hub lists this order, its list is followed again, so a reorder made
  // in another tab appears here instead of being overwritten by the next drag.
  // Rows added or deleted meanwhile do not count: the hub's list places them.
  if (dragging === null && manualOrder.length
    && manualOrder.filter((id) => byId.has(id)).join() === items.filter((item) => orderedIds.has(item.id)).map((item) => item.id).join()) {
    setManualOrder([])
  }

  function move(id: number, to: number) {
    const next = [...ids()]
    const from = next.indexOf(id)
    if (from < 0 || to < 0 || to >= next.length || from === to) return
    next.splice(to, 0, ...next.splice(from, 1))
    slide(body.current, () => setManualOrder(next))
    return next
  }

  // Dropped outside the table or cancelled with Escape: the order is restored.
  function cancel() {
    setDragging(null)
    const before = orderBeforeDrag.current
    if (before.length) slide(body.current, () => setManualOrder(before))
  }

  function save(next: number[]) {
    setDragging(null)
    const before = orderBeforeDrag.current
    if (!before.length || next.join() === before.join()) return
    commit(next)
  }

  // The whole order at once, as sorting it or undoing a sort sets it.
  function arrange(next: number[], rows: HTMLTableSectionElement | null) {
    slide(rows, () => setManualOrder(next))
    return commit(next)
  }

  function commit(next: number[]) {
    orderBeforeDrag.current = next
    const put = () => api(`/${path}/order`, { method: "PUT", body: JSON.stringify({ ids: next }) })
    // A refusal falls back to whatever the hub holds, which a save queued
    // behind it may still change.
    const saved = saving.current.then(put).then(() => {
      reload()
      return true
    }, (e: Error) => {
      setManualOrder([])
      reload()
      toast.error(e.message)
      return false
    })
    saving.current = saved
    return saved
  }

  // Handled on the document by layout position, not by the row under the
  // pointer: a sliding row is drawn away from its place, and the one under the
  // pointer mid-slide is not the one it would displace. Re-attached on every
  // render, since `order` changes as rows are displaced.
  useEffect(() => {
    const rows = body.current
    if (dragging === null || !rows) return
    const p = pointer.current
    // The header row counts as inside: a drag to the top readily overshoots
    // onto it, and a release there would otherwise discard the drag.
    const inside = () => {
      const table = rows.parentElement!.getBoundingClientRect()
      return p.x >= table.left && p.x <= table.right && p.y >= table.top && p.y <= table.bottom
    }
    const at = () => {
      if (!inside()) return
      const list = [...rows.rows]
      // Offsets count from the rows' container, which does not slide.
      const y = p.y - list[0].offsetParent!.getBoundingClientRect().top
      const from = list.findIndex((row) => row.dataset.id === String(dragging))
      const to = list.findIndex((row) => y >= row.offsetTop && y < row.offsetTop + row.offsetHeight)
      if (from < 0 || to < 0 || from === to) return
      // Moved only where the pointer would then rest on the dragged row. Rows
      // differ in height: a short row moved past a tall one would leave the
      // tall one under the pointer, and the two would swap back and forth.
      const target = list[to]
      const height = list[from].offsetHeight
      if (to > from ? y < target.offsetTop + target.offsetHeight - height : y >= target.offsetTop + height) return
      move(dragging, to)
    }
    const onPointer = (e: PointerEvent) => {
      if (e.pointerId !== p.id) return
      p.x = e.clientX
      p.y = e.clientY
      // A move with no button down follows a release the page never saw, as
      // when a context menu took it; the drag would otherwise trail the
      // pointer until the next click saved wherever it was.
      if (e.type === "pointermove" && e.buttons) at()
      else if (e.type === "pointerup" && inside()) save(ids())
      else cancel()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel()
    const types = ["pointermove", "pointerup", "pointercancel"] as const
    for (const type of types) document.addEventListener(type, onPointer)
    document.addEventListener("keydown", onKey)
    addEventListener("scroll", at)
    return () => {
      for (const type of types) document.removeEventListener(type, onPointer)
      document.removeEventListener("keydown", onKey)
      removeEventListener("scroll", at)
    }
  })

  // While a drag lasts. A touch on the handle never scrolls the page
  // (`touch-none`), so a drag held near the top or bottom edge scrolls it,
  // faster the closer it gets -- only toward the edge it has moved toward, or
  // a press on a row near the edge would scroll rows under a still pointer.
  // The cursor is flagged on the root once per drag: a `:has()` on the dragged
  // row would restyle the whole page on every displacement, 25 times the style
  // work of a drag across 200 nodes.
  useEffect(() => {
    if (dragging === null) return
    const root = document.documentElement
    root.dataset.dragging = ""
    let last = 0
    const step = (now: number) => {
      const edge = Math.min(120, innerHeight / 4)
      const { y, y0 } = pointer.current
      const depth = y > y0 ? Math.max(0, y - innerHeight + edge) : -Math.max(0, edge - y)
      scrollBy(0, (Math.max(-1, Math.min(1, depth / edge)) * 900 * Math.min(32, last && now - last)) / 1000)
      last = now
      frame = requestAnimationFrame(step)
    }
    let frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      delete root.dataset.dragging
    }
  }, [dragging])

  return {
    order,
    arrange,
    row: (id: number) => ({
      "data-id": id,
      "data-dragging": dragging === id || undefined,
      // Opaque, with the dragged row beneath the rest: two rows crossing mid-slide
      // would otherwise draw their text over each other. No hover tint during a
      // drag, since the browser keeps it on whichever row reaches the start point.
      className: `relative z-1 bg-card transition-opacity data-[dragging]:z-0 data-[dragging]:opacity-40 ${dragging === null ? "" : "hover:bg-card"}`,
    }),
    handle: (id: number) => ({
      onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
        if (dragging !== null || e.button !== 0) return
        orderBeforeDrag.current = ids()
        body.current = e.currentTarget.closest("tbody")!
        // Captured by the rows' container, which stays put: the handle's row
        // is moved in the document as it is displaced, and that releases a
        // capture it holds, so a release outside the window would go unseen.
        body.current.setPointerCapture(e.pointerId)
        pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, y0: e.clientY }
        setDragging(id)
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
        if (!delta) return
        e.preventDefault()
        orderBeforeDrag.current = ids()
        body.current = e.currentTarget.closest("tbody")
        const next = move(id, ids().indexOf(id) + delta)
        if (next) save(next)
      },
    }),
  }
}

export function DragHandle({ name, disabled, title = "拖动排序", ...events }: React.ComponentProps<"button"> & { name: string }) {
  return (
    <button
      type="button"
      // Not `disabled`: a press on a locked handle is answered by the caller.
      aria-disabled={disabled}
      // A larger target for a finger, and no text selection from a press.
      className="cursor-grab touch-none rounded p-1 text-muted-foreground select-none hover:bg-muted hover:text-foreground active:cursor-grabbing aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent pointer-coarse:p-2"
      title={title}
      aria-label={`拖动 ${name} 排序`}
      {...events}
    >
      <GripVertical className="size-4" />
    </button>
  )
}
