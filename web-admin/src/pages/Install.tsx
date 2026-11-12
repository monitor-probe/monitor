import { useEffect, useRef, useState } from "react"
import { Copy } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

import { Command, ConfirmDialog, copy, Field, OptionRow } from "@/components/common"
import { api, badIfaceName, currentIface, type IfaceChoice, ifaceChoice, ifaceSpec, type Node } from "@/lib/api"
import { installCommand, registerCommand } from "@/lib/commands"
import type { Settings } from "@/lib/settings"

// The window lives on the hub; this reads it back and counts down, which is also
// what makes an expired one disappear from the panel without interaction. The hub
// reports the seconds left rather than the deadline, so the countdown runs from
// the moment its answer arrives and needs this browser's clock to keep time, not
// to agree with the hub's.
export function useRegisterWindow() {
  const [key, setKey] = useState("")
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  // Advanced by every read sent and every change that lands, so an answer
  // overtaken by either is dropped rather than restoring a replaced key.
  const epoch = useRef(0)
  const begin = (key: string, left: number) => {
    const at = Math.floor(Date.now() / 1000)
    setKey(key)
    setNow(at)
    setUntil(at + left)
  }
  // Also run as the dialog opens: the window may have been closed or reopened
  // from another device since this page loaded, and the command shown must
  // carry the key the hub holds now.
  const sync = () => {
    const at = ++epoch.current
    api<Settings>("/settings")
      .then((s) => at === epoch.current && begin(String(s.register_key ?? ""), Number(s.register_left ?? 0)))
      .catch(() => {})
  }

  useEffect(() => {
    sync()
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])

  return {
    key,
    left: key === "" ? 0 : Math.max(0, until - now),
    sync,
    async open() {
      try {
        const w = await api<{ register_key: string; register_left: number }>("/register-window", { method: "POST" })
        epoch.current++
        begin(w.register_key, w.register_left)
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
    async close() {
      try {
        await api("/register-window", { method: "DELETE" })
        epoch.current++
        setKey("")
        setUntil(0)
        toast.success("注册窗口已关闭")
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
  }
}

export function RegisterDialog({ site, reg, onClose }: {
  site: string
  reg: ReturnType<typeof useRegisterWindow>
  onClose: () => void
}) {
  const iface = useIfaceOption(undefined)
  const interval = useIntervalOption()
  const command = reg.left > 0 && iface.valid ? registerCommand(site, reg.key, interval.flag, iface.flag) : ""
  const clock = `${Math.floor(reg.left / 60)}:${String(reg.left % 60).padStart(2, "0")}`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>批量添加</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          {/* One string: JSX turns a line break inside CJK text into a visible space. */}
          <p className="text-sm text-muted-foreground">
            {"开一个一小时的注册窗口。期间这条命令在任意机器上跑一次，那台机器就会自己出现在列表里，" +
              "名字默认是「节点 N」（N 是节点编号）。命令里没有任何一台机器的凭证，可以同时发给多台机器。"}
          </p>
          <section className="space-y-3">
            <h3 className="text-sm font-medium">安装选项</h3>
            <IntervalOption option={interval} batch />
            <IfaceOption option={iface} batch />
          </section>
          {reg.left > 0 ? (
            <section className="space-y-2 border-t pt-5">
              <h3 className="text-sm font-medium">安装命令</h3>
              <Command className={`max-h-40 min-h-24 ${command ? "" : "text-muted-foreground"}`}>
                {command || "网卡名有误，改正后显示命令"}
              </Command>
              {/* Per machine, so it cannot be part of the one command. */}
              <p className="text-xs leading-relaxed text-muted-foreground">
                要给某台单独起名，在它执行的命令末尾加 <code>--name 名字</code>，只对新建的节点生效。
                <a
                  className="ml-1 underline underline-offset-2 hover:text-foreground"
                  href="https://monitor-document.pages.dev/install/batch"
                  target="_blank"
                  rel="noreferrer"
                >
                  批量执行的做法
                </a>
              </p>
              <OptionRow title={`窗口 ${clock} 后自动关闭`} hint="到点自动失效，装完了也可以现在就关">
                <Button variant="outline" size="sm" onClick={reg.close}>立即关闭</Button>
              </OptionRow>
            </section>
          ) : (
            <Button onClick={reg.open}>开启一小时窗口</Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button onClick={() => copy(command)} disabled={!command}>
            <Copy className="size-4" /> 复制
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The reporting interval both install dialogs offer, opening on the node's
// current one where the hub has read it from the reports. `flag` stays
// undefined until the field is changed, including back to what it opened on,
// and while it is empty: a cleared box keeps the machine's interval.
function useIntervalOption(current?: number | null) {
  const [typed, setTyped] = useState<string>()
  const text = typed ?? String(current ?? 1)
  const seconds = Math.min(3600, Math.max(1, Math.round(Number(text) || 1)))
  return { typed: text, setTyped, current, flag: typed === undefined || typed === "" ? undefined : seconds }
}

function IntervalOption({ option, batch = false }: { option: ReturnType<typeof useIntervalOption>; batch?: boolean }) {
  return (
    <OptionRow
      title="上报间隔"
      hint={batch ? "1–3600 秒，默认 1 秒。这一批机器都按这个间隔上报，机器多时可以调大" : (
        <>
          1–3600 秒，默认 1 秒。不改动时沿用机器上原有的间隔
          {option.current && <span className="mt-0.5 block">当前：{option.current} 秒</span>}
        </>
      )}
    >
      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
        {/* Text rather than number: no spinner arrows, and no wheel changing
            the value under a passing scroll. */}
        <Input
          inputMode="numeric"
          value={option.typed}
          placeholder={String(option.current ?? 1)}
          onChange={(e) => option.setTyped(e.target.value.replace(/\D/g, ""))}
          aria-label="上报间隔（秒）"
          className="tnum h-8 w-20 bg-background text-right"
        />
        秒
      </span>
    </OptionRow>
  )
}

// The `--iface` part of an install command. Off leaves the flag out, and
// install.sh then keeps whatever the machine already has; on with both lists
// empty passes '' and restores the default rules. It opens on for a node whose
// agent reports a list, so reinstalling from here repeats that list rather than
// relying on the machine to remember it.
function useIfaceOption(current: string | undefined) {
  const [on, setOn] = useState(!!current)
  const [choice, setChoice] = useState<IfaceChoice>(() => ifaceChoice(current ?? ""))
  const bad = on ? badIfaceName(choice) : undefined
  const spec = ifaceSpec(choice)
  return { on, setOn, choice, setChoice, current, bad, valid: !bad, flag: on && spec !== null ? spec : undefined }
}

function describeIface(spec: string) {
  const { only, skip } = ifaceChoice(spec)
  const parts = [only && `只统计 ${only.replaceAll(",", "、")}`, skip && `不统计 ${skip.replaceAll(",", "、")}`]
  return parts.filter(Boolean).join("；") || "默认规则"
}

function IfaceOption({ option, batch = false }: { option: ReturnType<typeof useIfaceOption>; batch?: boolean }) {
  const { on, setOn, choice, setChoice, current, bad } = option
  const field = (list: keyof IfaceChoice, label: string, placeholder: string) => (
    <Field label={label}>
      <Input
        value={choice[list]}
        onChange={(e) => setChoice({ ...choice, [list]: e.target.value })}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={bad?.list === list}
        className="bg-background font-mono text-xs"
      />
    </Field>
  )
  const hint = on
    ? batch ? "每台机器都按这里的设置统计" : "覆盖这台机器原有的设置"
    : batch ? "关闭时各台机器沿用原有设置，新机器按默认规则" : "关闭时沿用机器上原有的设置，转发流量的机器才需要指定"
  return (
    <OptionRow
      title="指定统计的网卡"
      hint={<>{hint}{current !== undefined && <span className="mt-0.5 block">当前：{describeIface(current)}</span>}</>}
      toggle
      below={on && (
        <div className="space-y-2.5">
          <div className="grid gap-3 sm:grid-cols-2">
            {field("only", "只统计", "如 WAN 口 eth1 或 pppoe-wan")}
            {field("skip", "不统计", "如 LAN 口 eth0")}
          </div>
          <p className={`text-xs leading-relaxed ${bad ? "text-destructive" : "text-muted-foreground"}`}>
            {bad
              ? `「${bad.name}」不是有效的网卡名：写完整的名字，多个用逗号分隔`
              : "写完整的网卡名，多个用逗号分隔。两项都留空即恢复默认规则。"}
          </p>
        </div>
      )}
    >
      <Switch checked={on} onCheckedChange={setOn} />
    </OptionRow>
  )
}

export function InstallDialog({ node, site, onClose, onRotated }: {
  node: Node
  site: string
  onClose: () => void
  onRotated: () => void
}) {
  const [token, setToken] = useState("")
  const [unread, setUnread] = useState("")
  const [rotating, setRotating] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const iface = useIfaceOption(currentIface(node))
  const interval = useIntervalOption(node.interval)

  // Read as the dialog opens rather than carried in the node list, where it
  // would share an answer with strings agents report. A token rotated meanwhile
  // is newer and kept.
  useEffect(() => {
    let live = true
    api<{ token: string }>(`/nodes/${node.id}/token`)
      .then((t) => live && setToken((held) => held || t.token))
      .catch((e) => live && setUnread((e as Error).message))
    return () => { live = false }
  }, [node.id])

  const command = token && iface.valid ? installCommand(site, token, interval.flag, iface.flag) : ""
  const placeholder = token ? "网卡名有误，改正后显示命令" : unread ? `读取凭证失败：${unread}` : "正在读取凭证…"

  async function rotate() {
    setRotating(true)
    try {
      const fresh = await api<{ token: string }>(`/nodes/${node.id}/token`, { method: "POST" })
      setToken(fresh.token)
      setUnread("")
      setConfirmRotate(false)
      toast.success("凭证已换发，需用新命令重装")
      onRotated()
    } catch (e) {
      toast.error((e as Error).message)
      // The rotation may have taken effect with its answer lost on the way, and
      // the command shown would then carry a retired token. Whichever holds now.
      api<{ token: string }>(`/nodes/${node.id}/token`).then((t) => setToken(t.token)).catch(() => {})
    } finally {
      setRotating(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
          {/* The one place a single node's agent version is shown, and what an
              issue report asks for. Empty until the node has reported once. */}
          {node.agent_version && <DialogDescription>当前 agent v{node.agent_version}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-5">
          <section className="space-y-3">
            <h3 className="text-sm font-medium">安装选项</h3>
            <IntervalOption option={interval} />
            <IfaceOption option={iface} />
          </section>
          <section className="space-y-2 border-t pt-5">
            <h3 className="text-sm font-medium">安装命令</h3>
            <Command className={`max-h-40 min-h-24 ${command ? "" : "text-muted-foreground"}`}>
              {command || placeholder}
            </Command>
          </section>
          <OptionRow title="换发凭证" hint="旧凭证立即作废，agent 掉线，需用新命令重装">
            <Button variant="outline" size="sm" disabled={rotating} onClick={() => setConfirmRotate(true)}>
              换发
            </Button>
          </OptionRow>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button onClick={() => copy(command)} disabled={!command}>
            <Copy className="size-4" /> 复制
          </Button>
        </DialogFooter>
      </DialogContent>
      {confirmRotate && (
        <ConfirmDialog
          title={`给「${node.name}」换发凭证？`}
          description="旧凭证立即作废，agent 掉线，必须用新命令重装。仅在凭证可能泄露时使用。"
          confirmLabel="换发凭证"
          busy={rotating}
          onClose={() => setConfirmRotate(false)}
          onConfirm={rotate}
        />
      )}
    </Dialog>
  )
}
