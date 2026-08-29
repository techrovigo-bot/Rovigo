"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"

export function AccountActions() {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function exportData() {
    setBusy("export"); setMsg(null)
    const { data, error } = await createClient().rpc("export_my_data")
    setBusy(null)
    if (error) { setMsg("Erro ao exportar: " + error.message); return }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url; a.download = "meus-dados-rovigo-jobs.json"; a.click()
    URL.revokeObjectURL(url)
  }

  async function deleteAccount() {
    if (!confirm("Excluir sua conta e todos os dados? Isso não pode ser desfeito.")) return
    setBusy("delete"); setMsg(null)
    const supabase = createClient()
    const { error } = await supabase.rpc("delete_my_account")
    if (error) { setBusy(null); setMsg("Erro ao excluir: " + error.message); return }
    await supabase.auth.signOut()
    router.push("/")
    router.refresh()
  }

  return (
    <div>
      <p style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
        <button className="secondary" onClick={exportData} disabled={busy !== null}>
          {busy === "export" ? "Exportando…" : "Exportar meus dados (JSON)"}
        </button>
        <button className="danger" onClick={deleteAccount} disabled={busy !== null}>
          {busy === "delete" ? "Excluindo…" : "Excluir minha conta"}
        </button>
      </p>
      {msg && <p className="error">{msg}</p>}
    </div>
  )
}
