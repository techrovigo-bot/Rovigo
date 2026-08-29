import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"

export default async function Home() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect("/vagas")

  return (
    <div>
      <h1>Vagas certas, no seu WhatsApp.</h1>
      <p className="muted">
        Diga o que você procura uma vez. Todo dia buscamos as vagas novas nos principais portais,
        pontuamos o quanto cada uma combina com o seu perfil e mandamos só as melhores.
      </p>
      <div className="card">
        <p>Comece agora — leva 2 minutos.</p>
        <a className="btn" href="/login">Entrar / criar conta</a>
      </div>
    </div>
  )
}
