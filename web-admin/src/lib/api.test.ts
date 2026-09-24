/// <reference types="node" />
import assert from "node:assert/strict"
import { badIfaceName, behind, changes, configFields, configForm, configOverrides, configSections, configValues, currentIface, fits, GIB, groupsOf, ifaceChoice, ifaceSpec, inGroup, loopbackOrigin, moved, outdatedAgents, provisioningSite, provisionRefusal, trafficCorrection } from "./api.ts"

assert.deepEqual(changes({ public: true, price: 5 }, { price: 20 }), { price: 20 })
assert.deepEqual(changes({ total_rx: "100", month_tx: "2" }, { total_rx: "100", month_tx: "3" }), { month_tx: "3" })
assert.deepEqual(changes({ expires_at: "2030-01-01" as string | null }, { expires_at: null }), { expires_at: null })
// A drag moves one row: both tables' reorder go through this.
assert.deepEqual(moved([1, 2, 3], 0, 2), [2, 3, 1])
assert.deepEqual(moved([1, 2, 3], 2, 0), [3, 1, 2])
assert.deepEqual(moved(["a"], 0, 0), ["a"])
// An index outside the list is not a move, and the caller tells the two apart by
// identity rather than by comparing contents.
const untouched = [1, 2, 3]
assert.equal(moved(untouched, 1, 1), untouched)
assert.equal(moved(untouched, 0, 3), untouched)
assert.equal(moved(untouched, 3, 0), untouched)
assert.equal(moved(untouched, 0, -1), untouched)
assert.deepEqual(untouched, [1, 2, 3], "a refused move must not disturb the list it was given")
assert.equal(provisioningSite("https://monitor.example.com:8443/"), "https://monitor.example.com:8443")
for (const site of ["http://monitor.example.com", "https://127.0.0.1", "https://[::1]", "https://2130706433", "https://0x7f000001", "https://localhost", "https://user@monitor.example.com", "https://monitor.example.com/path"]) {
  assert.equal(provisioningSite(site), "", site)
}
// A tunnelled panel: the hub allows it alongside --site, so the panel must read
// the same addresses as loopback, and a name merely beginning with one as not.
for (const origin of ["http://127.0.0.1:9911", "http://localhost:9911", "http://[::1]:9911", "https://127.0.0.1"]) {
  assert.equal(loopbackOrigin(origin), true, origin)
}
for (const origin of ["https://monitor.example.com", "http://127.0.0.1.example.com", "ftp://127.0.0.1", "nonsense"]) {
  assert.equal(loopbackOrigin(origin), false, origin)
}
// The refusal names the cause the operator can act on, as the hub decides it.
// A loopback --site is a bad --site, not a missing one.
for (const [origin, site, cause] of [
  ["https://monitor.example.com", "", ""],
  ["https://monitor.example.com", "https://hub.example.com", ""],
  ["http://127.0.0.1:9911", "https://hub.example.com", ""],
  ["http://127.0.0.1:9911", "", "加 --site"],
  ["http://127.0.0.1:9911", "http://127.0.0.1:28080", "不是 https 域名"],
  ["https://monitor.example.com", "https://198.51.100.1", "不是 https 域名"],
  ["http://198.51.100.1:28080", "https://hub.example.com", "请通过 HTTPS 域名"],
]) {
  const refusal = provisionRefusal(origin, site)
  assert.ok(cause ? refusal.includes(cause) : refusal === "", `${origin} ${site}: ${refusal}`)
}
// A node that never reported carries no version, an unreachable GitHub leaves no
// published one, and a locally built agent ahead of the release is not one to
// upgrade: none of the three is an upgrade to offer.
const fleet = [{ agent_version: "1.1.0" }, { agent_version: "1.0.9" }, { agent_version: "" }, { agent_version: "1.1.1" }]
assert.deepEqual(outdatedAgents(fleet, "1.1.0"), [{ agent_version: "1.0.9" }])
assert.deepEqual(outdatedAgents(fleet, ""), [])
assert.deepEqual(outdatedAgents([{ agent_version: "1.2" }], "1.2.0"), [])
assert.deepEqual(outdatedAgents([{ agent_version: "1.2.0-dev" }], "1.2.0"), [{ agent_version: "1.2.0-dev" }])
// The hub's own version goes through the same comparison.
assert.equal(behind("1.2.0", "1.10.0"), true)
assert.equal(behind("1.3.0", "1.2.0"), false)
assert.equal(behind("1.2.0", ""), false)

// An emptied traffic field means the counter is not to be corrected. Sent as 0
// it would clear a lifetime total, which must never decrease.
const shown = { total_rx: "1.5", total_tx: "2", month_rx: "0.25", month_tx: "1" }
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "" }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "   " }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "0" }), { total_rx: 0 })
assert.deepEqual(trafficCorrection(shown, { ...shown, total_tx: "3" }), { total_tx: 3 * GIB })
assert.deepEqual(trafficCorrection(shown, shown), {})
console.log("partial edits, traffic corrections and provisioning checks passed")

// --iface from the two lists the install dialogs show, and back.
assert.equal(ifaceSpec({ only: " eth1, pppoe-wan ", skip: "" }), "eth1,pppoe-wan")
assert.equal(ifaceSpec({ only: "", skip: "vxlan100, nebula1" }), "-vxlan100,-nebula1")
assert.equal(ifaceSpec({ only: "enp1s0", skip: "enp5s0" }), "enp1s0,-enp5s0")
assert.equal(ifaceSpec({ only: "", skip: "" }), "", "both empty restores the default rules")
// Each of these the agent would refuse, or would match nothing without a word.
for (const bad of ["eth0 eth1", "eth*", "-eth0", "eth0;reboot", "eth0'"]) {
  assert.equal(ifaceSpec({ only: bad, skip: "" }), null, bad)
  assert.equal(ifaceSpec({ only: "", skip: bad }), null, bad)
}
// The dialog names the offender and marks the field it sits in.
assert.deepEqual(badIfaceName({ only: "eth0", skip: "vxlan100, eth*" }), { list: "skip", name: "eth*" })
assert.equal(badIfaceName({ only: "eth0", skip: "vxlan100" }), undefined)
assert.deepEqual(ifaceChoice("eth1,-vxlan100,pppoe-wan"), { only: "eth1,pppoe-wan", skip: "vxlan100" })
assert.equal(ifaceSpec(ifaceChoice("enp1s0,-enp5s0")), "enp1s0,-enp5s0")
// A node not reporting tells nothing; an agent predating --iface runs the default rules.
assert.equal(currentIface({ metrics: null }), undefined)
assert.equal(currentIface({ metrics: {} as never }), "")
assert.equal(currentIface({ metrics: { iface: "eth1,-eth0" } as never }), "eth1,-eth0")

// Groups follow the node order, and the filter keeps ungrouped nodes apart from
// a group whose name merely resembles a sentinel.
const fleet2 = [{ group: "东京" }, { group: "" }, { group: "none" }, { group: "东京" }, {}]
assert.deepEqual(groupsOf(fleet2), ["东京", "none"])
assert.equal(inGroup(fleet2, "all").length, 5)
assert.equal(inGroup(fleet2, "none").length, 2)
assert.deepEqual(inGroup(fleet2, "=none"), [{ group: "none" }])
assert.equal(inGroup(fleet2, "=东京").length, 2)

// A theme's form: malformed fields drop out one by one, a saved value the field
// can no longer hold shows the default, and only changes from a default are stored.
const entries = [
  { type: "title", label: "外观" },
  { key: "notice", type: "text", default: "" },
  { key: "layout", type: "select", default: "grid", options: [{ value: "grid" }, { value: "table" }] },
  { key: "refresh", type: "number", default: 5, min: 1, max: 60 },
  { key: "dark", type: "boolean", default: false },
  { key: "notice", type: "string", default: "duplicate" },
  { key: "odd", type: "color", default: "#000" },
  { key: "bare", type: "select", default: "a" },
  { key: "blank", type: "select", default: "", options: [{ value: "" }, { value: "a" }] },
  { key: "wrong", type: "boolean", default: "yes" },
  { key: "range", type: "number", default: 0, min: 1 },
  { key: "i18n", type: "string", default: "", label: { zh: "公告", en: "Notice" } },
  { key: "hinted", type: "boolean", default: true, help: 1 },
  { key: "labelled", type: "select", default: "a", options: [{ value: "a", label: { zh: "甲" } }] },
  "not a field",
  { type: "title" },
  { type: "title", label: "空" },
  { type: "title", label: "末尾" },
]
assert.deepEqual(configForm(entries).map((f) => (f.type === "title" ? `# ${f.label}` : f.key)), ["# 外观", "notice", "layout", "refresh", "dark"])
const form = configFields(entries)
assert.deepEqual(form.map((f) => f.key), ["notice", "layout", "refresh", "dark"])
assert.deepEqual(configFields({ notice: "x" }), [])
const saved = { layout: "cards", refresh: 10, legacy: 1 }
const initial = configValues(form, saved)
assert.deepEqual(initial, { notice: "", layout: "grid", refresh: 10, dark: false })
assert.equal(fits(form[2], 61), false)
assert.deepEqual(configOverrides(form, saved, { ...initial, refresh: 5, dark: true }), { legacy: 1, dark: true })
// 恢复默认 builds on nothing, so undeclared keys go with the overrides.
assert.deepEqual(configOverrides(form, {}, Object.fromEntries(form.map((f) => [f.key, f.default]))), {})
// Headings split the form; leading fields get a section, empty headings none.
assert.deepEqual(
  configSections(configForm([{ key: "a", type: "string", default: "" }, { type: "title", label: "空" }, { type: "title", label: "外观" }, { key: "b", type: "boolean", default: true }]))
    .map((s) => [s.label, s.fields.map((f) => f.key)]),
  [["通用", ["a"]], ["外观", ["b"]]],
)

