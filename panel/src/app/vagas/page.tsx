import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { MatchCard, type Match } from "./match-card"

export const dynamic = "force-dynamic"

export default async function Vagas({ searchParams }: { searchParams: { welcome?: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: tenant } = user ? await supabase.from("tenants").select("id").eq("user_id", user.id).single() : { data: null }
  const { data: profile } = tenant ? await supabase.from("profiles").select("completeness").eq("tenant_id", tenant.id).single() : { data: null }

  const { data: matches } = await supabase
    .from("job_matches")
    .select("id,score,verdict,strengths,gaps,language_verdict,language_note,jobs(title,company,location,url)")
    .not("score", "is", null)
    .in("status", ["ranked", "notified", "saved"])
    .order("score", { ascending: false })
    .limit(50)

  const list = (matches ?? []) as unknown as Match[]

  return (
    <div>
      <h1>Suas vagas</h1>
      {searchParams.welcome && (
        <p className="ok">Perfil salvo! Estamos buscando as primeiras vagas — elas aparecem aqui em instantes.</p>
      )}

      {(!profile || profile.completeness === 0) && (
        <div className="card">
          <p>Seu perfil ainda está vazio. <Link href="/onboarding">Preencha o perfil</Link> para começar a receber vagas.</p>
        </div>
      )}

      {list.length === 0 ? (
        <div className="card">
          <p className="muted">Nenhuma vaga ainda. A primeira rodada roda logo após o onboarding, e todo dia buscamos novas.</p>
        </div>
      ) : (
        list.map((m) => <MatchCard key={m.id} m={m} />)
      )}
    </div>
  )
}
