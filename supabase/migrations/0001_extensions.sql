-- 0001_extensions.sql
-- Extensões necessárias para o schema.
-- pgvector: embeddings de perfil e de vaga para a pré-triagem por similaridade (estágio 2 do ranking).
-- pgcrypto: gen_random_uuid() para chaves primárias.
-- No Supabase, extensões vivem no schema "extensions".

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;
