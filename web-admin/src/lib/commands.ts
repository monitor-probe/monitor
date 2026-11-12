import { provisioningSite } from "@/lib/api"

// Each command runs the hub's own install.sh and is offered only on an https
// domain entry. `args` receives that entry, which the agent is also given as
// --server.
function scriptCommand(site: string, args: (site: string) => string[]) {
  site = provisioningSite(site)
  return site && `curl -fsSL ${site}/install.sh | sh -s -- ${args(site).join(" ")}`
}

// Built here rather than fetched: the install dialog reads the token on its own,
// so viewing an install command is a read rather than an action. Reissuing one to
// display it would take the running agent offline.
export function installCommand(site: string, token: string, seconds: number | undefined, iface: string | undefined) {
  return scriptCommand(site, (s) => [`--server ${s}`, `--token ${token}`, ...intervalArg(seconds), ...ifaceArg(iface)])
}

// Left out untouched, as an untouched --iface is: a rerun then keeps what the
// machine already has.
function intervalArg(seconds: number | undefined) {
  return seconds === undefined ? [] : [`--interval ${seconds}`]
}

// '' is how install.sh is told to clear a value it would otherwise keep; a
// name needs no quoting, as ifaceSpec admits no shell metacharacter.
function ifaceArg(iface: string | undefined) {
  return iface === undefined ? [] : [`--iface ${iface || "''"}`]
}

// One command for a batch of machines. The key belongs to the hub, is valid only
// within the window it opened, and each machine exchanges it for a token of its
// own, so unlike an install command this text is no one's credential and can be
// sent to every machine as it is.
export function registerCommand(site: string, key: string, seconds: number | undefined, iface: string | undefined) {
  return scriptCommand(site, (s) => [`--server ${s}`, `--register ${key}`, ...intervalArg(seconds), ...ifaceArg(iface)])
}

// Carries no token, so it is the same for every node and remains valid after the
// node is deleted.
export function uninstallCommand(site: string) {
  return scriptCommand(site, () => ["--uninstall"])
}

// Also the same for every node: install.sh reads the token and the hub address
// from the machine's own env file.
export function upgradeCommand(site: string) {
  return scriptCommand(site, () => ["--upgrade"])
}
