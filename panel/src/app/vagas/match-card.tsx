"use client"
import { useState } from "react"
import { createClient } from "@/lib/supabase/client"

const BAND: Record<string, string> = {
  "Strong Fit": "strong", "Good Fit": "good", "Moderate Fit": "moderate", "Weak Fit": "weak", "Poor Fit": "poor",
}

export type Match = {
  id: string
  score: number | null
  verdict: string | null
  strengths: string[] | null
  gaps: string[] | null
  language_verdict: string | null
  language_note: string | null
  jobs: { title: string; company: string | null; location: string | null; url: string } | null
}

export function MatchCard({ m }: { m: Match }) {
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  if (hidden || !m.jobs) return null

  async function dismiss() {
    setBusy(true)
    await createClient().from("job_matches").update({ status: "dismissed" }).eq("id", m.id)
    setHidden(true)
  }

  const badge = m.verdict ? BAND[m.verdict] ?? "good" : "good"
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
        <span className="score">{m.score ?? "—"}</span>
        {m.verdict && <span className={`badge ${badge}`}>{m.verdict}</span>}
        {m.language_verdict === "flag" && <span className="badge moderate">⚠ idioma</span>}
        <span className="spacer" style={{ flex: 1 }} />
      </div>
      <h2 style={{ margin: "0.3rem 0" }}>
        <a href={m.jobs.url} target="_blank" rel="noopener noreferrer">{m.jobs.title}</a>
      </h2>
      <p className="muted" style={{ margin: 0 }}>
        {m.jobs.company ?? "Empresa não informada"}{m.jobs.location ? ` · ${m.jobs.location}` : ""}
      </p>
      {m.strengths && m.strengths.length > 0 && (
        <ul className="tight">{m.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
      )}
      {m.gaps && m.gaps.length > 0 && (
        <ul className="tight muted">{m.gaps.map((s, i) => <li key={i}>{s}</li>)}</ul>
      )}
      {m.language_note && <p className="hint">⚠ {m.language_note}</p>}
      <p style={{ marginTop: "0.6rem", display: "flex", gap: "0.6rem" }}>
        <a className="btn" href={m.jobs.url} target="_blank" rel="noopener noreferrer">Ver vaga</a>
        <button className="secondary" onClick={dismiss} disabled={busy}>Não me interessa</button>
      </p>
    </div>
  )
}
