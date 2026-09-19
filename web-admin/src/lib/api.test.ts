/// <reference types="node" />
import assert from "node:assert/strict"
import { addresses, badIfaceName, changes, currentIface, GIB, ifaceChoice, ifaceSpec, isPublic, provisioningSite, trafficCorrection } from "./api.ts"

assert.deepEqual(changes({ public: true, price: 5 }, { price: 20 }), { price: 20 })
assert.deepEqual(changes({ total_rx: "100", month_tx: "2" }, { total_rx: "100", month_tx: "3" }), { month_tx: "3" })
assert.deepEqual(changes({ expires_at: "2030-01-01" as string | null }, { expires_at: null }), { expires_at: null })
assert.equal(provisioningSite("https://monitor.example.com:8443/"), "https://monitor.example.com:8443")
for (const site of ["http://monitor.example.com", "https://127.0.0.1", "https://[::1]", "https://2130706433", "https://0x7f000001", "https://localhost", "https://user@monitor.example.com", "https://monitor.example.com/path"]) {
  assert.equal(provisioningSite(site), "", site)
}
// An emptied traffic field means the counter is not to be corrected. Sent as 0
// it would clear a lifetime total, which must never decrease.
const shown = { total_rx: "1.5", total_tx: "2", month_rx: "0.25", month_tx: "1" }
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "" }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "   " }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "0" }), { total_rx: 0 })
assert.deepEqual(trafficCorrection(shown, { ...shown, total_tx: "3" }), { total_tx: 3 * GIB })
assert.deepEqual(trafficCorrection(shown, shown), {})
// One address per family, marked with where it came from.
const rows = (node: Parameters<typeof addresses>[0]) => addresses(node).map((a) => `${a.address} ${a.source}`)
// A public interface is the machine; a different exit in front of it is a proxy and stays out.
assert.deepEqual(rows({ ip: "2001:db8::2", ipv4: "203.0.113.7", ipv6: "2001:db8::2" }), ["203.0.113.7 interface", "2001:db8::2 interface"])
assert.deepEqual(rows({ ip: "198.51.100.1", ipv4: "203.0.113.7" }), ["203.0.113.7 interface"])
// NAT: the exit replaces the private interface address, which nobody outside can use.
assert.deepEqual(rows({ ip: "203.0.113.7", ipv4: "10.10.2.250" }), ["203.0.113.7 exit"])
assert.deepEqual(rows({ ip: "203.0.113.7", ipv4: "100.64.0.9" }), ["203.0.113.7 exit"])
// An LXC guest behind NAT with a public /128, reached over v4 by a current agent...
assert.deepEqual(rows({ ip: "203.0.113.7", ipv4: "10.10.1.5", ipv6: "2401:b60:1c::5" }), ["203.0.113.7 exit", "2401:b60:1c::5 interface"])
// ...and over v6 by an older one reporting the ULA ahead of it.
assert.deepEqual(rows({ ip: "2401:b60:1c::5", ipv4: "10.10.1.5", ipv6: "fd42:43af::1" }), ["2401:b60:1c::5 exit"])
// Behind a transparent proxy the exit is the proxy's; the home line can only be set by hand.
const home = { ip: "198.51.100.77", ipv4: "192.168.1.5", ipv6: "2409:8a1e::5" }
assert.deepEqual(rows(home), ["198.51.100.77 exit", "2409:8a1e::5 interface"])
assert.deepEqual(rows({ ...home, ipv4_pin: "203.0.113.50" }), ["203.0.113.50 manual", "2409:8a1e::5 interface"])
// A pin wins over a public interface too, and may name a private address for use on the LAN.
assert.deepEqual(rows({ ipv4: "203.0.113.7", ipv6: "2001:db8::5", ipv6_pin: "2001:db8::9" }), ["203.0.113.7 interface", "2001:db8::9 manual"])
assert.deepEqual(rows({ ip: "203.0.113.7", ipv4: "10.0.0.2", ipv4_pin: "10.0.0.2" }), ["10.0.0.2 manual"])
// No interface in the exit's family: a translator (NAT64, WARP) that does not lead to the machine.
assert.deepEqual(rows({ ip: "104.28.1.1", ipv6: "2001:db8::5" }), ["2001:db8::5 interface"])
// Nothing public anywhere: hub and node share a network, and the private addresses are all there is.
assert.deepEqual(rows({ ip: "192.168.1.2", ipv4: "192.168.1.5" }), ["192.168.1.5 interface"])
assert.deepEqual(rows({ ip: "fd00::2", ipv4: "10.0.0.2", ipv6: "fd00::5" }), ["10.0.0.2 interface", "fd00::5 interface"])
assert.deepEqual(rows({ ip: "198.18.0.1", ipv4: "192.168.1.5" }), ["192.168.1.5 interface"], "a TUN proxy's fake-IP range is not public")
// With no interface reported the connection is all there is, and nothing says it is not the machine's own.
assert.deepEqual(rows({ ip: "203.0.113.7" }), ["203.0.113.7 connection"])
assert.deepEqual(rows({ ipv4: "10.0.0.2" }), ["10.0.0.2 interface"])
assert.deepEqual(rows({}), [])
for (const ip of ["10.0.0.1", "172.31.0.1", "192.168.0.1", "100.64.0.1", "127.0.0.1", "169.254.0.1", "0.0.0.1", "192.0.0.4", "198.19.0.1", "224.0.0.1", "fd42::1", "fe80::1", "::1"]) {
  assert.ok(!isPublic(ip), ip)
}
for (const ip of ["1.1.1.1", "100.128.0.1", "172.32.0.1", "192.0.1.1", "198.20.0.1", "2401:b60:1c::5", "3fff::1"]) {
  assert.ok(isPublic(ip), ip)
}
console.log("partial edits, traffic corrections, provisioning and address checks passed")

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
