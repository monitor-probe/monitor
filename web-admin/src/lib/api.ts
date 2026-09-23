import { useEffect, useState } from "react"

export type Metrics = {
  /** The agent's `--iface`, empty for the default rules; absent from an agent predating it. */
  iface?: string
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  last_seen: number
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  /** This period's usage as the plan meters it (`traffic_mode`), computed by the hub. */
  month_used: number
  month_start: string
  /** Panel only. */
  hostname?: string
  /** ISO 3166-1 alpha-2 as shown: the one set by hand, else the one looked up from the node's address. */
  country: string
  /** Set by hand and public; empty is ungrouped. Absent from a hub predating groups. */
  group?: string
  /** Panel only. Set by hand; empty is automatic. */
  country_pin?: string
  /** Panel only. The looked-up country, which a pin hides. */
  country_auto?: string
  ip?: string
  ipv4?: string
  ipv6?: string
  /** Panel only. Set by hand, each replacing the address shown for its family. */
  ipv4_pin?: string
  ipv6_pin?: string
  remark?: string
  /** Panel only. Empty for nodes created before the hub retained a copy. */
  token?: string
  /** Panel only. Whether going offline and returning are announced. */
  notify?: boolean
}

export type PingTask = { id: number; name: string; target: string; interval: number; nodes: number[]; auto_join: boolean }

/** Every group in use, in the order of the first node carrying it: the node order decides the group order. */
export function groupsOf(nodes: Pick<Node, "group">[]): string[] {
  return [...new Set(nodes.map((n) => n.group ?? "").filter(Boolean))]
}

/** A group filter as its dropdown holds it: "all", "none" for the ungrouped, or "=" and a group's name. */
export function inGroup<T extends Pick<Node, "group">>(nodes: T[], filter: string): T[] {
  if (filter === "all") return nodes
  const group = filter === "none" ? "" : filter.slice(1)
  return nodes.filter((n) => (n.group ?? "") === group)
}

/** Form snapshots must never overwrite fields the user did not edit. */
export function changes<T extends object>(initial: T, values: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial[key as keyof T])) as Partial<T>
}

/** One field of the settings form a theme declares under `config` in its `theme.json`. */
export type ConfigField = {
  key: string
  type: "string" | "text" | "number" | "boolean" | "select"
  label?: string
  help?: string
  default: unknown
  options?: { value: string; label?: string }[]
  min?: number
  max?: number
}

/** A heading between fields. It holds no value. */
export type ConfigTitle = { type: "title"; label: string }

const CONFIG_TYPES = ["string", "text", "number", "boolean", "select"]

/** Whether `value` is one the field can hold, the same test a theme applies to what it reads. */
export function fits(field: ConfigField, value: unknown): boolean {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max)
    case "select":
      return !!field.options?.some((option) => option.value === value)
    default:
      return typeof value === "string"
  }
}

/**
 * The entries of a theme's form the panel can draw, headings included, in the
 * manifest's order. The manifest is the theme author's, so a malformed entry is
 * left out rather than failing the form: a heading without a label or without
 * a field under it, a duplicate key, an unknown type, a label or help that is
 * not text (rendering one would throw and blank the panel), a select whose
 * options are not all non-empty strings (the dropdown cannot hold an empty
 * value), or a default the field could not hold.
 */
export function configForm(config: unknown): (ConfigField | ConfigTitle)[] {
  if (!Array.isArray(config)) return []
  const seen = new Set<string>()
  const text = (value: unknown) => value === undefined || typeof value === "string"
  const drawable = config.filter((field): field is ConfigField | ConfigTitle => {
    if (typeof field !== "object" || field === null) return false
    if (field.type === "title") return typeof field.label === "string" && field.label !== ""
    const { key, type, label, help, options, min, max } = field
    const ok = typeof key === "string" && key !== "" && !seen.has(key) && CONFIG_TYPES.includes(type)
      && text(label) && text(help)
      && (type !== "select" || (Array.isArray(options)
        && options.every((o) => typeof o?.value === "string" && o.value !== "" && text(o.label))))
      && [min, max].every((bound) => bound === undefined || typeof bound === "number")
      && fits(field, field.default)
    if (ok) seen.add(key)
    return ok
  })
  return drawable.filter((entry, i) => {
    const next = drawable[i + 1]
    return entry.type !== "title" || (next !== undefined && next.type !== "title")
  })
}

/** The entries of the form that hold a value. */
export function configFields(config: unknown): ConfigField[] {
  return configForm(config).filter((entry): entry is ConfigField => entry.type !== "title")
}

/**
 * The form split at its headings. Fields ahead of the first heading form a
 * section of their own; `configForm` has already dropped every heading with no
 * field under it, so every section has something to show.
 */
export function configSections(form: (ConfigField | ConfigTitle)[]): { label: string; fields: ConfigField[] }[] {
  const sections: { label: string; fields: ConfigField[] }[] = []
  for (const entry of form) {
    if (entry.type === "title") sections.push({ label: entry.label, fields: [] })
    else {
      if (!sections.length) sections.push({ label: "通用", fields: [] })
      sections[sections.length - 1].fields.push(entry)
    }
  }
  return sections
}

/** The value each field shows: the saved one while the field can still hold it, else the default. */
export function configValues(fields: ConfigField[], saved: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.key, fits(f, saved[f.key]) ? saved[f.key] : f.default]))
}

/**
 * What the panel stores: only the fields that differ from their defaults, so a
 * default the theme changes later reaches every site that never altered it.
 * Keys in `saved` the current form does not declare are kept -- a field a
 * newer version dropped returns with a downgrade; an empty `saved` clears them.
 */
export function configOverrides(
  fields: ConfigField[],
  saved: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...saved }
  for (const field of fields) {
    if (values[field.key] === field.default) delete next[field.key]
    else next[field.key] = values[field.key]
  }
  return next
}

export const GIB = 1024 ** 3

/**
 * The traffic fields as a `TrafficPatch`: GB entered by hand, bytes on the wire,
 * and only the counters actually given a value.
 *
 * An emptied field means the counter is left unchanged rather than set to zero.
 * The patch is entirely `Option` and `set_traffic` COALESCEs, so omitting the key
 * expresses that; sending 0 would clear a lifetime total, the one figure that may
 * never decrease and that nothing can recompute. Zeroing deliberately remains one
 * keystroke away.
 */
export function trafficCorrection(
  pristine: Record<string, string>,
  typed: Record<string, string>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(changes(pristine, typed))
      .filter(([, value]) => String(value).trim() !== "")
      .map(([key, value]) => [key, Math.round(Number(value) * GIB)]),
  )
}

/**
 * Globally routable. v4 excludes RFC 1918, CGNAT, loopback, link-local, 0/8,
 * 192.0.0/24, 198.18/15 (the fake-IP range of TUN-mode proxies), multicast and
 * reserved; v6 counts 2000::/3 only, leaving out ULA and link-local. The agent
 * ranks its interfaces and the hub picks the country's address by the same
 * ranges; the three lists are to be changed together.
 */
export function isPublic(ip: string): boolean {
  if (ip.includes(":")) return (parseInt(ip.split(":")[0] || "0", 16) & 0xe000) === 0x2000
  const [a, b, c] = ip.split(".").map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)))
}

/** Where a shown address comes from, which the panel gives as its tooltip. */
export type Source = "manual" | "interface" | "exit" | "connection"

/**
 * The addresses shown for a node: at most one per family, v4 first, the one the
 * machine is reached by. The agent reports its interfaces; `ip` is where its
 * connection arrived from, which the hub canonicalizes to dotted form for IPv4.
 *
 * Per family an address set by hand comes first, then a public one on the
 * interface. Failing both, where the interface holds only a private address of
 * the family the connection used -- NAT, or a proxy in front -- the connection's
 * public address, its exit, stands in. An exit in a family the interface does
 * not hold is a translator such as NAT64 or WARP and is left out.
 *
 * Private addresses appear only when nothing public is known, as where hub and
 * node share a network and they are all there is. `ip` alone is the fallback
 * for an agent reporting no interface.
 */
export function addresses(
  node: Pick<Node, "ip" | "ipv4" | "ipv6" | "ipv4_pin" | "ipv6_pin">,
): { address: string; source: Source }[] {
  const { ip = "", ipv4 = "", ipv6 = "", ipv4_pin = "", ipv6_pin = "" } = node
  const family = (pin: string, held: string, v6: boolean): { address: string; source: Source } | null =>
    pin ? { address: pin, source: "manual" }
      : held && isPublic(held) ? { address: held, source: "interface" }
      : held && isPublic(ip) && ip.includes(":") === v6 ? { address: ip, source: "exit" }
      : null
  const shown = [family(ipv4_pin, ipv4, false), family(ipv6_pin, ipv6, true)].filter((a) => a !== null)
  if (shown.length) return shown
  if (ipv4 || ipv6) return [ipv4, ipv6].filter(Boolean).map((address) => ({ address, source: "interface" }))
  return ip ? [{ address: ip, source: "connection" }] : []
}

/** Installation commands require a TLS origin with a domain, never an IP. */
export function provisioningSite(site: string): string {
  try {
    const u = new URL(site)
    return u.protocol === "https:" && !u.hostname.startsWith("[") && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
      && u.hostname !== "localhost" && !u.hostname.endsWith(".localhost") && !u.username && !u.password
      && u.pathname === "/" && !u.search && !u.hash ? u.origin : ""
  } catch {
    return ""
  }
}

/**
 * Whether this is the hub's own machine in the address bar, which is what a
 * tunnel into the panel leaves there. The hub applies the same test: such an
 * entry is not in the clear, but it names no address a node could reach, so it
 * provisions only alongside `--site`.
 */
export function loopbackOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    return (protocol === "https:" || protocol === "http:")
      && (hostname === "localhost" || hostname.endsWith(".localhost")
        || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname))
  } catch {
    return false
  }
}

/**
 * Why nodes cannot be added or installed from this page, or "" when they can.
 * `origin` is the page's own, which reaches the hub as `Origin`; `site` is
 * `--site`, empty when none is set. The hub's `provisioning_allowed` applies the
 * same rule, and a GET carries no `Origin` for it to answer this in advance.
 */
export function provisionRefusal(origin: string, site: string): string {
  if (site && !provisioningSite(site)) return "hub 的 --site 不是 https 域名，改正后才能添加或安装节点。"
  if (provisioningSite(origin) || (loopbackOrigin(origin) && site)) return ""
  return loopbackOrigin(origin)
    ? "从隧道或回环地址进面板时，要给 hub 加 --site 指定节点可达的 https 域名。"
    : "请通过 HTTPS 域名访问面板后添加或安装节点。"
}

/** `1.2.3` as numbers, or null for anything else. */
const versionParts = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null)

/**
 * Whether `current` names an earlier release than `latest`; missing components
 * count as 0. An empty side is never behind: a node that has not reported
 * carries no version, and an unreachable GitHub leaves no latest. A build ahead
 * of the release -- one compiled locally -- is not behind either. Versions that
 * are not `1.2.3` can only be compared for equality.
 */
export function behind(current: string, latest: string): boolean {
  if (!current || !latest) return false
  const a = versionParts(current)
  const b = versionParts(latest)
  if (!a || !b) return current !== latest
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

/** The nodes running an earlier agent than the published one. */
export function outdatedAgents<T extends { agent_version: string }>(nodes: T[], latest: string): T[] {
  return nodes.filter((n) => behind(n.agent_version, latest))
}

/** The agent's `--iface` as the install dialogs edit it: names to count alone, names to leave out. */
export type IfaceChoice = { only: string; skip: string }

// What the agent accepts as a name, less the leading `-` that marks an exclusion
// in the flag itself. Narrower than a kernel interface name, and within what
// install.sh admits into the env file OpenRC sources as shell.
const IFACE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/

const ifaceNames = (list: string) => list.split(",").map((n) => n.trim()).filter(Boolean)

/** The first name the agent would refuse, or that would silently match nothing, and the list holding it. */
export function badIfaceName(choice: IfaceChoice): { list: keyof IfaceChoice; name: string } | undefined {
  for (const list of ["only", "skip"] as const) {
    const name = ifaceNames(choice[list]).find((n) => !IFACE_NAME.test(n))
    if (name !== undefined) return { list, name }
  }
}

/** The `--iface` value for a choice; null while [badIfaceName] finds one. */
export function ifaceSpec(choice: IfaceChoice): string | null {
  if (badIfaceName(choice)) return null
  return [...ifaceNames(choice.only), ...ifaceNames(choice.skip).map((n) => `-${n}`)].join(",")
}

export function ifaceChoice(spec: string): IfaceChoice {
  const names = ifaceNames(spec)
  return {
    only: names.filter((n) => !n.startsWith("-")).join(","),
    skip: names.filter((n) => n.startsWith("-")).map((n) => n.slice(1)).join(","),
  }
}

/**
 * The `--iface` a connected node's agent runs with. Empty means the default
 * rules, which is also what an agent predating the flag applies; undefined
 * means the node is not reporting and nothing is known.
 */
export function currentIface(node: Pick<Node, "metrics">): string | undefined {
  return node.metrics ? (node.metrics.iface ?? "") : undefined
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
  })
  if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
}

/**
 * 4 MiB: the only size a reverse proxy must pass, whatever the file behind it
 * weighs. The hub accepts up to 8 MiB per request, so this can change without
 * touching the server or negotiating first.
 */
const CHUNK = 4 * 1024 * 1024

/**
 * Uploads a file one chunk at a time. There is no upload id: the hub tracks an
 * upload by the length of what it has already written, so a chunk states only
 * where it begins. The last one carries the result.
 */
export async function upload<T>(
  path: string,
  file: File,
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  if (file.size === 0) throw new ApiError(400, "文件是空的")
  let last: Response | null = null
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    // A chunk boundary is a genuine stopping point: the hub applies nothing until
    // the last piece lands, and `offset = 0` truncates whatever an abandoned
    // attempt left behind, so aborting here leaves the state unchanged.
    if (signal?.aborted) throw new DOMException("aborted", "AbortError")
    const res = await fetch(`/api${path}?offset=${offset}&total=${file.size}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file.slice(offset, offset + CHUNK),
      signal,
    })
    if (!res.ok) {
      // A 413 never reached the hub: the proxy in front answered, and only its
      // own logs record it. The message names the setting responsible.
      throw new ApiError(
        res.status,
        res.status === 413
          ? "反向代理拒收了 4 MiB 的分片，把 nginx 的 client_max_body_size 调到 8m"
          : (await res.text()) || res.statusText,
      )
    }
    last = res
    onProgress?.(Math.min(offset + CHUNK, file.size))
  }
  return last!.json()
}

/**
 * Live node list. Uses the WebSocket the hub pushes every two seconds, falling
 * back to polling if it cannot be established.
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  // null until a frame reports it. The panel treats an explicit false as the
  // session no longer being an admin one, so an unanswered first fetch must not
  // read as that; see App.tsx.
  const [admin, setAdmin] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const fetchOnce = () =>
      api<{ nodes: Node[]; admin: boolean }>("/nodes")
        .then((d) => {
          setNodes(d.nodes)
          setAdmin(d.admin)
          setError(null)
        })
        .catch((e: Error) => {
          setError(e.message)
          // With the public page switched off, a revoked session receives a 401
          // here and on the stream, so the frame that would report admin=false
          // never arrives and the panel would retain the list it already had.
          if (e instanceof ApiError && e.status === 401) setAdmin(false)
        })

    fetchOnce()

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
    // A hub restart closes every stream. Without reconnecting, a page that
    // outlives a deploy would remain on the fallback poll for the rest of its
    // life, refreshing at a fifth of the live rate with no indication.
    const connect = () => {
      try {
        socket = new WebSocket(url)
      } catch {
        poll ??= setInterval(fetchOnce, 5000)
        return
      }
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data)
        setNodes(frame.nodes)
        setAdmin(frame.admin)
        setError(null)
        // The stream has returned; the poll was only covering for it.
        if (poll) {
          clearInterval(poll)
          poll = null
        }
      }
      socket.onerror = () => socket?.close()
      socket.onclose = () => {
        if (closed) return
        poll ??= setInterval(fetchOnce, 5000)
        retry = setTimeout(connect, 5000)
      }
    }
    connect()

    return () => {
      closed = true
      socket?.close()
      if (poll) clearInterval(poll)
      if (retry) clearTimeout(retry)
    }
  }, [reload])

  return { nodes, admin, error, refresh: () => setReload((n) => n + 1) }
}
