import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { ExternalLink, LogOut, Moon, Sun } from "lucide-react"
import { Toaster } from "sonner"

import { Admin } from "@/components/Admin"
import { Login } from "@/components/Login"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { api, provisionRefusal, useNodes } from "@/lib/api"

type Me = { authed: boolean; github: boolean; site_name: string; public_page: boolean; site: string }

// `/admin` alone is not a page; it is normalised to the first section so that a
// bookmark and the OAuth redirect both resolve to a real route.
function normalise(p: string) {
  return p === "/admin" || p === "/admin/" ? "/admin/nodes" : p.replace(/\/$/, "") || "/admin/nodes"
}

function usePath() {
  const [path, setPath] = useState(() => {
    const start = normalise(location.pathname)
    if (start !== location.pathname) history.replaceState({}, "", start + location.search)
    return start
  })
  useEffect(() => {
    const sync = () => setPath(normalise(location.pathname))
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  return [
    path,
    useCallback((next: string) => {
      const to = normalise(next)
      history.pushState({}, "", to)
      setPath(to)
    }, []),
  ] as const
}

const DARK_MEDIA = matchMedia("(prefers-color-scheme: dark)")

/**
 * The operator's own choice, or the system's while there is none. Only the toggle
 * writes the choice down: persisting the system's answer on load would pin it,
 * and the public theme served from the same origin reads this key too, so one
 * visit to the panel would leave the status page in whichever mode the system
 * happened to be in at that moment, no longer following it.
 *
 * The system's answer is subscribed to rather than copied into state: a flip
 * landing between the first render and the effect that would have attached the
 * listener is otherwise never heard, and the next one is a day away.
 */
function useTheme() {
  const [saved, setSaved] = useState(() => localStorage.getItem("theme"))
  const system = useSyncExternalStore(
    (notify) => {
      DARK_MEDIA.addEventListener("change", notify)
      return () => DARK_MEDIA.removeEventListener("change", notify)
    },
    () => DARK_MEDIA.matches,
  )
  const dark = saved ? saved === "dark" : system

  // Switched with every transition held. Buttons, badges and table rows fade
  // their colours over 150 ms while everything else changes at once, leaving
  // the page in both palettes for that long.
  useEffect(() => {
    const hold = document.createElement("style")
    hold.textContent = "*,*::before,*::after{transition:none!important}"
    document.head.append(hold)
    document.documentElement.classList.toggle("dark", dark)
    // Resolves the new colours while transitions are off, so removing the
    // hold starts none.
    void document.body.offsetWidth
    hold.remove()
  }, [dark])

  return [
    dark,
    () => {
      const next = dark ? "light" : "dark"
      localStorage.setItem("theme", next)
      setSaved(next)
    },
  ] as const
}

export default function App() {
  const [path, go] = usePath()
  const [dark, toggleTheme] = useTheme()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, admin, error, refresh } = useNodes()

  const loadMe = useCallback(() => {
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message))
  }, [])
  useEffect(() => {
    loadMe()
  }, [loadMe])

  // Every frame declares its audience. The hub closes the stream when the session
  // behind it is revoked -- signed out from another device, a password change, a
  // restore -- and the reconnect returns as anonymous: the public list, with
  // private nodes absent and every admin field empty, rendered inside a panel that
  // still appears signed in. `authed` is read only at mount and after signing in,
  // so nothing else detects this. /api/me already handles signing out.
  useEffect(() => {
    if (me?.authed && admin === false) loadMe()
  }, [admin, me?.authed, loadMe])

  // Only while there is nothing else to show. Login's onDone reloads /me, so a
  // transient failure in the second after signing in would otherwise replace the
  // entire signed-in panel with a full-page error while the node list streamed
  // normally.
  if (!me) return (
    <div className="grid min-h-svh place-items-center p-6 text-sm text-muted-foreground">
      {meError ? <div className="space-y-3 text-center"><p role="alert">加载失败：{meError}</p><Button onClick={loadMe}>重试</Button></div> : "加载中…"}
    </div>
  )

  if (!me.authed) {
    return (
      <>
        <Login github={me.github} onDone={() => { loadMe(); refresh(); go("/admin/nodes") }} />
        <Toaster position="top-center" theme={dark ? "dark" : "light"} />
      </>
    )
  }

  const sorted = [...(nodes ?? [])].sort((a, b) => a.sort - b.sort || a.id - b.id)

  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => {})
    location.href = "/"
  }

  return (
    // The browser's own title tooltip waits a second or more and cannot be
    // shortened; these open after 300 ms.
    <TooltipProvider delayDuration={300}>
      <div className="min-h-svh">
        <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
            {/* The site name is the way back to the status page, as in the
                theme's own header. */}
            <a href="/" className="font-semibold transition-opacity hover:opacity-70">
              {me.site_name || "Monitor"}
            </a>
            <span className="text-xs text-muted-foreground">后台</span>
            <div className="flex-1" />
            {/* The status page is a separate app, so this is a navigation. */}
            <Button variant="ghost" size="sm" asChild>
              <a href="/">
                <ExternalLink /> 状态面板
              </a>
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题">
              {dark ? <Sun /> : <Moon />}
            </Button>
            <Button variant="ghost" size="icon" onClick={signOut} title="退出登录">
              <LogOut />
            </Button>
          </div>
        </header>

        <main className="mx-auto max-w-7xl space-y-5 px-4 py-6">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!nodes ? (
            <Skeleton className="h-64" />
          ) : (
            <Admin
              path={path}
              go={go}
              nodes={sorted}
              refresh={refresh}
              // The hub's own public URL rather than this browser's address: the
              // panel is frequently reached over a loopback port behind a proxy,
              // while the install command and OAuth callback need the real one.
              site={me.site || location.origin}
              // Why this page cannot add nodes, measured by the rule the hub applies
              // to the `Origin` it receives; empty when it can.
              refusal={provisionRefusal(location.origin, me.site)}
              reloadMe={loadMe}
            />
          )}
        </main>

        <Toaster position="top-center" theme={dark ? "dark" : "light"} />
      </div>
    </TooltipProvider>
  )
}
