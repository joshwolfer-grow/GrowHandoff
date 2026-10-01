-- Ask Grow — semantic search index over training decks (Canva), Pronto chat,
-- and manager notes/requests. Free stack: pgvector (Supabase) + Google
-- text-embedding-004 (768-dim, free tier) for embeddings + Gemini Flash to answer.
--
-- Run once in the Supabase SQL editor (Grow project).

create extension if not exists vector;

create table if not exists public.doc_chunks (
  id          bigint generated always as identity primary key,
  source      text not null,              -- 'training' | 'chat' | 'note'
  source_id   text not null,              -- canva design id / pronto message id / note id
  chunk_ix    int  not null default 0,    -- ordinal within the source item
  title       text,                       -- deck title / channel / note label
  ref         text,                       -- human citation, e.g. "The Pitch (In depth) — Closing"
  url         text,                       -- canva view_url or dashboard deep link
  content     text not null,
  embedding   vector(768),
  updated_at  timestamptz not null default now(),
  unique (source, source_id, chunk_ix)
);

-- HNSW cosine index: good for small/medium sets, no training/ANALYZE step needed.
create index if not exists doc_chunks_embedding_idx
  on public.doc_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists doc_chunks_source_idx on public.doc_chunks (source);

-- Return the closest chunks, optionally filtered to a subset of sources.
create or replace function public.match_doc_chunks(
  query_embedding vector(768),
  match_count int default 8,
  filter_sources text[] default null
)
returns table (
  id bigint, source text, title text, ref text, url text, content text, similarity float
)
language sql stable as $$
  select c.id, c.source, c.title, c.ref, c.url, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.doc_chunks c
  where c.embedding is not null
    and (filter_sources is null or c.source = any (filter_sources))
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- RLS: mirror the project's existing anon-write pattern (like `knocking`) so the
-- in-session indexer can write with the public anon key — no service key needed
-- locally. Content is internal training/chat, consistent with the app's model.
alter table public.doc_chunks enable row level security;
drop policy if exists "anon all doc_chunks" on public.doc_chunks;
create policy "anon all doc_chunks" on public.doc_chunks for all using (true) with check (true);

grant execute on function public.match_doc_chunks(vector, int, text[]) to anon;
