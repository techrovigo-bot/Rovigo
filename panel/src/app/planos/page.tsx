import { createClient } from "@/lib/supabase/server"
import { subscribeAlertas } from "./actions"

function daysLeft(iso: string | null): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  return ms > 0 ? Math.ceil(ms / 86400000) : 0
}

export default async function Planos({ searchParams }: { searchParams: { cancelado?: string; erro?: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: tenant } = user
    ? await supabase.from("tenants").select("tier, subscription_status, trial_ends_at").eq("user_id", user.id).single()
    : { data: null }

  const trial = daysLeft(tenant?.trial_ends_at ?? null)
  const isPaid = tenant?.tier === "alertas" && tenant?.subscription_status === "active"

  return (
    <div>
      <h1>Planos</h1>
      {searchParams.cancelado && <p className="muted">Checkout cancelado, sem problema.</p>}
      {searchParams.erro && <p className="error">Não foi possível iniciar o checkout. Tente de novo.</p>}
      {tenant?.tier === "trial" && (
        <p className="muted">
          Você está no <b>teste grátis</b>{trial !== null ? ` — ${trial} dia(s) restante(s)` : ""}. Assine para não perder as vagas quando acabar.
        </p>
      )}

      <div className="row">
        <div className="card">
          <h2>Teste grátis</h2>
          <p className="score">R$ 0</p>
          <ul className="tight">
            <li>Alertas diários por 14 dias</li>
            <li>Top vagas com fit</li>
            <li>Painel completo</li>
          </ul>
          <p className="muted">{tenant?.tier === "trial" ? "Seu plano atual." : "—"}</p>
        </div>

        <div className="card" style={{ borderColor: "var(--accent)" }}>
          <h2>Alertas</h2>
          <p className="score">R$ 39<span className="muted" style={{ fontSize: "0.9rem" }}>/mês</span></p>
          <ul className="tight">
            <li>Alertas diários ilimitados</li>
            <li>Vagas ranqueadas com justificativa</li>
            <li>WhatsApp + e-mail</li>
          </ul>
          {isPaid ? (
            <p className="ok">Seu plano atual ✓</p>
          ) : (
            <form action={subscribeAlertas}>
              <button type="submit">Assinar</button>
            </form>
          )}
        </div>

        <div className="card">
          <h2>Pro <span className="badge moderate">em breve</span></h2>
          <p className="score">R$ 79<span className="muted" style={{ fontSize: "0.9rem" }}>/mês</span></p>
          <ul className="tight">
            <li>Tudo do Alertas</li>
            <li>CV e carta gerados por vaga</li>
            <li>Pesquisa de empresa + checagem ATS</li>
          </ul>
          <p className="muted">Chega junto com a geração de documentos.</p>
        </div>
      </div>
    </div>
  )
}
