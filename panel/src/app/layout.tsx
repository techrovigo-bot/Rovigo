import "./globals.css"
import type { Metadata } from "next"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { LogoutButton } from "./logout-button"

export const metadata: Metadata = {
  title: "Rovigo Jobs",
  description: "Vagas certas, no seu WhatsApp.",
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <html lang="pt-BR">
      <body>
        <header className="nav">
          <span className="brand">Rovigo Jobs</span>
          {user && (
            <>
              <Link href="/vagas">Vagas</Link>
              <Link href="/onboarding">Perfil</Link>
              <Link href="/planos">Planos</Link>
              <Link href="/conta">Conta</Link>
            </>
          )}
          <span className="spacer" />
          {user ? <LogoutButton /> : <Link href="/login">Entrar</Link>}
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
