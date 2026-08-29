"use client"
import { useState } from "react"
import { createClient } from "@/lib/supabase/client"

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${site}/auth/callback` },
    })
    setLoading(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  if (sent) {
    return (
      <div className="card">
        <h1>Confira seu e-mail</h1>
        <p className="muted">Enviamos um link de acesso para <b>{email}</b>. Abra pelo mesmo dispositivo.</p>
      </div>
    )
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Entrar</h1>
      <p className="muted">Sem senha: mandamos um link mágico para o seu e-mail.</p>
      <label htmlFor="email">E-mail</label>
      <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com" />
      {error && <p className="error">{error}</p>}
      <p style={{ marginTop: "1rem" }}>
        <button disabled={loading}>{loading ? "Enviando…" : "Enviar link"}</button>
      </p>
    </form>
  )
}
