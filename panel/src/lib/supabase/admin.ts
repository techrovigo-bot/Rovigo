import { createClient } from "@supabase/supabase-js"

// Cliente com a service_role key — SÓ para código de servidor sem sessão de
// usuário (o webhook do Stripe). Ignora RLS; nunca importe isto em Client
// Components. A chave vive apenas no ambiente do servidor.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}
