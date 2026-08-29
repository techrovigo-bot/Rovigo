-- 0006_seed.sql
-- Dados iniciais: kill-switches de portal e alguns buckets de exemplo.
-- Os buckets definitivos dependem dos perfis dos betas (semanas 3-4); estes
-- servem só para o pipeline rodar ponta a ponta em teste.

-- Kill-switch por portal. LinkedIn desligado no produto comercial (ToS).
insert into public.feature_flags (key, enabled, description) values
  ('portal.gupy.enabled',     true,  'Gupy — API pública, portal âncora do MVP'),
  ('portal.catho.enabled',    true,  'Catho — scraping HTML, modo conservador'),
  ('portal.vagas.enabled',    true,  'Vagas.com — scraping HTML, modo conservador'),
  ('portal.linkedin.enabled', false, 'LinkedIn — DESLIGADO no produto comercial (ToS personal use only)')
on conflict (key) do nothing;

-- Buckets de exemplo (cargo × região). query_terms traz os termos por portal.
insert into public.search_buckets (key, label, category, region, query_terms) values
  ('automacao-ia-remoto', 'Automação e IA — Remoto', 'automacao-ia', 'remoto',
   '{"gupy": ["automação", "inteligência artificial", "n8n"], "catho": ["automação de processos"], "vagas": ["automação", "inteligência artificial"]}'),
  ('dev-backend-remoto', 'Desenvolvimento Backend — Remoto', 'dev-backend', 'remoto',
   '{"gupy": ["desenvolvedor backend", "engenheiro de software"], "catho": ["desenvolvedor"], "vagas": ["desenvolvedor backend"]}'),
  ('dados-sp', 'Dados — São Paulo', 'dados', 'SP',
   '{"gupy": ["analista de dados", "engenheiro de dados"], "catho": ["analista de dados"], "vagas": ["analista de dados"]}')
on conflict (key) do nothing;
