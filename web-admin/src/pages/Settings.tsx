import { useRef } from "react"
import { Upload } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

import { Field, SwitchRow } from "@/components/common"
import { useSettings } from "@/lib/settings"

// The hub's limit on each icon, which keeps both under its 64 KiB body limit.
const ICON_BYTES = 20 * 1024

const decodedBytes = (url: string) => Math.floor(((url.length - url.indexOf(",") - 1) * 3) / 4)

// `img` contained in a `side`-pixel square, centred.
function drawIcon(img: HTMLImageElement, side: number, background: string | null, type: string, quality?: number) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = side
  const context = canvas.getContext("2d")!
  if (background) {
    context.fillStyle = background
    context.fillRect(0, 0, side, side)
  }
  // An SVG without width and height has no intrinsic size; drawn square.
  const w = img.naturalWidth || side
  const h = img.naturalHeight || side
  const scale = side / Math.max(w, h)
  context.drawImage(img, (side - w * scale) / 2, (side - h * scale) / 2, w * scale, h * scale)
  return canvas.toDataURL(type, quality)
}

// The two icons the hub serves from one picked image: the tab icon, an SVG kept
// as it is or anything else scaled to 64 px (32 px at 2x), and the 180 px
// apple-touch-icon iOS puts on the home screen. iOS fills a transparent one
// with black, so it is drawn on white; a photo too detailed for a 20 KiB PNG
// falls back to JPEG.
async function siteIcons(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode().catch(() => {
      throw new Error("这张图片打不开，换一张 PNG、SVG 或 ICO 试试")
    })
    const favicon =
      file.type === "image/svg+xml" && file.size <= ICON_BYTES
        ? await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(new Error("读取图片失败，请重新选择"))
            reader.readAsDataURL(file)
          })
        : drawIcon(img, 64, null, "image/png")
    let touch = drawIcon(img, 180, "#fff", "image/png")
    for (let quality = 0.9; decodedBytes(touch) > ICON_BYTES && quality > 0.3; quality -= 0.15) {
      touch = drawIcon(img, 180, "#fff", "image/jpeg", quality)
    }
    return { favicon, touch_icon: touch }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// `onSaved` refreshes what the header shows, the site name among it.
export function SettingsTab({ onSaved }: { onSaved: () => void }) {
  const { s, set, save } = useSettings()
  const iconPicker = useRef<HTMLInputElement>(null)
  if (!s) return null
  const cdnOnly = s.origin_cdn_only === "on"
  // Applied on its own, as soon as a file is picked: a picked file is already a
  // decision, and the form's save button below is easy to miss for it.
  const saveIcons = (icons: { favicon: string; touch_icon: string }, done: string) =>
    save(icons, done).then((ok) => {
      // The tab's icon is cached under its fixed URL; a new query fetches the
      // one just saved.
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (ok && link) link.href = `/admin/favicon.svg?${Date.now()}`
    })

  return (
    <div className="space-y-4">
      <Card className="gap-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="站点名称">
            <Input value={String(s.site_name ?? "")} onChange={(e) => set("site_name", e.target.value)} placeholder="Monitor" />
          </Field>
          <Field
            label="历史数据保留天数"
            hint="1–365 天，超出的自动清理，累计流量不受影响"
            helpWidth="max-w-66 min-[408px]:max-w-94"
            help={
              <>
                <p>
                  默认 <span className="whitespace-nowrap">30 天</span>，能看约一个月的历史。
                </p>
                <p>
                  最近 <span className="whitespace-nowrap">7 天</span>
                  {"按分钟保存，更早的按小时保存：超过一周的图表上，两者画出来几乎一样，按小时存只占几十分之一的空间。"}
                </p>
                <p>
                  上限 <span className="whitespace-nowrap">365 天</span>。
                </p>
              </>
            }
          >
            <Input
              type="number"
              value={String(s.retention_days ?? "")}
              onChange={(e) => set("retention_days", e.target.value)}
              placeholder="30"
            />
          </Field>
          <Field label="站点图标" hint="标签页、书签和手机主屏幕上的图标，选好即生效，换主题也保留">
            <div className="flex items-center gap-2">
              {!s.favicon && <span className="text-sm text-muted-foreground">默认</span>}
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md border">
                <img src={String(s.favicon || "/favicon.svg?theme")} alt="站点图标" className="size-6 object-contain" />
              </div>
              <Button size="sm" variant="outline" onClick={() => iconPicker.current?.click()}>
                <Upload /> 选择图标
              </Button>
              {s.favicon && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => saveIcons({ favicon: "", touch_icon: "" }, "已换回主题自带的图标")}
                >
                  用主题自带的
                </Button>
              )}
              <input
                ref={iconPicker}
                type="file"
                accept="image/png,image/x-icon,image/svg+xml,image/webp,image/jpeg,image/gif,.ico"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ""
                  if (!file) return
                  siteIcons(file).then(
                    (icons) => saveIcons(icons, "站点图标已更新"),
                    (e: Error) => toast.error(e.message),
                  )
                }}
              />
            </div>
          </Field>
          <Field
            label="GitHub 代理"
            hint="留空直连，只在 hub 拉不到 GitHub Release 时填"
            helpWidth="max-w-58 min-[376px]:max-w-86"
            help={<p>agent 有签名校验，主题包没有，只填信得过的镜像。</p>}
          >
            <Input
              value={String(s.github_proxy ?? "")}
              onChange={(e) => set("github_proxy", e.target.value)}
              placeholder="https://ghfast.top"
            />
          </Field>
        </div>
        <div className="space-y-4">
          <SwitchRow
            label="开放公开状态页"
            hint="关闭后所有页面需登录"
            checked={s.public_page !== "off"}
            onChange={(v) => set("public_page", v ? "on" : "off")}
          />
          <SwitchRow
            label="我确认源站只对 Cloudflare 或隧道开放"
            hint="登录通知和限流取访客的真实地址"
            extra={
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>保存后核对，当前认出你的地址</span>
                <code className="rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-foreground select-all">
                  {String(s.your_address ?? "未知")}
                </code>
              </p>
            }
            helpWidth="max-w-62 min-[392px]:max-w-90 min-[440px]:max-w-104"
            help={
              <>
                <p>打开前先确认源站只有 Cloudflare 连得上：用隧道，源站不开公网端口；或让 Cloudflare 回源带一个密钥头，反代没带就拒绝。</p>
                <p>只放行 Cloudflare 的回源地址不够，别人的 Worker 也从那些地址连过来。</p>
                <p>
                  不是却打开，别人直连源站自己写 <span className="whitespace-nowrap">CF-Connecting-IP</span> 或{" "}
                  <span className="whitespace-nowrap">X-Forwarded-For</span>，就能每次换一个地址猜密码，限流形同虚设。
                </p>
                <p>别家 CDN 用不上这个开关，在反代上配 realip。</p>
              </>
            }
            checked={cdnOnly}
            onChange={(v) => set("origin_cdn_only", v ? "on" : "off")}
          />
        </div>
        <div>
          <Button
            size="sm"
            onClick={() =>
              save({
                site_name: String(s.site_name ?? ""),
                // `||` rather than `??`: an emptied box saves the default, ""
                // being the one value this key's write path refuses.
                retention_days: String(s.retention_days || "30"),
                github_proxy: String(s.github_proxy ?? ""),
                origin_cdn_only: s.origin_cdn_only === "on" ? "on" : "off",
                public_page: s.public_page === "off" ? "off" : "on",
              }).then((ok) => ok && onSaved())
            }
          >
            保存站点设置
          </Button>
        </div>
      </Card>
    </div>
  )
}
