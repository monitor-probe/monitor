import { useCallback, useEffect, useState } from "react"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

import { Field } from "@/components/common"
import { api } from "@/lib/api"
import { useSettings } from "@/lib/settings"

type Session = { id: string; current: boolean; created_at: number }

function useSessions() {
  const [rows, setRows] = useState<Session[] | null>(null)
  // A failed load leaves the list empty rather than absent: the security page
  // waits for it, and the password card must stay reachable.
  const load = useCallback(
    () =>
      api<Session[]>("/sessions")
        .then(setRows)
        .catch((e: Error) => {
          toast.error(e.message)
          setRows((rows) => rows ?? [])
        }),
    [],
  )
  useEffect(() => { load() }, [load])
  return { rows, load }
}

function Sessions({ rows, reload }: { rows: Session[]; reload: () => void }) {
  const [busy, setBusy] = useState("")

  async function remove(id: string) {
    setBusy(id)
    try {
      await api(`/sessions/${id}`, { method: "DELETE" })
      toast.success("已删除会话")
      reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  return (
    <Card className="gap-4 p-5">
      <div>
        <h3 className="text-sm font-medium">登录会话</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          每次登录一条，14 天后过期。删除后该设备下一次请求就被登出。
        </p>
      </div>
      <div className="divide-y">
        {rows.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="tnum">{new Date(s.created_at * 1000).toLocaleString("zh-CN")}</span>
              {s.current && <Badge variant="secondary">当前设备</Badge>}
            </div>
            {/* 当前会话没有删除按钮：右上角的退出登录做的就是这件事，而在这里删
                只会让已经渲染好的面板以为自己还登着。 */}
            {!s.current && (
              <Button size="icon" variant="ghost" title="删除会话" aria-label="删除会话" disabled={!!busy} onClick={() => remove(s.id)}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

// The ways into this panel, on their own page: the sessions signed in, the
// GitHub identity it trusts and the password that works when GitHub does not.
export function Security({ site }: { site: string }) {
  const { s, set, save } = useSettings()
  const sessions = useSessions()
  const [password, setPassword] = useState("")
  // Drawn once both have arrived, so the list does not land late above the
  // cards and push them down.
  if (!s || !sessions.rows) return null
  const callback = `${site}/api/auth/github/callback`

  return (
    <div className="space-y-4">
      <Sessions rows={sessions.rows} reload={sessions.load} />

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">GitHub 单点登录</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            OAuth App 回调地址 <code className="rounded bg-muted px-1 break-all">{callback}</code>
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client ID">
            <Input value={String(s.github_client_id ?? "")} onChange={(e) => set("github_client_id", e.target.value)} />
          </Field>
          <Field label="Client Secret" hint={s.github_secret_set ? "已设置，留空不变" : "未设置"}>
            <Input
              type="password"
              autoComplete="off"
              placeholder={s.github_secret_set ? "••••••••" : ""}
              value={String(s.github_client_secret ?? "")}
              onChange={(e) => set("github_client_secret", e.target.value)}
            />
          </Field>
        </div>
        {String(s.github_client_id ?? "") !== "" && String(s.github_allowed_users ?? "").trim() === "" && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            白名单为空，GitHub 登录拒绝所有人。填入用户名并保存后生效。
          </p>
        )}
        <Field label="允许登录的 GitHub 用户名" hint="逗号分隔。留空 = 拒绝所有人，不是放行所有人">
          <Input value={String(s.github_allowed_users ?? "")} onChange={(e) => set("github_allowed_users", e.target.value)} placeholder="GitHub 用户名" />
        </Field>
        <div>
          <Button
            size="sm"
            onClick={() => {
              const patch: Record<string, string> = {
                github_client_id: String(s.github_client_id ?? ""),
                github_allowed_users: String(s.github_allowed_users ?? ""),
              }
              if (typeof s.github_client_secret === "string" && s.github_client_secret) {
                patch.github_client_secret = s.github_client_secret
              }
              save(patch)
            }}
          >
            保存 GitHub 设置
          </Button>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">应急密码</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            GitHub 不可用时的备用入口。修改后其它设备登录立即失效，当前设备不受影响。
          </p>
        </div>
        <Field label="新密码" hint="至少 12 位">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <div>
          <Button
            size="sm"
            disabled={password.length < 12}
            // Every other session ends with the change, so the list is read again.
            onClick={() => save({ admin_password: password }, "密码已修改").then((ok) => { if (ok) { setPassword(""); sessions.load() } })}
          >
            修改密码
          </Button>
        </div>
      </Card>
    </div>
  )
}
