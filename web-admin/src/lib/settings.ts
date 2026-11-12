import { useEffect, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"

export type Settings = Record<string, string | boolean | number>

// Three pages write settings, and each loads only what it displays. `quiet` is
// for a reader with defaults to fall back on; on a page that writes them, a
// failed load leaves the form empty, so it is said.
export function useSettings(quiet = false) {
  const [s, setS] = useState<Settings | null>(null)
  useEffect(() => { api<Settings>("/settings").then(setS).catch((e: Error) => quiet || toast.error(e.message)) }, [quiet])
  return {
    s,
    set: (k: string, v: string) => setS((old) => ({ ...(old ?? {}), [k]: v })),
    // Resolves to whether the hub took the patch; a failure is already toasted.
    save: async (patch: Record<string, string>, done = "已保存") => {
      try {
        await api("/settings", { method: "PUT", body: JSON.stringify(patch) })
      } catch (e) {
        toast.error((e as Error).message)
        return false
      }
      toast.success(done)
      // Only the saved keys and the `*_set` flags are taken from the hub: a
      // credential comes back as a flag, so the typed value must not linger,
      // while another card's unsaved edits on the same page must survive. A
      // failed read leaves the form as typed; the save itself stands.
      try {
        const fresh = await api<Settings>("/settings")
        setS((old) => {
          const next = { ...old }
          for (const key of [...Object.keys(patch), "your_address"]) next[key] = fresh[key]
          for (const [key, value] of Object.entries(fresh)) if (key.endsWith("_set")) next[key] = value
          return next
        })
      } catch (e) {
        toast.error((e as Error).message)
      }
      return true
    },
  }
}
