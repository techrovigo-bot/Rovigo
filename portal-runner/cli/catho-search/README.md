# catho-cli

Command-line search over [catho.com.br](https://www.catho.com.br) (Brazil).

Zero runtime dependencies: plain `bun` + `fetch` + regex parsing. `bun install`
only pulls TypeScript dev types, so the CLI runs on a fresh clone without
installing anything.

## Install (optional)

```bash
cd .agents/skills/catho-search/cli && bun install
```

Only needed for `bun run typecheck` and editor types.

## Usage

```bash
bun run src/cli.ts search -q "analista de dados" --format table
bun run src/cli.ts search -q "analista de dados" -l "Curitiba PR" --jobage 7
bun run src/cli.ts detail 38066988 --format plain
```

`bun run src/cli.ts --help` prints the full flag reference (in Portuguese, as the
portal is Brazilian).

## Access

The CLI uses an honest, self-identifying User-Agent by default and is served
normally. Catho's firewall intermittently answers automated clients with `403`
on paths its own `robots.txt` allows; when that happens the CLI fails with
`WAF_BLOCKED` rather than returning an empty result set, and
`--browser-headers` (or `CATHO_BROWSER_HEADERS=1`) escalates to browser headers
as a deliberate, opt-in choice. The full reasoning is at the top of
`src/helpers.ts` and in the skill's `SKILL.md`.

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

- `buildUrl()` must never produce a URL carrying `?q=` or hitting
  `/buscar/vagas/` — both are disallowed by robots.txt. A unit test asserts it.
- The employer name is often a literal `********` mask, which becomes `null`.
  `Empresa Confidencial` is kept, because it means something different.
- Card dates carry no year; `parseCardDate()` infers it and is unit-tested with
  an injected clock, including the December-read-in-January case.
- The slug in a posting URL is decorative — the id alone resolves the posting —
  but the two-segment shape `/vagas/<slug>/<id>` is required, since `/vagas/<id>`
  returns a page with no JSON-LD.

## Tests

```bash
bun test
```

`cli-flag-validation.test.ts` and `parsing.test.ts` are network-free — the
parsing fixtures are trimmed copies of markup the portal actually served.
`live-smoke.test.ts` hits the real site on the default honest User-Agent, so a
failure there is the signal that the firewall has started refusing it.
