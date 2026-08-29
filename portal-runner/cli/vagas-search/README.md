# vagas-cli

Command-line search over [vagas.com.br](https://www.vagas.com.br) (Brazil).

Zero runtime dependencies: plain `bun` + `fetch` + regex parsing. `bun install`
only pulls TypeScript dev types, so the CLI runs on a fresh clone without
installing anything.

## Install (optional)

```bash
cd .agents/skills/vagas-search/cli && bun install
```

Only needed for `bun run typecheck` and editor types.

## Usage

```bash
bun run src/cli.ts search -q "analista de dados" --format table
bun run src/cli.ts search -q "analista de dados" -l "Curitiba" --jobage 7
bun run src/cli.ts detail 2819206 --format plain
```

`bun run src/cli.ts --help` prints the full flag reference (in Portuguese, as the
portal is Brazilian).

## Contract

Shared with every portal CLI in this repo, so `/scrape` can treat them
interchangeably:

- Commands: `search` and `detail <id|url>`
- JSON output: `{ "meta": { "count", "page" }, "results": [...] }`, each result
  carrying at least `id`, `title`, `company`, `location`, `date`, `url` (absent
  values are `null`, never omitted)
- Errors: `{ "error": "...", "code": "..." }` on **stderr**, exit code `1`
- Unknown flags are rejected, never silently dropped

## Notes for maintainers

- Search is parsed from HTML; `detail` reads the posting page's schema.org
  JSON-LD, which survives markup churn far better. If search breaks and detail
  still works, the card selectors in `parseJobCards()` are what moved —
  `url-reference.md` lists every anchor.
- Each `<li class="vaga ...">` is parsed independently, so one malformed card
  cannot take the page down with it.
- Card dates come in absolute (`09/06/2026`) and relative (`Há 3 dias`) forms;
  `parseCardDate()` normalises both to ISO and is unit-tested with an injected
  clock.
- The location field must be cut at `<div class="tooltip-place">` or the
  tooltip copy leaks into it.

## Tests

```bash
bun test
```

`cli-flag-validation.test.ts` and `parsing.test.ts` are network-free — the
parsing fixtures are trimmed copies of markup the portal actually served.
`live-smoke.test.ts` hits the real site and is what proves the selectors still
match production.
