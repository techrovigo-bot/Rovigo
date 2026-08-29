"use server"

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { stripe } from "@/lib/stripe"

// Cria a sessão de checkout do Stripe (assinatura mensal do tier Alertas) e
// redireciona para a página de pagamento hospedada.
export async function subscribeAlertas() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: tenant } = await supabase
    .from("tenants").select("id, stripe_customer_id").eq("user_id", user.id).single()
  if (!tenant) redirect("/onboarding")

  const admin = createAdminClient()

  // Garante o customer no Stripe (campos de billing gravados pela service_role,
  // não pelo próprio usuário).
  let customerId = tenant.stripe_customer_id as string | null
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { tenant_id: tenant.id },
    })
    customerId = customer.id
    await admin.from("tenants").update({ stripe_customer_id: customerId }).eq("id", tenant.id)
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL!
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: process.env.STRIPE_PRICE_ALERTAS!, quantity: 1 }],
    success_url: `${site}/conta?assinatura=ok`,
    cancel_url: `${site}/planos?cancelado=1`,
    metadata: { tenant_id: tenant.id },
    subscription_data: { metadata: { tenant_id: tenant.id } },
    allow_promotion_codes: true,
  })

  if (!session.url) redirect("/planos?erro=checkout")
  redirect(session.url)
}
