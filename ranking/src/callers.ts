// Callers de LLM para o harness de avaliação. Sem dependências: usa fetch.
// Em produção, quem chama o modelo é o nó LLM do n8n; isto existe só para o
// golden set rodar ponta a ponta localmente.

export type LlmCaller = (system: string, user: string) => Promise<string>

/** OpenRouter (barato, multi-modelo). Requer OPENROUTER_API_KEY.
 *  Modelo default sugerido para triagem: um modelo pequeno e barato. */
export function makeOpenRouterCaller(model = process.env.RANK_MODEL ?? "anthropic/claude-haiku-4.5"): LlmCaller {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error("OPENROUTER_API_KEY não definido")
  return async (system, user) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ""
  }
}
