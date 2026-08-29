import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { AccountActions } from "./account-actions"

const TIER_LABEL: Record<string, string> = { trial: "Teste grátis", alertas: "Alertas", pro: "Pro" }

export default async function Conta({ searchParams }: { searchParams: { assinatura?: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: tenant } = user ? await supabase.from("tenants").select("tier,subscription_status,trial_ends_at,current_period_end,whatsapp_number,whatsapp_consent_at").eq("user_id", user.id).single() : { data: null }

  const trialLeft = tenant?.trial_ends_at ? Math.max(0, Math.ceil((new Date(tenant.trial_ends_at).getTime() - Date.now()) / 86400000)) : null

  return (
    <div>
      <h1>Conta</h1>
      {searchParams.assinatura === "ok" && <p className="ok">Assinatura confirmada! Obrigado. 🎉</p>}
      <div className="card">
        <p><b>E-mail:</b> {user?.email}</p>
        {tenant && (
          <>
            <p>
              <b>Plano:</b> {TIER_LABEL[tenant.tier] ?? tenant.tier} <span className="muted">({tenant.subscription_status})</span>
              {tenant.tier === "trial" && trialLeft !== null && <span className="muted"> — {trialLeft} dia(s) restante(s)</span>}
              {" · "}<Link href="/planos">gerenciar</Link>
            </p>
            <p><b>WhatsApp:</b> {tenant.whatsapp_number ?? "—"} {tenant.whatsapp_consent_at ? <span className="ok">(autorizado)</span> : <span className="muted">(sem autorização)</span>}</p>
          </>
        )}
      </div>

      <h2>Seus dados (LGPD)</h2>
      <div className="card">
        <p className="muted">
          Você pode baixar tudo que guardamos sobre você, ou excluir sua conta e todos os dados de forma permanente.
        </p>
        <AccountActions />
      </div>
    </div>
  )
}
