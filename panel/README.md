# panel

Painel do candidato (Next.js App Router + Supabase Auth). Onboarding com consentimentos LGPD, listagem de vagas ranqueadas e página de conta (exportar/excluir dados). Hospedagem: Vercel.

## Rodar local

```bash
cp .env.example .env.local   # preencha SUPABASE + N8N_ONBOARDING_URL
npm install
npm run dev                  # http://localhost:3000
```

## Fluxo

1. **Login** (`/login`) — magic link por e-mail (`signInWithOtp`). O callback (`/auth/callback`) troca o code por sessão e manda ao onboarding (perfil vazio) ou às vagas.
2. **Onboarding** (`/onboarding`) — formulário de perfil + **2 consentimentos**: IA (obrigatório, sem ele não há ranking) e WhatsApp (opcional; sem ele, e-mail). Ao salvar, a Server Action grava `profiles` + os consentimentos em `tenants` e chama o **onboarding-hook** do n8n com `{tenant_id}` (embute perfil → ranqueia → notifica no dia 0).
3. **Vagas** (`/vagas`) — lista os `job_matches` pontuados (RLS restringe ao tenant), com score, verdito, forças/lacunas e botão "não me interessa" (marca `dismissed`).
4. **Planos** (`/planos`) — Teste grátis (14 dias), Alertas (assinatura mensal via **Stripe Checkout**), Pro (em breve, com a geração de documentos). O botão Assinar cria a sessão de checkout no servidor e redireciona.
5. **Conta** (`/conta`) — mostra o plano e dias de trial restantes; exporta dados (`rpc export_my_data`) e exclui a conta (`rpc delete_my_account`, cascade).

## Billing (Stripe)

- **Checkout**: Server Action `subscribeAlertas` cria o `customer` (uma vez, gravado via service_role) e a Checkout Session (mode subscription, BRL, Pix/cartão conforme sua conta Stripe).
- **Webhook** (`/api/stripe/webhook`): verifica a assinatura com o corpo cru e atualiza `tenants` (tier, subscription_status, subscription id, período) via **service_role**. Configure o endpoint no Stripe e cole o `whsec_...` em `STRIPE_WEBHOOK_SECRET`. Local: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
- **Entitlement**: o `rank-daily` só processa pagos ativos ou trials no prazo, e chama `expire_trials()` no início de cada rodada (migração 0012). Trial vencido para de receber vagas.

## Segurança

- Só a **anon key** vai ao browser (pública por design). A **RLS** isola todos os dados por `tenant_id`; o painel nunca vê a service_role. As RPCs de LGPD são `security definer` e restritas ao próprio tenant via `auth.uid()`.
- O trigger `protect_match_scores` (migração 0005) impede o candidato de adulterar o score — no painel ele só muda `status` (dismiss/save).
- O webhook do n8n é chamado **no servidor** (Server Action), nunca do browser.

## Variáveis de ambiente

| Var | Onde | O quê |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser+server | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser+server | anon key (pública; RLS protege) |
| `NEXT_PUBLIC_SITE_URL` | browser | base URL p/ redirect do magic link e checkout |
| `N8N_ONBOARDING_URL` | **só server** | webhook `.../webhook/onboarding` |
| `STRIPE_SECRET_KEY` `STRIPE_WEBHOOK_SECRET` `STRIPE_PRICE_ALERTAS` | **só server** | billing |
| `SUPABASE_SERVICE_KEY` | **só server** | usada apenas pelo webhook do Stripe |

## Não feito neste ambiente (honestidade)

O painel foi escrito mas **não foi `npm install`/`build`/rodado aqui** (sem Next instalado e install pesado). É código-fonte pronto para `npm install && npm run dev`. O que exige um passo real: configurar o provedor de e-mail do Supabase Auth (magic link), a política de privacidade + DPAs, e o Storage cleanup na exclusão (a migração 0007 já avisa que o Storage não é coberto por SQL). Billing/tiers e o gate de trial ainda não estão no painel.
