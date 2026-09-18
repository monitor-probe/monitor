/// <reference types="node" />
import assert from "node:assert/strict"
import { addresses, changes, GIB, isExit, isPublic, provisioningSite, trafficCorrection } from "./api.ts"

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
// NAT: the exit the connection left by leads the private interface of its family.
assert.deepEqual(addresses({ ip: "203.0.113.7", ipv4: "10.10.2.250", ipv6: "2001:db8::1" }), ["203.0.113.7", "10.10.2.250", "2001:db8::1"])
assert.deepEqual(addresses({ ip: "203.0.113.7", ipv4: "100.64.0.9" }), ["203.0.113.7", "100.64.0.9"])
// The same over v6: an older agent reporting the ULA of an LXC guest whose public /128 sits on another interface.
const lxc = { ip: "2401:b60:1c::5", ipv4: "10.10.1.5", ipv6: "fd42:43af::1" }
assert.deepEqual(addresses(lxc), ["10.10.1.5", "2401:b60:1c::5", "fd42:43af::1"])
assert.ok(isExit(lxc, "2401:b60:1c::5") && !isExit(lxc, "fd42:43af::1"))
// A home network whose gateway proxies the hub connection: the exit is shown, and marked as one.
const home = { ip: "198.51.100.77", ipv4: "192.168.1.5", ipv6: "2409:8a1e::5" }
assert.deepEqual(addresses(home), ["198.51.100.77", "192.168.1.5", "2409:8a1e::5"])
assert.ok(isExit(home, "198.51.100.77") && !isExit(home, "192.168.1.5") && !isExit(home, "2409:8a1e::5"))
// Hub on the same network, or on the same machine: the connection says nothing more.
assert.deepEqual(addresses({ ip: "192.168.1.2", ipv4: "192.168.1.5" }), ["192.168.1.5"])
assert.deepEqual(addresses({ ip: "127.0.0.1", ipv4: "172.16.0.5" }), ["172.16.0.5"])
assert.deepEqual(addresses({ ip: "fd00::2", ipv4: "10.0.0.2", ipv6: "fd00::5" }), ["10.0.0.2", "fd00::5"])
// A public interface is the machine; an exit elsewhere is a proxy in front of it.
assert.deepEqual(addresses({ ip: "198.51.100.1", ipv4: "203.0.113.7" }), ["203.0.113.7"])
const direct = { ip: "2001:db8::2", ipv4: "10.0.0.2", ipv6: "2001:db8::2" }
assert.deepEqual(addresses(direct), ["10.0.0.2", "2001:db8::2"])
assert.ok(!isExit(direct, "2001:db8::2"), "an address the interface holds is no exit, even when the connection used it")
// No interface in the exit's family: a translator (NAT64, WARP) that does not lead to the machine.
assert.deepEqual(addresses({ ip: "104.28.1.1", ipv6: "2001:db8::5" }), ["2001:db8::5"])
// A TUN-mode proxy's fake-IP range and CGNAT are not public, whichever side they turn up on.
assert.deepEqual(addresses({ ip: "198.18.0.1", ipv4: "192.168.1.5" }), ["192.168.1.5"])
assert.deepEqual(addresses({ ip: "203.0.113.7", ipv4: "198.18.0.1" }), ["203.0.113.7", "198.18.0.1"])
// Without interface addresses `ip` is all there is; without a connection, the interfaces are.
assert.deepEqual(addresses({ ip: "203.0.113.7" }), ["203.0.113.7"])
assert.ok(!isExit({ ip: "203.0.113.7" }, "203.0.113.7"), "with no interface reported, nothing says the address is not the machine's")
assert.deepEqual(addresses({ ipv4: "10.0.0.2" }), ["10.0.0.2"])
assert.deepEqual(addresses({}), [])
for (const ip of ["10.0.0.1", "172.31.0.1", "192.168.0.1", "100.64.0.1", "127.0.0.1", "169.254.0.1", "0.0.0.1", "192.0.0.4", "198.19.0.1", "224.0.0.1", "fd42::1", "fe80::1", "::1"]) {
  assert.ok(!isPublic(ip), ip)
}
for (const ip of ["1.1.1.1", "100.128.0.1", "172.32.0.1", "192.0.1.1", "198.20.0.1", "2401:b60:1c::5", "3fff::1"]) {
  assert.ok(isPublic(ip), ip)
}
console.log("partial edits, traffic corrections, provisioning and address checks passed")
