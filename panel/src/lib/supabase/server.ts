import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

/** Cliente Supabase para Server Components / Server Actions / Route Handlers.
 *  Usa a anon key + cookies da sessão; a RLS isola tudo por tenant. */
export function createClient() {
  const cookieStore = cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch {
            // chamado de um Server Component: ignorado — o middleware renova a sessão.
          }
        },
      },
    },
  )
}
