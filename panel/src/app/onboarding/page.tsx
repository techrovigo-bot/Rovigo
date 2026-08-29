import { createClient } from "@/lib/supabase/server"
import { saveProfile } from "./actions"

const LEVELS = [
  { v: "none", l: "Não falo" },
  { v: "reading", l: "Leitura" },
  { v: "intermediate", l: "Intermediário" },
  { v: "advanced", l: "Avançado" },
  { v: "fluent", l: "Fluente" },
]

const ERRORS: Record<string, string> = {
  consent: "Você precisa autorizar o uso do seu perfil pela IA para receber vagas.",
  tenant: "Conta não encontrada. Saia e entre novamente.",
  save: "Não foi possível salvar. Tente de novo.",
}

export default async function Onboarding({ searchParams }: { searchParams: { error?: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: tenant } = user ? await supabase.from("tenants").select("id").eq("user_id", user.id).single() : { data: null }
  const { data: p } = tenant ? await supabase.from("profiles").select("*").eq("tenant_id", tenant.id).single() : { data: null }

  const langLevel = (lang: string) =>
    (p?.languages as { lang: string; level: string }[] | undefined)?.find((l) => l.lang === lang)?.level ?? "none"
  const has = (m: string) => (p?.accepts_work_models as string[] | undefined)?.includes(m)

  return (
    <div>
      <h1>Seu perfil</h1>
      <p className="muted">Quanto mais preciso, melhor o fit das vagas. Dá pra editar depois.</p>
      {searchParams.error && <p className="error">{ERRORS[searchParams.error] ?? "Erro ao salvar."}</p>}

      <form action={saveProfile} className="card">
        <div className="row">
          <div>
            <label htmlFor="full_name">Nome</label>
            <input id="full_name" name="full_name" type="text" defaultValue={p?.full_name ?? ""} />
          </div>
          <div>
            <label htmlFor="seniority">Senioridade</label>
            <select id="seniority" name="seniority" defaultValue={p?.seniority ?? "pleno"}>
              <option value="junior">Júnior</option>
              <option value="pleno">Pleno</option>
              <option value="senior">Sênior</option>
              <option value="especialista">Especialista</option>
            </select>
          </div>
        </div>

        <label htmlFor="headline">Resumo curto <span className="hint">(opcional; ajuda o fit)</span></label>
        <input id="headline" name="headline" type="text" defaultValue={p?.headline ?? ""} placeholder="Ex.: Engenheiro de automação com foco em IA e n8n" />

        <label htmlFor="target_roles">Funções-alvo <span className="hint">(separe por vírgula)</span></label>
        <input id="target_roles" name="target_roles" type="text" defaultValue={(p?.target_roles as string[] | undefined)?.join(", ") ?? ""} placeholder="engenheiro de automação, AI engineer" />

        <label htmlFor="skills">Skills <span className="hint">(separe por vírgula)</span></label>
        <input id="skills" name="skills" type="text" defaultValue={(p?.skills as string[] | undefined)?.join(", ") ?? ""} placeholder="n8n, python, rag, api rest" />

        <label htmlFor="cities">Cidades aceitas <span className="hint">(para vagas presenciais/híbridas)</span></label>
        <input id="cities" name="cities" type="text" defaultValue={(p?.cities as string[] | undefined)?.join(", ") ?? ""} placeholder="Curitiba, São José dos Pinhais" />

        <label>Modelos de trabalho aceitos</label>
        <div className="checks">
          <label><input type="checkbox" name="wm_remote" defaultChecked={has("remote")} /> Remoto</label>
          <label><input type="checkbox" name="wm_hybrid" defaultChecked={has("hybrid")} /> Híbrido</label>
          <label><input type="checkbox" name="wm_onsite" defaultChecked={has("onsite")} /> Presencial</label>
        </div>

        <div className="row">
          <div>
            <label htmlFor="lang_en">Inglês</label>
            <select id="lang_en" name="lang_en" defaultValue={langLevel("inglês")}>
              {LEVELS.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="lang_es">Espanhol</label>
            <select id="lang_es" name="lang_es" defaultValue={langLevel("espanhol")}>
              {LEVELS.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="contract_preference">Preferência de vínculo</label>
            <select id="contract_preference" name="contract_preference" defaultValue={p?.contract_preference ?? "any"}>
              <option value="any">Tanto faz</option>
              <option value="pj">PJ</option>
              <option value="clt">CLT</option>
            </select>
          </div>
        </div>

        <label htmlFor="whatsapp_number">WhatsApp <span className="hint">(com DDD e país, ex.: +5541999999999)</span></label>
        <input id="whatsapp_number" name="whatsapp_number" type="text" defaultValue={""} placeholder="+55..." />

        <div style={{ marginTop: "1.2rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
          <div className="consent">
            <input id="consent_llm" name="consent_llm" type="checkbox" />
            <label htmlFor="consent_llm" style={{ fontWeight: 500, margin: 0 }}>
              Autorizo o envio do meu perfil a provedores de IA (Anthropic/OpenAI) para pontuar as vagas. <span className="hint">Obrigatório.</span>
            </label>
          </div>
          <div className="consent">
            <input id="consent_whatsapp" name="consent_whatsapp" type="checkbox" />
            <label htmlFor="consent_whatsapp" style={{ fontWeight: 500, margin: 0 }}>
              Autorizo receber as vagas por WhatsApp. <span className="hint">Opcional; sem isso mandamos por e-mail.</span>
            </label>
          </div>
        </div>

        <p style={{ marginTop: "1rem" }}><button type="submit">Salvar e buscar vagas</button></p>
        <p className="hint">Você pode exportar ou excluir seus dados a qualquer momento na página Conta.</p>
      </form>
    </div>
  )
}
