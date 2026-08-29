import Stripe from "stripe"

// Cliente Stripe — só no servidor (a secret key nunca vai ao browser).
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2024-06-20",
})
