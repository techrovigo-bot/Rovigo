#!/usr/bin/env bash
# Sobe a stack e roda o pipeline ponta a ponta: migrações → ingest → embed →
# onboarding (embute perfil → ranqueia → notifica) → verificação.
#
# Uso:   cp .env.example .env  (preencha)  &&  bash scripts/e2e.sh
# Requer: Docker + curl. O Postgres/psql roda via container (postgres:16); não
#         precisa de psql no host. O usuário de teste (TEST_EMAIL) já deve existir
#         no Supabase (Auth → Users → Add user) — o trigger cria tenant+profile.
#
# Passos que dependem do banco (migrações, seed, verificação) só rodam se
# DATABASE_URL estiver no .env; senão são pulados com aviso.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── carregar .env ────────────────────────────────────────────────────────────
[ -f .env ] || { echo "ERRO: crie o .env (cp .env.example .env e preencha)"; exit 1; }
set -a; . ./.env; set +a

have_db() { [ -n "${DATABASE_URL:-}" ]; }

pgc() { docker run --rm -i postgres:16 psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "$1"; }
pgf() { docker run --rm -v "$ROOT/supabase/migrations:/m:ro" postgres:16 \
          psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "/m/$1"; }
n8ncli() { docker compose exec -T n8n n8n "$@"; }

wait_health() { # nome url
  printf "aguardando %s" "$1"
  for _ in $(seq 1 60); do
    if curl -sf "$2" >/dev/null 2>&1; then echo " ok"; return 0; fi
    printf "."; sleep 2
  done
  echo " TIMEOUT"; return 1
}

echo "==> 1/6  subindo a stack (build)…"
docker compose up -d --build

echo "==> 2/6  aguardando serviços…"
wait_health "portal-runner" "http://localhost:8080/health"
wait_health "rank-service"  "http://localhost:8090/health"
wait_health "n8n"           "http://localhost:5678/healthz"

echo "==> 3/6  migrações do banco"
if have_db; then
  if [ "$(pgc "select to_regclass('public.tenants') is not null")" = "t" ]; then
    echo "    tabelas já existem — pulando migrações"
  else
    for f in supabase/migrations/*.sql; do
      b="$(basename "$f")"; echo "    aplicando $b"; pgf "$b"
    done
  fi
else
  echo "    DATABASE_URL vazio — pulando (aplique as migrações à mão, ver TESTING.md)"
fi

echo "==> 4/6  importar e ativar os workflows no n8n"
n8ncli import:workflow --separate --input=/workflows >/dev/null
n8ncli update:workflow --all --active=true >/dev/null
echo "    5 workflows ativos"

echo "==> 5/6  rodar o pipeline"
echo "    ingest-bucket…";  n8ncli execute --file=/workflows/ingest-bucket.json >/dev/null && echo "    ok"
echo "    embed-jobs…";     n8ncli execute --file=/workflows/embed-jobs.json    >/dev/null && echo "    ok" || echo "    (falhou — OPENAI_API_KEY? segue no fallback de recência)"

if have_db && [ -n "${TEST_EMAIL:-}" ]; then
  TENANT="$(pgc "select t.id from public.tenants t join auth.users u on u.id=t.user_id where u.email='${TEST_EMAIL}'" || true)"
  if [ -n "$TENANT" ]; then
    echo "    preenchendo perfil de teste ($TEST_EMAIL → $TENANT)"
    pgc "
      update public.profiles set
        target_roles=array['engenheiro de automação','ai engineer'],
        seniority='senior', cities=array['Curitiba'],
        accepts_work_models=array['remote','hybrid']::work_model[],
        languages='[{\"lang\":\"português\",\"level\":\"native\"},{\"lang\":\"inglês\",\"level\":\"reading\"}]'::jsonb,
        skills=array['n8n','python','rag','api rest'],
        contract_preference='pj', headline='Automação e agentes de IA em produção',
        completeness=100
      where tenant_id='${TENANT}';
      update public.tenants set llm_consent_at=now(), llm_consent_version='v1' where id='${TENANT}';
    " >/dev/null
    echo "    onboarding-hook (embute → ranqueia → notifica)…"
    curl -sf -X POST "http://localhost:5678/webhook/onboarding" \
      -H "content-type: application/json" -d "{\"tenant_id\":\"${TENANT}\"}" >/dev/null \
      && echo "    ok" || echo "    (webhook falhou — confira se o n8n pediu setup de owner na UI)"
  else
    echo "    usuário $TEST_EMAIL não encontrado — crie em Auth → Users e rode de novo"
  fi
else
  echo "    sem DATABASE_URL/TEST_EMAIL — pulando seed+onboarding (rode rank-daily/notify-daily à mão)"
fi

echo "==> 6/6  verificação"
if have_db; then
  echo "    jobs por portal:"; pgc "select source||': '||count(*) from public.jobs group by source" | sed 's/^/      /'
  echo "    jobs com embedding: $(pgc "select count(*) filter (where embedding is not null)||'/'||count(*) from public.jobs")"
  if [ -n "${TENANT:-}" ]; then
    echo "    matches do tenant de teste (top 5):"
    pgc "select coalesce(score::text,'veto')||' '||coalesce(verdict,location_verdict::text)||'  '||(select title from public.jobs j where j.id=m.job_id)
         from public.job_matches m where m.tenant_id='${TENANT}' order by score desc nulls last limit 5" | sed 's/^/      /'
  fi
  echo "    uso de LLM: $(pgc "select coalesce(string_agg(workflow||'='||tokens_in,', '),'nenhum') from public.llm_usage")"
else
  echo "    (sem DATABASE_URL — verifique no painel do Supabase)"
fi

echo ""
echo "PRONTO. Painel: cd panel && npm install && npm run dev  (http://localhost:3000)"
echo "Derrubar a stack: docker compose down   (com -v apaga o estado do n8n)"
