import { NextResponse, type NextRequest } from "next/server"
import type Stripe from "stripe"
import { stripe } from "@/lib/stripe"
import { createAdminClient } from "@/lib/supabase/admin"

// Webhook do Stripe. Verifica a assinatura com o corpo cru e atualiza tenants
// via service_role (bypassa RLS). Configure o endpoint no Stripe apontando para
// {SITE}/api/stripe/webhook e cole o signing secret em STRIPE_WEBHOOK_SECRET.

// nosso enum: active | past_due | canceled | expired
function mapStatus(s: Stripe.Subscription.Status): string {
  switch (s) {
    case "active":
    case "trialing":
      return "active"
    case "past_due":
      return "past_due"
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "canceled"
    default:
      return "past_due"
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get("stripe-signature")
  if (!sig) return new NextResponse("sem assinatura", { status: 400 })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch {
    return new NextResponse("assinatura inválida", { status: 400 })
  }

  const admin = createAdminClient()
  const update = (customer: string, fields: Record<string, unknown>) =>
    admin.from("tenants").update(fields).eq("stripe_customer_id", customer)

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session
      if (s.customer) {
        await update(String(s.customer), {
          tier: "alertas",
          subscription_status: "active",
          stripe_subscription_id: s.subscription ? String(s.subscription) : null,
          price_id: process.env.STRIPE_PRICE_ALERTAS,
        })
      }
      break
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription
      const status = mapStatus(sub.status)
      const fields: Record<string, unknown> = {
        subscription_status: status,
        stripe_subscription_id: sub.id,
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        price_id: sub.items.data[0]?.price?.id ?? null,
      }
      if (status === "active") fields.tier = "alertas"
      await update(String(sub.customer), fields)
      break
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription
      await update(String(sub.customer), { subscription_status: "canceled", tier: "trial" })
      break
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice
      if (inv.customer) await update(String(inv.customer), { subscription_status: "past_due" })
      break
    }
  }

  return NextResponse.json({ received: true })
}
