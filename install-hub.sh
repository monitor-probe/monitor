#!/bin/sh
# monitor hub installer.
#
#   curl -fsSL https://github.com/monitor-probe/monitor/releases/latest/download/install-hub.sh -o install-hub.sh
#   chmod +x install-hub.sh
#   sudo ./install-hub.sh
#
# Menu-driven when a terminal is available. A plain `curl ... | sh` has no
# terminal to read answers from, so it installs with the defaults rather than
# waiting on an invisible prompt.
set -eu
# useradd resides in sbin, which a root shell entered through `su` without `-`
# lacks on Debian: su keeps the caller's PATH unless ALWAYS_SET_PATH is set, and
# Debian does not set it.
PATH="$PATH:/usr/sbin:/sbin"
# A signal becomes an exit, so the EXIT traps that remove staged files run:
# dash runs none for a signal that kills it.
trap 'exit 1' HUP INT TERM

REPO="monitor-probe/monitor"
SERVICE="monitor-hub"
UNIT="/etc/systemd/system/monitor-hub.service"
# Everything but the unit lives under one directory: the two binaries at the top,
# and everything the hub writes -- database and themes/ -- under data/. One path
# to back up, one to move to another host, and the same split the container image
# uses, where data/ is mounted at /data.
ROOT="/opt/monitor"
BIN="$ROOT/monitor-hub"
DATA="$ROOT/data"
# A fixed data directory requires a fixed owner: DynamicUser= selects its uid at
# start, and a recycled one would leave the database unreadable.
USER_NAME="monitor"
PORT="28080"
PORT_SET=""
SITE=""
SITE_SET=""
YES=""
PURGE=""
ACTION=""

# ---- ui ----
# Colour only to a terminal, and never when NO_COLOR is set: the output of a
# piped run belongs in a log rather than in escape sequences.
if [ -t 1 ] && [ -z "${NO_COLOR-}" ]; then
	B="$(printf '\033[1m')" D="$(printf '\033[2m')" N="$(printf '\033[0m')"
	G="$(printf '\033[32m')" R="$(printf '\033[31m')" Y="$(printf '\033[33m')"
else
	B="" D="" N="" G="" R="" Y=""
fi

rule() { printf '  %s────────────────────────────────────────────%s\n' "$D" "$N"; }

banner() {
	if [ -t 1 ]; then printf '\033[H\033[2J'; fi
	printf '\n  %smonitor hub%s  %s·%s  安装器\n' "$B" "$N" "$D" "$N"
	rule
	printf '\n'
}

# Every label below is deliberately two CJK characters wide: printf pads by byte
# count, so any other width would break the column.
ok() { printf '  %s✓%s  %s    %s%s%s\n' "$G" "$N" "$1" "$D" "${2-}" "$N"; }
field() { printf '  %s%s%s    %s\n' "$D" "$1" "$N" "$2"; }
warn() { printf '  %s!%s  %s\n' "$Y" "$N" "$1"; }
die() { printf '  %s✗%s  %s\n' "$R" "$N" "$1" >&2; exit 1; }

# A default answer on Enter, and the same default when there is no terminal.
ask() {
	if [ ! -t 0 ]; then printf '%s' "$2"; return; fi
	printf '  %s?%s  %s %s[%s]%s ' "$Y" "$N" "$1" "$D" "$2" "$N" >&2
	read -r reply || reply=""
	printf '%s' "${reply:-$2}"
}

confirm() {
	if [ -n "$YES" ]; then return 0; fi
	if [ ! -t 0 ]; then die "$1（非交互运行时加 --yes 确认）"; fi
	printf '  %s?%s  %s  %s[y/N]%s ' "$Y" "$N" "$1" "$D" "$N"
	read -r reply || reply=""
	case "$reply" in y | Y | yes) return 0 ;; *) printf '  已取消\n'; return 1 ;; esac
}

press() {
	if [ ! -t 0 ]; then return 0; fi
	printf '\n  %s回车返回菜单%s ' "$D" "$N"
	read -r _ || true
}

# A copy of this script saved on the machine may be several releases old, and
# re-running it is the documented way to upgrade: it would rewrite the unit by
# that version's rules. The release publishes this script and hashes it
# alongside the binary, so a saved copy measures itself before the menu or the
# install and, when stale, replaces itself and hands the same request to the
# new copy. The replacement is unconditional: the stale rules are never the
# wanted ones, and an unattended run cannot answer a prompt. The new copy is
# held to the checksum file the binary is, so it is trusted exactly as far as
# the binary the install fetches.
#
# A piped run has no file to measure and needs none: it was fetched a moment
# ago. The marker keeps `curl | sh`, whose $0 is "sh", from measuring a file of
# that name in the working directory.
check_self() {
	[ -f "$0" ] && grep -qxF '# monitor hub installer.' "$0" 2>/dev/null || return 0
	base="https://github.com/$REPO/releases/latest/download"
	self="$(mktemp -d)"
	trap 'rm -rf "$self"' EXIT
	# GitHub out of reach is reported by the install, which needs it as well;
	# the menu's other entries do not. A release published before the script
	# was an asset carries no line for it.
	want=""
	if curl -fsSL --max-time 30 "$base/sha256sums.txt" -o "$self/sums" 2>/dev/null; then
		want="$(sed -n 's/^\([0-9a-f]\{64\}\)  *install-hub.sh$/\1/p' "$self/sums")"
	fi
	if [ -z "$want" ] || [ "$(sha256sum "$0" | cut -d' ' -f1)" = "$want" ]; then
		rm -rf "$self"
		trap - EXIT
		return 0
	fi

	warn "这份脚本不是最新发布的那一版，先换成新的"
	curl -fsSL --max-time 30 "$base/install-hub.sh" -o "$self/new" || die "新脚本下载失败：$base/install-hub.sh"
	[ "$(sha256sum "$self/new" | cut -d' ' -f1)" = "$want" ] || die "新脚本校验不通过，已丢弃，$0 未改动"
	# Written through the existing file, which keeps its mode and owner. The shell
	# reads nothing further from it: exec follows.
	cat "$self/new" >"$0" || die "写不进 $0。手动更新：curl -fsSL $base/install-hub.sh -o $0"
	rm -rf "$self"
	ok "脚本" "已更新"
	# The parser consumed "$@", so the request is rebuilt from what it recorded;
	# only the menu or an install reaches here.
	set --
	[ -z "$PORT_SET" ] || set -- "$@" --port "$PORT"
	[ -z "$SITE_SET" ] || set -- "$@" --site "$SITE"
	[ -z "$YES" ] || set -- "$@" --yes
	exec sh "$0" "$@"
}

check_port() {
	case "$1" in "" | *[!0-9]*) die "端口必须是 1-65535 的整数：$1" ;; esac
	[ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die "端口必须是 1-65535 的整数：$1"
}

# The installed unit's ExecStart without the key, continuation lines joined;
# empty when nothing is installed.
old_line() {
	sed -n '/^ExecStart=/{:a;/\\$/{N;s/\\\n[[:space:]]*/ /;ba;};s/^ExecStart=//p;}' "$UNIT" 2>/dev/null | tail -n 1
}

# The `--listen ...` tail of the installed unit's ExecStart, empty when nothing
# is installed. An upgrade rewrites the unit, so anything not supplied on the
# command line must be recovered from the old one, or re-running to upgrade
# would silently reset the port and drop --site.
old_exec() {
	line="$(old_line)"
	case "$line" in *"--listen "*) printf '%s' "${line#*--listen }" ;; esac
}

# The value the installed unit gives the option named, empty when it gives none.
old_arg() {
	name="$1"
	set -f
	# shellcheck disable=SC2046 # split into words, as systemd does
	set -- $(old_line)
	set +f
	while [ $# -ge 2 ]; do
		if [ "$1" = "$name" ]; then
			printf '%s' "$2"
			return 0
		fi
		shift
	done
}

# The arguments of the installed unit's ExecStart that the rewrite does not
# carry over, empty when there are none. The rewrite keeps the port of a
# loopback --listen and --site, and writes the default --db, so anything else
# -- another listen address, a --themes -- is lost on upgrade, which is said
# rather than done silently.
dropped_args() {
	set -f
	# shellcheck disable=SC2046 # split into words, as systemd does
	set -- $(old_line)
	set +f
	[ $# -gt 0 ] || return 0
	shift
	out=""
	while [ $# -gt 0 ]; do
		if [ $# -ge 2 ] && { [ "$1" = --site ] ||
			{ [ "$1" = --listen ] && case "$2" in 127.0.0.1:*) true ;; *) false ;; esac; } ||
			{ [ "$1" = --db ] && [ "$2" = "$DATA/monitor.db" ]; }; }; then
			shift 2
		else
			out="$out $1"
			shift
		fi
	done
	printf '%s' "${out# }"
}

# The port that unit listens on, empty when there is none. Read twice: once for
# the carry-over and once for the default the menu offers, since pressing Enter
# there must leave a running deployment unchanged.
old_port() {
	listen="$(old_exec)"
	case "$listen" in
	*:[0-9]*) listen="${listen%% *}"; printf '%s' "${listen##*:}" ;;
	esac
}

# ---- install ----
install_hub() {
	case "$(uname -m)" in
	x86_64 | amd64) arch=x86_64 ;;
	aarch64 | arm64) arch=aarch64 ;;
	*) die "不支持的架构：$(uname -m)（发布的是 x86_64 与 aarch64）" ;;
	esac
	asset="monitor-hub-$arch-unknown-linux-musl"
	base="https://github.com/$REPO/releases/latest/download"
	ok "架构" "$arch"

	# Whatever the command line did not specify is recovered from the old unit;
	# see old_exec.
	if [ -z "$PORT_SET" ]; then
		carried="$(old_port)"
		[ -z "$carried" ] || PORT="$carried"
	fi
	if [ -z "$SITE_SET" ]; then
		carried="$(old_exec)"
		case "$carried" in
		*--site\ *) SITE="${carried##*--site }"; SITE="${SITE%% *}" ;;
		esac
	fi
	check_port "$PORT"
	# The rewrite points the hub at the default database. One kept elsewhere
	# would make this a first install on an empty database, with every node
	# offline and the traffic totals apparently reset.
	db="$(old_arg --db)"
	[ -z "$db" ] || [ "$db" = "$DATA/monitor.db" ] ||
		die "单元里的数据库是 $db，不是 $DATA/monitor.db：升级会换成一个空库。先停服务，把库连同 -wal、-shm 挪到 $DATA，再重跑"
	dropped="$(dropped_args)"
	[ -z "$dropped" ] ||
		warn "单元里的 $dropped 不会保留：升级按新版重写单元，只沿用端口和 --site。要长期改单元，用 systemctl edit $SERVICE"
	# A drop-in that sets ExecStart takes precedence over the unit written here,
	# so the port and --site given to this script would not take effect.
	for dropin in "$UNIT.d"/*.conf; do
		if [ -f "$dropin" ] && grep -q '^ExecStart=' "$dropin"; then
			warn "$dropin 里另写了 ExecStart，它优先于这里写的单元：端口和 --site 以它为准"
		fi
	done

	# Before anything is stopped, replaced or downloaded: a port conflict must
	# leave the running hub untouched. The hub's own socket is never a conflict,
	# determined by pid rather than by the port written in the unit -- one this
	# script did not write, whether hand-edited or with ExecStart split across
	# lines, parses out empty, and the hub already on the port would be reported
	# as an unrelated process occupying it.
	if command -v ss >/dev/null 2>&1; then
		holder="$(ss -ltnpH "sport = :$PORT" 2>/dev/null |
			sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
		if [ -n "$holder" ] &&
			[ "$holder" != "$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)" ]; then
			die "端口 $PORT 已被其它程序占用，换一个：--port <n>"
		fi
	fi

	id -u "$USER_NAME" >/dev/null 2>&1 ||
		useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME" ||
		die "无法创建系统用户 $USER_NAME"
	install -d -m 0755 "$ROOT"
	# A run killed outright leaves its staging directory, which holds a whole
	# binary; one untouched for an hour belongs to no live run.
	find "$ROOT" -maxdepth 1 -name '.hub-install-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
	# 0700 owned by the service user, so its group is irrelevant and nothing here
	# depends on useradd having created one.
	install -d -m 0700 -o "$USER_NAME" "$DATA"

	# Only a missing database makes this a first install, which sets the
	# password. Checked before anything is installed.
	first=""
	[ -f "$DATA/monitor.db" ] || first=1

	# The tag comes from GitHub's own redirect for "latest", so there is no API
	# call to be rate-limited and no JSON to parse. Only the first hop carries it
	# -- the chain ends on release-assets.githubusercontent.com, whose URL
	# contains no tag -- so this must not follow redirects. A missing asset still
	# redirects, so the download below is what catches an architecture that was
	# never published.
	tag="$(curl -fsSI -o /dev/null -w '%{redirect_url}' "$base/$asset" 2>/dev/null |
		sed -n 's#.*/download/\([^/]*\)/.*#\1#p')" || true
	[ -n "$tag" ] || die "查不到最新发布版；GitHub 不可达，或还没有任何发布"
	ok "版本" "$tag"

	# Everything is written while the old hub still serves, under names of this
	# run's own beside the final ones, the download included: a full disk then
	# stops the script before the service is touched, a partial file never takes
	# a final name, and the stop below is followed by renames, which need no
	# space. The trap is reset on each call, since the menu installs more than
	# once per run.
	stage="$(mktemp -d "$ROOT/.hub-install-XXXXXX")"
	unit_new=""
	trap 'rm -rf "$stage"; [ -z "$unit_new" ] || rm -f "$unit_new"' EXIT
	rc=0
	curl -fsSL --max-time 300 "$base/$asset" -o "$stage/$asset" || rc=$?
	# 23 is curl's write error.
	[ "$rc" != 23 ] || die "写入新版本失败，磁盘可能满了；运行中的 hub 没有动"
	[ "$rc" = 0 ] || die "二进制下载失败：$base/$asset"
	ok "下载" "$(du -h "$stage/$asset" | cut -f1)"

	# Verified against the release's own checksum file, so a truncated transfer or
	# a substituted asset is caught before anything lands in /opt/monitor.
	curl -fsSL --max-time 30 "$base/sha256sums.txt" -o "$stage/sums" ||
		die "校验文件下载失败"
	want="$(sed -n "s/^\([0-9a-f]\{64\}\)  *$asset\$/\1/p" "$stage/sums")"
	[ -n "$want" ] || die "sha256sums.txt 里没有 $asset 这一项"
	got="$(sha256sum "$stage/$asset" | cut -d' ' -f1)"
	[ "$got" = "$want" ] || die "校验不通过，已丢弃下载的文件。期望 $want，实得 $got"
	ok "校验" "sha256 一致"

	# Loopback only: the panel and the agent tokens never traverse a network in
	# the clear, and there is no port to firewall. Reaching it is the reverse
	# proxy's responsibility, and 127.0.0.1 rather than [::1] because that is
	# every proxy's default upstream; the hub binds one address, not both.
	args="--listen 127.0.0.1:$PORT --db $DATA/monitor.db"
	[ -z "$SITE" ] || args="$args --site $SITE"
	unit_new="$(mktemp "$UNIT.install-XXXXXX")"
	cat >"$unit_new" <<UNIT
[Unit]
Description=monitor hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN $args
Restart=always
RestartSec=5
# The database and the themes/ directory beside it live in data/, which is the
# only path this service may write to, excluding even the binary above it.
User=$USER_NAME
WorkingDirectory=$ROOT
ReadWritePaths=$DATA
NoNewPrivileges=yes
RestrictSUIDSGID=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
# AF_UNIX is what if_nametoindex(3) opens to read a nameserver such as
# fe80::1%wlan0 in resolv.conf; without it musl skips that nameserver, and when
# it is the only one every lookup fails with "Try again".
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT
	chmod 0644 "$unit_new"

	# Keep the old binary until the new one has proved it starts: a failed upgrade
	# must leave a running hub rather than a dead service.
	backup=""
	if [ -f "$BIN" ]; then
		backup="$BIN.old"
		# Never over an existing backup. A run that died between the install below
		# and the health check left $BIN holding a binary that never proved it
		# starts; copying that over the good backup would make the rollback restore
		# the same broken binary while reporting success. A hard link: $BIN is
		# replaced by a rename, which leaves this inode as it was, and a link takes
		# no space.
		if [ ! -f "$backup" ]; then
			ln "$BIN" "$stage/old" 2>/dev/null || cp -f "$BIN" "$stage/old" ||
				die "备份当前版本失败，磁盘可能满了；运行中的 hub 没有动"
		fi
	fi
	chmod 0755 "$stage/$asset"
	# From the stop to the health check the hub is down or unproven, and an
	# interrupted run would leave it so: a signal there is ignored, until the
	# hub serves again or the rollback has run.
	trap '' HUP INT TERM
	# Stopped first so the new binary does not land beneath a live process.
	systemctl stop "$SERVICE" 2>/dev/null || true
	[ ! -f "$stage/old" ] || mv -f "$stage/old" "$backup"
	mv -f "$stage/$asset" "$BIN"
	mv -f "$unit_new" "$UNIT"
	# Cleared here as well as on EXIT because the menu calls this more than once
	# per run and each call replaces the trap, leaving the previous directory
	# uncollected.
	rm -rf "$stage"
	trap - EXIT

	# Taken from the binary's stdout rather than the journal, which some hosts
	# keep nowhere. Set before the service starts, so the hub finds a password in
	# place and does not generate a second one. A reset refuses a missing
	# database, so the file is created first under the service user; SQLite reads
	# an empty file as an empty database.
	pw=""
	if [ -n "$first" ]; then
		install -m 0600 -o "$USER_NAME" /dev/null "$DATA/monitor.db"
		pw="$(new_password)"
	fi

	systemctl daemon-reload
	systemctl enable "$SERVICE" >/dev/null 2>&1 || true
	# Not left to set -e: a binary that cannot exec fails the job itself, which is
	# precisely the case the rollback below exists for. Unguarded, the script
	# would exit here with a raw systemd error and leave the hub down on the
	# binary that just failed.
	systemctl restart "$SERVICE" || true
	# is-active answers before a unit that exits immediately has done so. Wait,
	# then query.
	sleep 3
	if ! systemctl is-active --quiet "$SERVICE"; then
		# A first install has nothing to keep serving, so there is no rollback.
		# The new database holds nothing but a password never shown; it is removed
		# so that a rerun is again a first install and shows one, and the unit is
		# disabled, since any binary it started later -- on a reboot as well --
		# would set a password on an empty database and print it only to the
		# journal. A backup, if any, stays for the next run.
		if [ -n "$first" ]; then
			systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
			rm -f "$DATA/monitor.db" "$DATA/monitor.db-wal" "$DATA/monitor.db-shm"
			die "服务启动失败。日志：journalctl -u $SERVICE -n 50"
		fi
		if [ -n "$backup" ]; then
			mv -f "$backup" "$BIN"
			systemctl restart "$SERVICE" 2>/dev/null || true
			die "新版本没能启动，已回滚到上一版。日志：journalctl -u $SERVICE -n 50"
		fi
		die "服务启动失败。日志：journalctl -u $SERVICE -n 50"
	fi
	rm -f "$BIN.old"
	trap 'exit 1' HUP INT TERM
	ok "服务" "已启动并开机自启"

	if [ -n "$first" ]; then done_title="安装完成"; else done_title="升级完成"; fi
	printf '\n  %s%s%s\n' "$B" "$done_title" "$N"
	rule
	printf '\n'
	field "面板" "${SITE:-http://127.0.0.1:$PORT}/admin"
	if [ -n "$first" ]; then
		if [ -n "$pw" ]; then
			field "密码" "$pw"
			field "    " "${D}记下来，登录后到「安全」里改掉${N}"
		else
			field "密码" "没取到，重跑安装器选「重置密码」"
		fi
	fi
	field "数据" "$DATA/monitor.db"
	field "服务" "systemctl status $SERVICE"
	field "日志" "journalctl -u $SERVICE -f"
	printf '\n'

	# The hub is on loopback, so this is the remaining half of the install rather
	# than optional advice. It deliberately omits --site: the panel builds install
	# commands from the browser's own address, so once the domain works everything
	# downstream follows.
	if [ -z "$SITE" ]; then
		printf '  %s还差一步：配个反向代理%s\n' "$B" "$N"
		printf '     面板只监听本机，公网访问不到——这是故意的，凭证不会在链路上裸奔。\n'
		printf '     用 nginx / caddy / cf tunnel 任选一种，把 hub.example.com 换成你的域名，\n'
		printf '     配好之后用域名访问面板，我相信这难不倒你。\n'
		# The documented configurations use the default port.
		[ "$PORT" = 28080 ] || printf '     文档里的 28080 换成 %s。\n' "$PORT"
		printf '     反向代理文档：https://monitor-document.pages.dev/install/reverse-proxy\n'
	fi
}

# ---- password ----
# Prints nothing on failure; the hub's own error reaches stderr. Running as root
# is safe: SQLite gives the -wal and -shm files it creates the database file's
# owner.
new_password() {
	"$BIN" --db "$DATA/monitor.db" --reset-password | sed -n 's/^Emergency password: //p'
}

reset_password() {
	# The data outlives --uninstall, so the database alone does not mean a hub.
	if [ ! -f "$BIN" ] || [ ! -f "$DATA/monitor.db" ]; then
		die "这台机器上没有装 monitor hub"
	fi
	confirm "重置面板密码？所有已登录的会话都会被登出" || return 0
	pw="$(new_password)"
	# Versions without the flag report "unknown argument" on stderr.
	[ -n "$pw" ] || die "重置失败。上面提示 unknown argument 的话是 hub 版本太旧，先升级"
	field "密码" "$pw"
}

# ---- uninstall ----
uninstall_hub() {
	if [ ! -f "$BIN" ] && [ ! -f "$UNIT" ]; then
		# The data outlives the unit, so --purge still has work to do.
		if [ -n "$PURGE" ] && [ -e "$DATA" ]; then
			confirm "服务已经卸载了。删除 $DATA 下的数据库？不可撤销" || return 0
			rm -rf "$DATA"
			rmdir "$ROOT" 2>/dev/null || true
			ok "数据" "已删除"
			return 0
		fi
		[ ! -e "$DATA" ] || die "服务已经卸载了，数据还留在 $DATA；要一并删掉就加 --purge"
		die "这台机器上没有装 monitor hub"
	fi
	if [ -n "$PURGE" ]; then
		confirm "卸载 monitor hub，并删除 $DATA 下的数据库？不可撤销" || return 0
	else
		confirm "卸载 monitor hub？数据保留在 $DATA" || return 0
	fi
	systemctl disable --now "$SERVICE" 2>/dev/null || true
	rm -f "$UNIT" "$BIN" "$BIN.old" "$UNIT".install-*
	rm -rf "$ROOT"/.hub-install-*
	systemctl daemon-reload
	ok "服务" "已移除"
	if [ -n "$PURGE" ]; then
		rm -rf "$DATA"
		# Only when the agent is not installed alongside it.
		rmdir "$ROOT" 2>/dev/null || true
		ok "数据" "已删除"
	else
		field "数据" "保留在 $DATA，重新安装会直接接着用"
	fi
}

menu() {
	while :; do
		banner
		printf '    1  安装 / 升级\n'
		printf '    2  卸载\n'
		printf '    3  状态\n'
		printf '    4  日志\n'
		printf '    5  重置密码\n'
		printf '    q  退出\n\n'
		printf '  %s›%s ' "$B" "$N"
		read -r choice || exit 0
		printf '\n'
		case "$choice" in
		1)
			# The default offered is what the unit already listens on, so Enter
			# leaves a running deployment unchanged. PORT_SET marks the answer as
			# supplied: without it the carry-over in install_hub would read the port
			# back out of that same unit and discard the answer given here.
			carried="$(old_port)"
			PORT="$(ask "监听端口" "${carried:-$PORT}")"
			check_port "$PORT"
			PORT_SET=1
			printf '\n'
			install_hub
			press
			;;
		2) uninstall_hub; press ;;
		3) systemctl status "$SERVICE" --no-pager || true; press ;;
		4) journalctl -u "$SERVICE" -f --no-pager ;;
		5) reset_password; press ;;
		q | Q | exit | "") exit 0 ;;
		*) ;;
		esac
	done
}

usage() {
	cat <<TXT
monitor hub 安装器

  sudo ./install-hub.sh                有终端时给菜单，否则按默认安装
  sudo ./install-hub.sh --port 8443    指定端口安装
  sudo ./install-hub.sh --uninstall    卸载，保留数据
  sudo ./install-hub.sh --purge        卸载并删除数据库
  sudo ./install-hub.sh --reset-password
                                       重置面板密码，登出所有会话

  --port <n>     本机监听端口，默认 $PORT
  --site <url>   一般不用填。面板拼安装命令用的是浏览器地址栏，配好反代
                 用域名访问就自动对了。三种情况要填：节点该连的域名和你
                 进面板的域名不是同一个；走 SSH 隧道进面板（地址栏是
                 127.0.0.1，节点连不上它）；反代不发 X-Forwarded-Proto
                 （那时会话 cookie 拿不到 Secure 标志）
  --yes, -y      跳过确认
  --help, -h     显示这段

hub 只监听 127.0.0.1，公网访问不到，需要自己配 nginx / caddy / CF 隧道把
域名指过来，配法见 https://monitor-document.pages.dev/install/reverse-proxy

重跑一次就是升级：校验通过后才替换二进制，起不来会自动回滚到上一版；
没写的参数沿用上次的，所以升级不会把端口和 --site 冲掉。
这份脚本不是最新发布的那一版时，会先把自己换成新版再接着装。
二进制和数据都在 $ROOT 下（数据库和主题在 $DATA），卸载默认保留数据。
TXT
}

while [ $# -gt 0 ]; do
	case "$1" in
	# An explicit guard rather than `${2-}`: `shift 2` with nothing to shift is
	# fatal in dash, and the output would be the shell's diagnostic rather than
	# this message.
	--port) [ $# -ge 2 ] || die "--port 后面要跟端口号"; PORT="$2"; PORT_SET=1; shift 2 ;;
	--site) [ $# -ge 2 ] || die "--site 后面要跟地址"; SITE="$2"; SITE_SET=1; shift 2 ;;
	--uninstall) ACTION=uninstall; shift ;;
	--purge) ACTION=uninstall; PURGE=1; shift ;;
	--reset-password) ACTION=reset; shift ;;
	--yes | -y) YES=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) die "未知参数：$1（--help 看用法）" ;;
	esac
done

check_port "$PORT"
# The same form `api::https_domain` measures --site against on the hub, checked
# here because this is where the value is entered. A hub started with a value it
# refuses starts normally and then declines to add or install any node, which
# surfaces only in the journal and the panel, long after the value was typed.
SITE="${SITE%/}"
if [ -n "$SITE" ]; then
	case "$SITE" in
	https://*) ;;
	*) die "--site 必须以 https:// 开头：$SITE" ;;
	esac
	rest="${SITE#https://}"
	case "$rest" in
	*/*) die "--site 后面不能带路径，只要 https://域名[:端口]：$SITE" ;;
	*@*) die "--site 里不能带用户名：$SITE" ;;
	"["*) die "--site 必须是域名，不能是 IP 地址：$SITE" ;;
	esac
	# A port is permitted; what precedes it must be a name rather than an
	# address.
	case "${rest%%:*}" in
	"" | localhost | *.localhost) die "--site 必须是一个域名：$SITE" ;;
	*[!0-9.]*) ;;
	*) die "--site 必须是域名而不是 IP 地址：$SITE" ;;
	esac
fi
[ "$(id -u)" = 0 ] || die "需要 root：sudo sh $0"
command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v sha256sum >/dev/null 2>&1 || die "需要 sha256sum（装 coreutils）"
# systemd by the test sd_booted(3) performs: systemctl is also present where
# systemd is installed but not PID 1 (WSL, a container), where installing would
# fail after the system was changed. A password reset needs no service manager.
need_systemd() {
	[ ! -d /run/systemd/system ] || return 0
	! command -v systemctl >/dev/null 2>&1 || warn "systemd 装了但没在运行（WSL、容器里常见）"
	die "这个安装器只装 systemd 服务。手动运行：$BIN --listen 127.0.0.1:$PORT --db $DATA/monitor.db"
}

case "$ACTION" in
uninstall) need_systemd; banner; uninstall_hub ;;
reset) banner; reset_password ;;
*)
	need_systemd
	check_self
	if [ -t 0 ]; then
		menu
	else
		banner
		install_hub
	fi
	;;
esac
