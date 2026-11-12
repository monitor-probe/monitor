import { useEffect, useRef, useState } from "react"
import { Download, Upload } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

import { ConfirmDialog } from "@/components/common"
import { api, CHUNK, upload } from "@/lib/api"
import { bytes } from "@/lib/format"

type DbInfo = {
  path: string
  size: number
  wal: number
  free: number
  /** Seconds since the earliest history row on the hub's clock, null on a database with none. */
  oldest_ago: number | null
  retention: number
  rows: Record<string, number>
}

// The only tables whose row count indicates anything about size, each kind of
// history in both tiers. Every other holds one row per node or per key.
const DB_ROWS: [string, string][] = [
  ["metric", "历史明细"],
  ["metric_hour", "历史小时汇总"],
  ["ping_record", "延迟记录"],
  ["ping_hour", "延迟小时汇总"],
]

export function Data() {
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [busy, setBusy] = useState("")
  const [confirm, setConfirm] = useState<"vacuum" | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [sent, setSent] = useState(0)
  // Closing the dialog stops the upload rather than merely hiding it: restore is
  // the one irreversible action here. Once the last chunk is on its way it can
  // no longer be stopped, and the dialog stays open until the hub answers.
  const abort = useRef<AbortController | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const load = () => api<DbInfo>("/db").then(setInfo).catch((e: Error) => toast.error(e.message))
  useEffect(() => { load() }, [])

  async function vacuum() {
    setBusy("vacuum")
    try {
      const { pruned, freed } = await api<{ pruned: number; freed: number }>("/db/vacuum", { method: "POST" })
      toast.success(`已清理 ${pruned} 行，回收 ${bytes(freed)}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
      setConfirm(null)
    }
  }

  async function restore(file: File) {
    setBusy("restore")
    setSent(0)
    abort.current = new AbortController()
    try {
      await upload("/db/restore", file, setSent, abort.current.signal)
      toast.success("已恢复，正在重新加载")
      // Every node, setting and session on the page came from the database just
      // replaced.
      setTimeout(() => location.reload(), 800)
    } catch (e) {
      // Aborting before the last chunk is not a failure: the hub replaces
      // nothing until then, so the original database remains.
      const aborted = (e as Error).name === "AbortError"
      if (aborted) toast.info("已取消，数据库没有改动")
      else toast.error((e as Error).message)
      setBusy("")
    }
    setPending(null)
  }

  // `sent` counts acknowledged chunks, so the last one is in flight from here on.
  const applying = busy === "restore" && !!pending && sent + CHUNK >= pending.size
  if (!info) return null
  const stat = (label: string, value: string, className = "") => (
    <div key={label} className={className}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tnum mt-0.5 text-sm">{value}</div>
    </div>
  )

  return (
    <div className="space-y-4">
      <Card className="gap-4 p-5">
        <h3 className="text-sm font-medium">数据库</h3>
        {/* Five columns: the file and the window on one row, the four row counts
            on the next. On two columns the free space takes a row of its own, so
            the window and each kind's two tiers still pair up. */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {stat("文件大小", bytes(info.size))}
          {stat("预写日志", bytes(info.wal))}
          {stat("可回收空间", bytes(info.free), "col-span-2 sm:col-span-1")}
          {stat("保留天数", `${info.retention} 天`)}
          {/* 和保留天数并排：跨度小于保留期是还没攒够，大于保留期就是每小时
              那次 prune 没在跑。 */}
          {stat("历史跨度", info.oldest_ago !== null ? `${Math.floor(info.oldest_ago / 86400)} 天` : "—")}
          {DB_ROWS.map(([key, label]) => stat(label, (info.rows[key] ?? 0).toLocaleString()))}
        </div>
        <p className="truncate text-xs text-muted-foreground" title={info.path}>
          <code>{info.path}</code>
        </p>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">回收空间</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            清掉超出保留天数的历史，再重建数据库文件把空出来的页还给磁盘（SQLite 的 VACUUM）。重建期间需要约为数据库两倍的空闲磁盘，过程中面板和上报会短暂变慢。
          </p>
        </div>
        <div>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setConfirm("vacuum")}>
            {busy === "vacuum" ? "回收中…" : "立即回收"}
          </Button>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">备份</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            导出的是整个数据库，含节点凭证与登录密码哈希，请当作密钥保管。恢复会用备份文件整体覆盖当前数据，当前节点、设置、历史全部作废，所有设备需要重新登录。
            <br />
            请用这里导出的文件恢复：直接复制 <code>monitor.db</code> 会丢掉预写日志里还没落盘的那部分。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* The browser's own download: the file is streamed straight from
              the response, never held in the page. */}
          <Button size="sm" asChild>
            <a href="/api/db/backup" download>
              <Download /> 导出备份
            </a>
          </Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => picker.current?.click()}>
            <Upload /> 导入备份
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".db,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              setPending(e.target.files?.[0] ?? null)
              e.target.value = ""
            }}
          />
        </div>
      </Card>

      {confirm === "vacuum" && (
        <ConfirmDialog
          title="回收空间？"
          description="超出保留天数的历史会被删除，然后重建数据库文件。累计流量不受影响。"
          confirmLabel={busy === "vacuum" ? "回收中…" : "开始回收"}
          busy={!!busy}
          onClose={() => setConfirm(null)}
          onConfirm={vacuum}
        />
      )}
      {pending && (
        <ConfirmDialog
          title="用备份覆盖当前数据？"
          description={`将用 ${pending.name}（${bytes(pending.size)}）整体替换当前数据库。当前的节点、设置和历史全部丢失，且无法撤销。`}
          confirmLabel={busy !== "restore" ? "确认恢复" : applying ? "正在校验并恢复…" : `已上传 ${bytes(sent)} / ${bytes(pending.size)}`}
          busy={!!busy}
          locked={applying}
          onClose={() => { abort.current?.abort(); setPending(null) }}
          onConfirm={() => restore(pending)}
        />
      )}
    </div>
  )
}
