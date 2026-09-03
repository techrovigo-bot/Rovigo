// Upload dos PDFs para o Supabase Storage.
//
// Mora aqui, e não no n8n, porque o Code node do n8n serializa Buffer como
// JSON ({"type":"Buffer","data":[...]}) e o objeto subia corrompido. Aqui os
// bytes nunca saem da forma nativa, e some o round-trip de base64 pelo n8n.

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? ""
const BUCKET = "documents"

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "StorageError"
  }
}

export function storageConfigured(): boolean {
  return SUPABASE_URL !== "" && SERVICE_KEY !== ""
}

/**
 * Sobe um PDF em {tenantId}/{documentId}.pdf e devolve o caminho.
 * Usa x-upsert porque regerar um documento sobrescreve o anterior.
 */
export async function uploadPdf(
  tenantId: string,
  documentId: string,
  bytes: Uint8Array,
  timeoutMs = 30000,
): Promise<string> {
  if (!storageConfigured()) {
    throw new StorageError("SUPABASE_URL/SUPABASE_SERVICE_KEY não configurados", 503)
  }
  const path = `${tenantId}/${documentId}.pdf`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
      },
      // Uint8Array direto: sem JSON, sem base64.
      body: bytes as unknown as BodyInit,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300)
      throw new StorageError(`Storage respondeu ${res.status}: ${detail}`, res.status)
    }
    return path
  } catch (e) {
    if (e instanceof StorageError) throw e
    if (e instanceof Error && e.name === "AbortError") {
      throw new StorageError(`Storage não respondeu em ${timeoutMs}ms`, 504)
    }
    throw new StorageError(`falha ao subir para o Storage: ${String((e as Error).message ?? e)}`, 502)
  } finally {
    clearTimeout(timer)
  }
}
