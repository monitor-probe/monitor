import { ArrowUpCircle, Bell, Database, Palette, Radio, Server, Settings, Shield } from "lucide-react"

import { behind, type Node, outdatedAgents } from "@/lib/api"
import { Data } from "@/pages/Data"
import { Nodes } from "@/pages/Nodes"
import { Notify } from "@/pages/Notify"
import { Ping } from "@/pages/Ping"
import { Security } from "@/pages/Security"
import { SettingsTab } from "@/pages/Settings"
import { Themes } from "@/pages/Themes"
import { Update, useVersions } from "@/pages/Update"

// Each area is its own route rather than a tab, so a page can be linked to and a
// reload returns to the same section.
const ADMIN_SECTIONS = [
  { path: "/admin/nodes", label: "节点", icon: Server },
  { path: "/admin/ping", label: "延迟", icon: Radio },
  { path: "/admin/notify", label: "通知", icon: Bell },
  { path: "/admin/data", label: "数据", icon: Database },
  { path: "/admin/themes", label: "主题", icon: Palette },
  { path: "/admin/security", label: "安全", icon: Shield },
  { path: "/admin/settings", label: "设置", icon: Settings },
  { path: "/admin/update", label: "更新", icon: ArrowUpCircle },
] as const

export function Admin({
  path,
  go,
  nodes,
  refresh,
  site,
  refusal,
  reloadMe,
}: {
  path: string
  go: (to: string) => void
  nodes: Node[]
  refresh: () => void
  site: string
  refusal: string
  reloadMe: () => void
}) {
  const { versions, reload } = useVersions()
  // One dot for both; the page separates them. Absent when switched off on that
  // page, or when the lookup failed and the page has nothing to say.
  const updates =
    !!versions?.notice
    && (behind(versions.hub, versions.hub_latest) || outdatedAgents(nodes, versions.agent_latest).length > 0)
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav className="flex gap-1 overflow-x-auto md:w-44 md:shrink-0 md:flex-col md:overflow-visible">
        {ADMIN_SECTIONS.map(({ path: to, label, icon: Icon }) => {
          const active = path === to
          return (
            <button
              key={to}
              onClick={() => go(to)}
              aria-current={active ? "page" : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                active ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <Icon className="size-4" />
              {label}
              {to === "/admin/update" && updates && (
                <span className="ml-1 size-1.5 shrink-0 rounded-full bg-foreground md:ml-auto" title="有新版本" />
              )}
            </button>
          )
        })}
      </nav>

      <div className="min-w-0 flex-1">
        {path === "/admin/ping" ? (
          <Ping nodes={nodes} />
        ) : path === "/admin/notify" ? (
          <Notify nodes={nodes} refresh={refresh} />
        ) : path === "/admin/data" ? (
          <Data />
        ) : path === "/admin/themes" ? (
          <Themes />
        ) : path === "/admin/security" ? (
          <Security site={site} />
        ) : path === "/admin/settings" ? (
          <SettingsTab onSaved={reloadMe} />
        ) : path === "/admin/update" ? (
          <Update versions={versions} reload={reload} nodes={nodes} site={site} refusal={refusal} />
        ) : (
          <Nodes nodes={nodes} refresh={refresh} site={site} refusal={refusal} />
        )}
      </div>
    </div>
  )
}
