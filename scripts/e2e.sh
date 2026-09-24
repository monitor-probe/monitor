#!/bin/sh
# Runs one hub binary against one agent binary on loopback: a node is created
# through the panel API, the agent reports into it, and both views of the node
# are checked. Needs curl and jq.
#   scripts/e2e.sh <monitor-hub> <monitor-agent>
# CI pairs each repository's build with the other's latest release, the
# combination every upgrade of either side meets first. Agent CI runs this file
# from the hub's main against the latest hub release, so a change here must keep
# working with that release.
set -eu

HUB=$1
AGENT=$2
URL=http://127.0.0.1:${E2E_PORT:-9951}
DIR=$(mktemp -d)
HUB_PID=
AGENT_PID=

logs() {
	for log in hub agent; do
		if [ -f "$DIR/$log.log" ]; then
			echo "--- $log.log" >&2
			cat "$DIR/$log.log" >&2
		fi
	done
}

# Both logs follow any failure, including a curl or jq that `set -e` stops on.
cleanup() {
	status=$?
	kill $HUB_PID $AGENT_PID 2>/dev/null || true
	[ "$status" -eq 0 ] || logs
	rm -rf "$DIR"
}
trap cleanup EXIT

fail() {
	echo "e2e: $*" >&2
	exit 1
}

# Retries a command every half second for up to 30 seconds.
wait_for() {
	what=$1
	shift
	i=0
	until "$@" >/dev/null 2>&1; do
		i=$((i + 1))
		[ "$i" -le 60 ] || fail "timed out waiting for $what"
		sleep 0.5
	done
}

reported() {
	curl -fs "$URL/api/nodes" | jq -e '.nodes[0] | .online and .metrics != null'
}

"$HUB" --listen "${URL#http://}" --db "$DIR/hub.db" --themes "$DIR/themes" >"$DIR/hub.log" 2>&1 &
HUB_PID=$!
wait_for "the hub to listen" curl -fs "$URL/api/me"
PASSWORD=$(sed -n 's/.*Emergency password: //p' "$DIR/hub.log")
[ -n "$PASSWORD" ] || fail "the hub printed no password"

COOKIE=$(curl -fsS -D - -o /dev/null -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}" \
	"$URL/api/auth/login" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(monitor_session=[^;]*\).*/\1/p')
[ -n "$COOKIE" ] || fail "sign-in returned no session cookie"

# Provisioning answers only a panel on an https domain entry; these two headers
# are what a browser sends from one.
curl -fsS -o /dev/null -H "Cookie: $COOKIE" -H 'Origin: https://hub.example.com' -H 'Sec-Fetch-Site: same-origin' \
	-H 'content-type: application/json' -d '{"name":"e2e","remark":"e2e-remark"}' "$URL/api/nodes" ||
	fail "creating a node was refused"
TOKEN=$(curl -fsS -H "Cookie: $COOKIE" "$URL/api/nodes" | jq -r '.nodes[0].token // empty')
[ -n "$TOKEN" ] || fail "the panel shows no token for the new node"

"$AGENT" --server "$URL" --token "$TOKEN" --interval 1 >"$DIR/agent.log" 2>&1 &
AGENT_PID=$!
wait_for "the node to report" reported
# The panel's frame is cached for up to 1.9 s, and nothing an agent does renews
# it, so the one taken above for the token may still predate the connection.
sleep 2

PUBLIC=$(curl -fsS "$URL/api/nodes")
ADMIN=$(curl -fsS -H "Cookie: $COOKIE" "$URL/api/nodes")

# The public check below would pass on a node that has no private fields at
# all, so the panel's view must carry them first.
echo "$ADMIN" | jq -e '.nodes[0] | .remark == "e2e-remark" and (.hostname // "") != "" and (.ip // "") != "" and (.token // "") != ""' \
	>/dev/null || fail "the panel's view lacks the private fields: $ADMIN"

# No address, hostname, note or token reaches a visitor, neither under its own
# key nor as a value anywhere else in the response.
LEAKED=$(jq -nc --argjson a "$ADMIN" --argjson p "$PUBLIC" '
	[$p.nodes[0] | keys[] | select(IN("ip", "ipv4", "ipv6", "ipv4_pin", "ipv6_pin", "ipv4_auto", "ipv6_auto", "addresses", "hostname",
		"remark", "token"))]
	+ ([$p | .. | strings] as $shown
		| [$a.nodes[0] | .ip, .ipv4, .ipv6, .hostname, .remark, .token | select(. != "" and IN($shown[]))])')
[ "$LEAKED" = "[]" ] || fail "the public view discloses $LEAKED: $PUBLIC"

# Both official themes drop a node from the page when any of these is not a
# non-negative number.
BAD=$(echo "$PUBLIC" | jq -c '.nodes[0].metrics as $m
	| ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
		"net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"]
	| map(select(($m[.] | type) != "number" or $m[.] < 0))')
[ "$BAD" = "[]" ] || fail "the public metrics lack numeric $BAD: $PUBLIC"

# Sent once per connection, and stored silently empty when a name changes.
BAD=$(echo "$PUBLIC" | jq -c '.nodes[0] | {os, arch, cpu_cores, mem_total, agent_version}
	| to_entries | map(select(.value == "" or .value == 0 or .value == null) | .key)')
[ "$BAD" = "[]" ] || fail "the node's facts lack $BAD: $PUBLIC"

# The hub's own contract check; its warning is the only trace of a field the
# agent no longer sends that the views above do not carry, such as boot_id.
if grep -q 'reports without' "$DIR/hub.log"; then
	fail "the hub finds fields missing from the agent's reports"
fi

echo "e2e: $("$HUB" --help | head -1) with agent $(echo "$PUBLIC" | jq -r '.nodes[0].agent_version'): ok"
