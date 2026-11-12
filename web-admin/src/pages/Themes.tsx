import { useEffect, useRef, useState } from "react"
import { Download, Palette, RefreshCw, SlidersHorizontal, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

import { ConfirmDialog, Field, Help, OptionRow, TEXT_BOX } from "@/components/common"
import { api, type ConfigField, configFields, configForm, configOverrides, configSections, configValues, fits, upload } from "@/lib/api"

type Theme = {
  name: string
  short: string
  description: string
  version: string
  author: string
  url: string
  selected: boolean
  // 内置主题在二进制里，没有目录可删。装上一份同名的会顶替它，那一份就是普通
  // 主题，删掉之后内置的重新顶上。
  builtin: boolean
  // theme.json 里声明的设置表单，原样转过来，由 configFields 挑出能画的字段。
  config?: unknown
  // 主题包是否带 preview.png，由 hub 告知，卡片的高度一次排定，不因图片晚到而改变。
  preview: boolean
}

// 主题在 theme.json 里声明的设置。hub 只存与默认值不同的项，其余由主题用自己的默认值补上，
// 所以主题作者日后改了某个默认值，没动过这一项的站点会跟着变。
//
// 字段不多时是一列；多了改成宽对话框：按分组标题分节，左侧切换，右侧两列，
// 否则几十项排成一条细长的列表。有改动的节在导航上带一个点。
function ThemeSettings({ theme, saved, onClose }: {
  theme: Theme
  saved: Record<string, unknown>
  onClose: () => void
}) {
  const form = configForm(theme.config)
  const fields = form.filter((entry): entry is ConfigField => entry.type !== "title")
  const sections = configSections(form)
  const large = fields.length > 6
  const paged = large && sections.length > 1
  const [current, setCurrent] = useState(0)
  const [values, setValues] = useState(() => configValues(fields, saved))
  // What the save builds on. Keys the form does not declare are kept, except
  // after 恢复默认: that also clears them, the only way from the panel to drop
  // a value, publicly readable, left by a field the theme has since removed.
  const [base, setBase] = useState(saved)
  const [saving, setSaving] = useState(false)
  const set = (key: string, value: unknown) => setValues((old) => ({ ...old, [key]: value }))
  const label = (field: ConfigField) => field.label || field.key
  // A number box holds its text while being edited; an empty one holds no
  // number, where Number("") would read as 0.
  const typed = (f: ConfigField) =>
    f.type !== "number" ? values[f.key] : values[f.key] === "" ? NaN : Number(values[f.key])
  const differs = (f: ConfigField) => typed(f) !== f.default

  async function save(e: React.FormEvent) {
    e.preventDefault()
    // The browser checks required/min/max only on the boxes on screen; a
    // section switched away from is no longer rendered, so its numbers are
    // checked here and the offending one brought back into view.
    const invalid = fields.find((f) => f.type === "number" && !fits(f, typed(f)))
    if (invalid) {
      setCurrent(Math.max(0, sections.findIndex((section) => section.fields.includes(invalid))))
      const range =
        invalid.min !== undefined && invalid.max !== undefined ? `${invalid.min}–${invalid.max} 之间的`
        : invalid.min !== undefined ? `不小于 ${invalid.min} 的`
        : invalid.max !== undefined ? `不大于 ${invalid.max} 的` : ""
      return toast.error(`「${label(invalid)}」要填${range}数字`)
    }
    setSaving(true)
    try {
      await api(`/themes/${theme.short}/config`, {
        method: "PUT",
        body: JSON.stringify(configOverrides(fields, base, Object.fromEntries(fields.map((f) => [f.key, typed(f)])))),
      })
      toast.success("主题设置已保存，公开页刷新后生效")
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const input = (field: ConfigField) =>
    field.type === "boolean" ? (
      <OptionRow key={field.key} title={label(field)} hint={field.help} toggle>
        <Switch checked={values[field.key] as boolean} onCheckedChange={(v) => set(field.key, v)} />
      </OptionRow>
    ) : (
      <Field key={field.key} label={label(field)} hint={field.help} className={large && field.type === "text" ? "sm:col-span-2" : ""}>
        {field.type === "text" ? (
          <textarea
            rows={4}
            className={`${TEXT_BOX} text-sm`}
            value={values[field.key] as string}
            onChange={(e) => set(field.key, e.target.value)}
          />
        ) : field.type === "select" ? (
          <Select value={values[field.key] as string} onValueChange={(v) => set(field.key, v)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              {field.options!.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label || o.value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : field.type === "number" ? (
          <Input
            type="number"
            required
            step="any"
            min={field.min}
            max={field.max}
            value={String(values[field.key])}
            onChange={(e) => set(field.key, e.target.value)}
          />
        ) : (
          <Input value={values[field.key] as string} onChange={(e) => set(field.key, e.target.value)} />
        )}
      </Field>
    )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={large ? "flex h-[min(46rem,calc(100dvh-2rem))] flex-col overflow-hidden sm:max-w-4xl" : "sm:max-w-lg"}
      >
        <DialogHeader>
          <DialogTitle>{theme.name} 设置</DialogTitle>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={save}>
          <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
            {paged && (
              <nav className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 sm:mx-0 sm:w-48 sm:flex-col sm:overflow-y-auto sm:px-0">
                {sections.map((section, index) => (
                  <button
                    key={index}
                    type="button"
                    aria-current={index === current}
                    onClick={() => setCurrent(index)}
                    className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                      index === current ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <span className="whitespace-nowrap sm:whitespace-normal">{section.label}</span>
                    {section.fields.some(differs) && (
                      <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" title="有改动" />
                    )}
                  </button>
                ))}
              </nav>
            )}
            <div className={`min-h-0 flex-1 ${large ? "overflow-y-auto pr-1" : ""}`}>
              <div className={`grid items-start gap-4 ${large ? "sm:grid-cols-2" : ""}`}>
                {paged
                  ? sections[current].fields.map(input)
                  : form.map((entry, index) =>
                      entry.type === "title" ? (
                        <h3 key={`title-${index}`} className={`pt-2 text-sm font-semibold first:pt-0 ${large ? "sm:col-span-2" : ""}`}>
                          {entry.label}
                        </h3>
                      ) : (
                        input(entry)
                      ),
                    )}
              </div>
            </div>
          </div>
          {/* One row on a phone as well: stacked, the three buttons would take a
              third of the height the fields have. */}
          <DialogFooter className="flex-row items-center border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                setValues(Object.fromEntries(fields.map((f) => [f.key, f.default])))
                setBase({})
              }}
            >
              {paged ? "全部恢复默认" : "恢复默认"}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function Themes() {
  const [themes, setThemes] = useState<Theme[] | null>(null)
  const [busy, setBusy] = useState("")
  const [doomed, setDoomed] = useState<Theme | null>(null)
  const [zoomed, setZoomed] = useState<Theme | null>(null)
  const [configuring, setConfiguring] = useState<{ theme: Theme; saved: Record<string, unknown> } | null>(null)
  const [repo, setRepo] = useState("")
  const picker = useRef<HTMLInputElement>(null)

  // A failed reload keeps the list on screen; only a failed first load draws it
  // empty, keeping the install card in reach.
  const load = () =>
    api<{ themes: Theme[] }>("/themes")
      .then((data) => setThemes(data.themes))
      .catch((e: Error) => {
        toast.error(e.message)
        setThemes((themes) => themes ?? [])
      })
  useEffect(() => { load() }, [])

  async function select(short: string) {
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ theme: short }) })
      setThemes((old) => old?.map((theme) => ({ ...theme, selected: theme.short === short })) ?? old)
      toast.success("主题已切换")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Both ways in answer with the installed manifest.
  async function install(how: "upload" | "github", installing: () => Promise<{ theme: Theme }>) {
    setBusy(how)
    try {
      const { theme } = await installing()
      // The hub reads a theme from disk on every request, so it is already live;
      // reloading the list only brings this page up to date.
      toast.success(`已安装 ${theme.name} ${theme.version}`)
      if (how === "github") setRepo("")
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  // Only a theme whose manifest names a GitHub repository has a source to update
  // from; the hub refuses anything else, and this merely hides the button.
  const updatable = (theme: Theme) => theme.url.startsWith("https://github.com/")

  async function update(theme: Theme) {
    setBusy(`update:${theme.short}`)
    try {
      const { updated, version } = await api<{ updated: boolean; version: string }>(
        `/themes/${theme.short}/update`,
        { method: "POST" },
      )
      toast.success(updated ? `${theme.name} 已更新到 ${version}` : `${theme.name} 已是最新版本 ${version}`)
      if (updated) load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  // Read on opening rather than inside the dialog, so the form starts from what
  // is saved instead of flashing the defaults first.
  async function configure(theme: Theme) {
    try {
      setConfiguring({ theme, saved: await api(`/themes/${theme.short}/config`) })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function remove(theme: Theme) {
    setBusy("delete")
    try {
      await api(`/themes/${theme.short}`, { method: "DELETE" })
      toast.success(`已删除 ${theme.name}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
      setDoomed(null)
    }
  }

  if (!themes) return null
  return (
    <div className="space-y-4">
      <Card className="gap-4 p-5">
        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-medium">安装主题</h3>
            <Help width="max-w-64 min-[480px]:max-w-112">
              <p>填主题的 GitHub 仓库地址，例如 <span className="whitespace-nowrap">https://github.com/作者/仓库</span></p>
              <p>仓库首页、Releases 页的地址都可以，总是安装最新的 release。</p>
              <p>也可以上传 release 里的 theme.tar.gz，不要选 Source code。</p>
              <p>两种方式都是同名主题整体替换。</p>
              <p>
                主题的 url 指向 GitHub 仓库时，卡片上的 <RefreshCw className="inline size-3" /> 检查更新，版本没变就不下载。
              </p>
            </Help>
            <Button size="sm" variant="ghost" className="-my-1 -mr-2.5 ml-auto h-7" asChild>
              <a href="https://monitor-themes.pages.dev" target="_blank" rel="noreferrer">
                <Palette /> 浏览主题
              </a>
            </Button>
          </div>
          {/* Stays in view: it is the one line about what installing permits. */}
          <p className="mt-1 text-xs text-muted-foreground">主题代码在访客浏览器中执行，请只安装可信来源。</p>
        </div>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            install("github", () =>
              api("/theme-install", { method: "POST", body: JSON.stringify({ url: repo.trim() }) }),
            )
          }}
        >
          {/* text rather than url: the browser's own validation would answer
              in its language before the hub's message could. */}
          <Input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            disabled={!!busy}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="主题 GitHub 仓库地址"
            aria-label="主题 GitHub 仓库地址"
            className="h-8 flex-1 basis-60"
          />
          <Button size="sm" type="submit" disabled={!!busy || !repo.trim()}>
            <Download /> {busy === "github" ? "安装中…" : "从 GitHub 安装"}
          </Button>
          <Button size="sm" type="button" variant="outline" disabled={!!busy} onClick={() => picker.current?.click()}>
            <Upload /> {busy === "upload" ? "安装中…" : "上传主题包"}
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".gz,.tgz,application/gzip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (file) install("upload", () => upload<{ theme: Theme }>("/themes", file))
            }}
          />
        </form>
      </Card>

      {/* items-start：有预览图和没有的卡片不该为了等高而留白 */}
      <div className="grid items-start gap-3 sm:grid-cols-2">
        {themes.map((theme) => (
          <Card key={theme.short} className="gap-4 p-5">
            {/* 缩略图被压到卡片那点宽度，比例不是 16:9 的还会被 object-cover
                裁掉边，所以图本身要能点开看原尺寸——就地开一个对话框，不跳走。 */}
            {theme.preview && (
              <button type="button" title="查看完整预览图" className="cursor-zoom-in" onClick={() => setZoomed(theme)}>
                <img
                  src={`/api/themes/${theme.short}/preview`}
                  alt={`${theme.name} 预览图`}
                  className="aspect-video w-full rounded-md border object-cover object-top"
                />
              </button>
            )}
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{theme.name}</h3>
                  {theme.selected && <Badge>当前</Badge>}
                  {theme.builtin && <Badge variant="secondary" className="font-normal">内置</Badge>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{theme.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant={theme.selected ? "secondary" : "default"} disabled={theme.selected} onClick={() => select(theme.short)}>
                  {theme.selected ? "使用中" : "使用"}
                </Button>
                {configFields(theme.config).length > 0 && (
                  <Button size="icon" variant="ghost" title="主题设置" aria-label="主题设置" onClick={() => configure(theme)}>
                    <SlidersHorizontal />
                  </Button>
                )}
                {updatable(theme) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="从 GitHub 更新"
                    aria-label="从 GitHub 更新"
                    disabled={!!busy}
                    onClick={() => update(theme)}
                  >
                    <RefreshCw className={busy === `update:${theme.short}` ? "animate-spin" : ""} />
                  </Button>
                )}
                {/* The built-in theme is served from the binary and has no
                    directory to delete -- it is also the fallback everything
                    else lands on. */}
                {!theme.builtin && (
                  <Button size="icon" variant="ghost" title="删除主题" aria-label="删除主题" disabled={!!busy} onClick={() => setDoomed(theme)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {theme.author} · {theme.version}
              {theme.url && <> · <a className="hover:underline" href={theme.url} target="_blank" rel="noreferrer">源码</a></>}
            </p>
          </Card>
        ))}
      </div>

      {/* 原图，不是卡片上那张裁过的：宽度给到 4xl，高度让 80vh 兜住，
          object-contain 保证整张都在框里而不是被切一刀。 */}
      {zoomed && (
        <Dialog open onOpenChange={(open) => !open && setZoomed(null)}>
          <DialogContent className="sm:max-w-4xl">
            <DialogHeader>
              <DialogTitle>{zoomed.name} 预览图</DialogTitle>
              <DialogDescription>{zoomed.author} · {zoomed.version}</DialogDescription>
            </DialogHeader>
            <img
              src={`/api/themes/${zoomed.short}/preview`}
              alt={`${zoomed.name} 预览图`}
              className="max-h-[80vh] w-full rounded-md border object-contain"
            />
          </DialogContent>
        </Dialog>
      )}

      {configuring && <ThemeSettings {...configuring} onClose={() => setConfiguring(null)} />}

      {doomed && (
        <ConfirmDialog
          title={`删除 ${doomed.name}？`}
          description={
            doomed.short === "default"
              ? "装上的这份会从磁盘上删掉，公开页回到 hub 内置的那份默认主题。"
              : doomed.selected
                ? "这是当前使用的主题，删除后公开页会回到内置的默认主题。"
                : "主题目录会从磁盘上删掉，重新上传主题包可以装回来。"
          }
          confirmLabel="删除"
          busy={!!busy}
          onClose={() => setDoomed(null)}
          onConfirm={() => remove(doomed)}
        />
      )}
    </div>
  )
}
