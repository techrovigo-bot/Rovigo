import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Troca o code do magic link por uma sessão e redireciona.
// Novo usuário vai ao onboarding; quem já tem perfil, às vagas.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")

  if (code) {
    const supabase = createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Perfil já preenchido? (completeness > 0) → vagas; senão → onboarding.
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: tenant } = await supabase.from("tenants").select("id").eq("user_id", user.id).single()
        if (tenant) {
          const { data: profile } = await supabase.from("profiles").select("completeness").eq("tenant_id", tenant.id).single()
          const dest = profile && profile.completeness > 0 ? "/vagas" : "/onboarding"
          return NextResponse.redirect(`${origin}${dest}`)
        }
      }
      return NextResponse.redirect(`${origin}/onboarding`)
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`)
}
