import { useId, useState } from "react"
import { CircleQuestionMark } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function Segments<K extends string>({ label, options, value, onPick }: {
  label: string
  options: { key: K; label: React.ReactNode }[]
  value: K
  onPick: (key: K) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onPick(o.key)}
          className={`rounded-md px-3 py-1 text-sm transition-colors ${value === o.key ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function copy(text: string, done = "已复制") {
  // navigator.clipboard exists only in a secure context. Over plain http the
  // copy command still works from a click, the clipboard filled from its event.
  if (!navigator.clipboard) {
    const put = (e: ClipboardEvent) => { e.clipboardData?.setData("text/plain", text); e.preventDefault() }
    document.addEventListener("copy", put)
    const ok = document.execCommand("copy")
    document.removeEventListener("copy", put)
    return ok ? toast.success(done) : toast.error("复制失败")
  }
  navigator.clipboard.writeText(text).then(
    () => toast.success(done),
    () => toast.error("复制失败"),
  )
}

// Every command the panel hands out. break-all because a token has no spaces to
// wrap at.
export function Command({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <pre className={`overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed select-all ${className}`}>
      {children}
    </pre>
  )
}

export function Field({ label, hint, help, helpWidth, action, className = "", children }: {
  label: string
  hint?: string
  help?: React.ReactNode
  helpWidth?: string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const title = <Label className="text-sm font-medium">{label}</Label>
  const head = help ? <div className="flex items-center gap-1.5">{title}<Help width={helpWidth}>{help}</Help></div> : title
  return (
    <div className={`space-y-2 ${className}`}>
      {action ? <div className="flex items-center justify-between">{head}{action}</div> : head}
      {children}
      {/* Kept whole between punctuation, as in Help below. */}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground break-keep wrap-anywhere">{hint}</p>}
    </div>
  )
}

// A switch with its label, in the same two registers as `Field`: what it does
// in one line underneath, and why or at what risk behind the question mark. Not
// a <label>: a tap on the words must not flip the switch, only the switch is
// pressable. aria-labelledby keeps the association for screen readers.
export function SwitchRow({ label, hint, extra, help, helpWidth, checked, onChange }: {
  label: string
  hint?: string
  extra?: React.ReactNode
  help?: React.ReactNode
  helpWidth?: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <Switch aria-labelledby={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <div className="space-y-1">
        <div className="text-sm leading-snug text-balance">
          <span id={id}>{label}</span>
          {help && (
            <span className="ml-1.5 inline-flex align-middle">
              <Help width={helpWidth}>{help}</Help>
            </span>
          )}
        </div>
        {hint && <p className="text-xs leading-relaxed text-muted-foreground break-keep wrap-anywhere">{hint}</p>}
        {extra}
      </div>
    </div>
  )
}

// A tap shows no tooltip on its own, so a click opens it as well. The trigger's
// own handlers would close it on press and on click; both are prevented.
//
// `width` is fitted to each text: the narrowest at which its paragraphs take the
// fewest lines, plus some room for a wider font. A screen too narrow for that
// gets the narrowest width holding the lines it can fit; capping the wide box
// at the screen instead would leave its lines well short of the right edge.
export function Help({ children, width = "max-w-64" }: { children: React.ReactNode; width?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="说明"
          className="text-muted-foreground hover:text-foreground"
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault()
            setOpen(true)
          }}
        >
          <CircleQuestionMark className="size-3.5" />
        </button>
      </TooltipTrigger>
      {/* text-wrap over the component's text-balance, which breaks multi-line
          Chinese halfway across the box. Chinese may also break between any
          two characters, which splits words such as 季付 across lines; kept
          whole, a line breaks at punctuation and spaces, and mid-run only when
          a run cannot fit at all. */}
      <TooltipContent
        collisionPadding={16}
        className={`${width} space-y-1 text-left text-wrap break-keep wrap-anywhere`}
      >
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

// A titled option with its control at the right. `toggle` makes the whole row a
// label, so a click anywhere flips the Switch it holds; `below` opens beneath it
// in the same card.
export function OptionRow({ title, hint, toggle = false, below, children }: {
  title: React.ReactNode
  hint?: React.ReactNode
  toggle?: boolean
  below?: React.ReactNode
  children: React.ReactNode
}) {
  const Row = toggle ? "label" : "div"
  return (
    <div className="flex flex-col rounded-lg border bg-muted/30 text-sm">
      {/* flex-1: stretched by a grid, the row fills the card and stays clickable. */}
      <Row className={`flex flex-1 items-center justify-between gap-4 px-3 py-2.5 ${toggle ? "cursor-pointer" : ""}`}>
        <span>
          <span className="block font-medium">{title}</span>
          {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
        </span>
        {children}
      </Row>
      {below && <div className="border-t px-3 pt-3 pb-3.5">{below}</div>}
    </div>
  )
}


export function ConfirmDialog({ title, description, confirmLabel, busy = false, locked = false, onClose, onConfirm, children }: {
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  // Past the point where closing could still stop anything.
  locked?: boolean
  onClose: () => void
  onConfirm: () => void
  children?: React.ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && !locked && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-relaxed">{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter className="border-t pt-4">
          <Button variant="ghost" onClick={onClose} disabled={locked}>取消</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const TEXT_BOX =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
export const TEXTAREA = `${TEXT_BOX} font-mono text-xs`
