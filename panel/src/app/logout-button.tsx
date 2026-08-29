"use client"
import { createClient } from "@/lib/supabase/client"
import { useRouter } from "next/navigation"

export function LogoutButton() {
  const router = useRouter()
  async function logout() {
    await createClient().auth.signOut()
    router.push("/login")
    router.refresh()
  }
  return (
    <button className="secondary" onClick={logout}>Sair</button>
  )
}
