// Markdown -> HTML para impressão. O Gotenberg converte esse HTML em PDF.
//
// O framework original usava LaTeX, onde evitar título órfão exigia
// \needspace e cada ajuste de layout era um ciclo de compilação. Em CSS de
// impressão, `page-break-inside: avoid` resolve isso declarativamente.
// Coluna única de propósito: é o layout que sobrevive à extração de texto de
// um ATS (multi-coluna embaralha a ordem de leitura).
//
// Subset de markdown suportado, deliberadamente pequeno: h1-h3, listas,
// negrito, itálico e parágrafos. É tudo que os prompts produzem.

import type { DocProfile } from "./types.js"

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Inline: **negrito**, *itálico*. Roda depois do escape. */
function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+?)\*/g, "$1<em>$2</em>")
}

export function mdToHtml(md: string): string {
  const out: string[] = []
  let inList = false
  const closeList = () => {
    if (inList) {
      out.push("</ul>")
      inList = false
    }
  }

  for (const rawLine of String(md ?? "").split("\n")) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      closeList()
      continue
    }
    let m = line.match(/^###\s+(.*)$/)
    if (m) {
      closeList()
      out.push(`<h3>${inline(m[1])}</h3>`)
      continue
    }
    m = line.match(/^##\s+(.*)$/)
    if (m) {
      closeList()
      out.push(`<h2>${inline(m[1])}</h2>`)
      continue
    }
    m = line.match(/^#\s+(.*)$/)
    if (m) {
      closeList()
      out.push(`<h1>${inline(m[1])}</h1>`)
      continue
    }
    m = line.match(/^\s*[-*]\s+(.*)$/)
    if (m) {
      if (!inList) {
        out.push("<ul>")
        inList = true
      }
      out.push(`<li>${inline(m[1])}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(line.trim())}</p>`)
  }
  closeList()
  return out.join("\n")
}

const BASE_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10.5pt; line-height: 1.45; color: #1a1f24; margin: 0;
  }
  h1 { font-size: 19pt; margin: 0 0 2pt; letter-spacing: -0.2pt; }
  h2 {
    font-size: 11.5pt; text-transform: uppercase; letter-spacing: 0.6pt;
    margin: 14pt 0 5pt; padding-bottom: 2pt; border-bottom: 0.6pt solid #c8ced4;
    page-break-after: avoid;
  }
  h3 { font-size: 11pt; margin: 9pt 0 1pt; page-break-after: avoid; }
  p { margin: 0 0 6pt; }
  ul { margin: 3pt 0 6pt; padding-left: 14pt; }
  li { margin: 0 0 2.5pt; }
  em { color: #5c6670; font-style: normal; font-size: 9.5pt; }
  .contact { color: #5c6670; font-size: 9.5pt; margin: 0 0 4pt; }
  /* Um cargo nunca fica sozinho no fim da página, separado dos seus bullets.
     É o equivalente CSS do \\needspace que o template LaTeX exigia. */
  h3, h3 + em, h3 + p { page-break-after: avoid; }
  li, p { page-break-inside: avoid; }
`

function shell(title: string, css: string, inner: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${BASE_CSS}${css}</style></head>
<body>
${inner}
</body>
</html>`
}

export function renderCv(p: DocProfile, md: string): string {
  return shell(`CV — ${p.fullName ?? "candidato"}`, "", mdToHtml(md))
}

export function renderCoverLetter(p: DocProfile, md: string): string {
  // A carta é mais arejada e cabe em uma página; sem regras de seção do CV.
  const css = `
    body { font-size: 11pt; line-height: 1.55; }
    h1 { font-size: 15pt; margin-bottom: 10pt; }
    h2 { border: 0; text-transform: none; letter-spacing: 0; font-size: 12pt; }
    p { margin: 0 0 9pt; }
  `
  return shell(`Carta — ${p.fullName ?? "candidato"}`, css, mdToHtml(md))
}
