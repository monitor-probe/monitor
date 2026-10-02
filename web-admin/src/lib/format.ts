const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]

const unitOf = (n: number) => Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1)

/**
 * 1024-based, as VPS dashboards and `df` report bytes, but labelled MB/GB the way
 * `df -h` and hosting plans write them. Three significant digits by default. Kept
 * in step with the theme's copy of this file.
 */
export function bytes(n: number, digits?: number): string {
  // `< 1` rather than `< 0`: a fraction of a byte puts `unitOf` at -1 and prints
  // "512 undefined".
  if (!n || n < 1) return "0 B"
  const i = unitOf(n)
  const v = n / 1024 ** i
  return `${v.toFixed(i === 0 ? 0 : (digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2)))} ${UNITS[i]}`
}

export function uptime(seconds: number): string {
  if (!seconds) return "—"
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`
}

/**
 * No expiry and no traffic cap are both rendered as the absence of a ceiling.
 * U+221E rather than the emoji, which arrives as a coloured tile from whatever
 * font the browser provides; this inherits the text colour and size.
 */
export const FOREVER = "∞"

const MONEY = new Map<string, Intl.NumberFormat>()

/**
 * A price as zh-CN writes it: ¥12.00, US$12.00, HK$12.00, JP¥1,200, and the code
 * ahead of the amount where the locale has no symbol, as in SGD 12.00. The
 * locale is fixed so the figure does not vary with the browser's language, and
 * so JPY reads JP¥, apart from CNY. Fractions stop at two places, the precision
 * the price is entered in, not at the currency's minor unit: rounding to whole
 * yen would show a price of 0.4 as JP¥0. A formatter costs about 100 µs to
 * build, hence one per currency.
 */
export function money(amount: number, currency: string): string {
  try {
    let format = MONEY.get(currency)
    if (!format) {
      format = new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 })
      MONEY.set(currency, format)
    }
    return format.format(amount)
  } catch {
    // Intl throws on anything but three letters, which hubs before 1.3.1 stored
    // unchecked when written through the API.
    return `${currency} ${amount.toFixed(2)}`.trim()
  }
}

// The hub stores these lengths under a name and any other as `<n>m`.
const NAMED_CYCLES: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12, biennial: 24, triennial: 36 }

/** A billing cycle in months: 0 for one-off, NaN when unrecognized. */
export function cycleMonths(cycle: string): number {
  return cycle === "once" ? 0 : NAMED_CYCLES[cycle] ?? Number(/^(\d+)m$/.exec(cycle)?.[1])
}
