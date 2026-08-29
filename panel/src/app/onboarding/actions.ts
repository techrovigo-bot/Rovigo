"use server"

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"

const CONSENT_VERSION = "v1"

function list(v: FormDataEntryValue | null): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function saveProfile(formData: FormData) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Consentimento de IA é obrigatório: sem ele não há como ranquear.
  if (formData.get("consent_llm") !== "on") {
    redirect("/onboarding?error=consent")
  }

  // Idiomas: português nativo implícito; inglês/espanhol conforme escolha.
  const languages: { lang: string; level: string }[] = [{ lang: "português", level: "native" }]
  const en = String(formData.get("lang_en") ?? "none")
  const es = String(formData.get("lang_es") ?? "none")
  if (en !== "none") languages.push({ lang: "inglês", level: en })
  if (es !== "none") languages.push({ lang: "espanhol", level: es })

  const workModels = ["remote", "hybrid", "onsite"].filter((m) => formData.get(`wm_${m}`) === "on")
  const targetRoles = list(formData.get("target_roles"))
  const cities = list(formData.get("cities"))
  const skills = list(formData.get("skills"))

  // completeness simples: 25 pontos por bloco preenchido.
  const completeness =
    (targetRoles.length ? 25 : 0) + (cities.length ? 25 : 0) +
    (skills.length ? 25 : 0) + (workModels.length ? 25 : 0)

  const profile = {
    full_name: String(formData.get("full_name") ?? "") || null,
    headline: String(formData.get("headline") ?? "") || null,
    target_roles: targetRoles,
    seniority: String(formData.get("seniority") ?? "") || null,
    cities,
    accepts_work_models: workModels,
    languages,
    skills,
    contract_preference: String(formData.get("contract_preference") ?? "any"),
    completeness,
  }

  const { data: tenant, error: tErr } = await supabase.from("tenants").select("id").eq("user_id", user.id).single()
  if (tErr || !tenant) redirect("/onboarding?error=tenant")

  const { error: pErr } = await supabase.from("profiles").update(profile).eq("tenant_id", tenant.id)
  if (pErr) redirect("/onboarding?error=save")

  // Consentimentos e contato ficam em tenants.
  const whatsapp = String(formData.get("whatsapp_number") ?? "").trim() || null
  const consentWa = formData.get("consent_whatsapp") === "on"
  const now = new Date().toISOString()
  await supabase.from("tenants").update({
    whatsapp_number: whatsapp,
    llm_consent_at: now,
    llm_consent_version: CONSENT_VERSION,
    whatsapp_consent_at: consentWa ? now : null,
    whatsapp_consent_version: consentWa ? CONSENT_VERSION : null,
  }).eq("id", tenant.id)

  // Dispara o onboarding-hook (embute perfil → ranqueia → notifica). Falha aqui
  // não bloqueia o onboarding: o cron diário pega o tenant de qualquer forma.
  const hook = process.env.N8N_ONBOARDING_URL
  if (hook) {
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: tenant.id }),
      })
    } catch {
      // silencioso de propósito
    }
  }

  redirect("/vagas?welcome=1")
}
