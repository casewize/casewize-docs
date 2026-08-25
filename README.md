# CaseWize Docs

The CaseWize help centre — end-user documentation for the litigation firms that
run matters in [casewize-v2](../casewize-v2), with an **Ask AI** panel that
answers from these pages and cites them.

Built with [Nextra 4](https://nextra.site) on Next.js 15 (App Router).

## Running it

```bash
npm install
cp .env.example .env.local   # add OPENAI_API_KEY for Ask AI
npm run ask:index            # embeds content/ into data/ask-index.json
npm run dev                  # http://localhost:3050
```

`npm run build` does the index, the Next build, and the Pagefind search index in
one pass. Search is a Pagefind index built from the rendered HTML, so **search
does not work under `npm run dev`** until you have run a build once — the Ask AI
panel does.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 3050 |
| `npm run ask:index` | Rebuild the Ask AI retrieval index only |
| `npm run build` | Ask index → `next build` → Pagefind |
| `npm run start` | Production server on port 3050 |
| `npm run typecheck` | `tsc --noEmit` |

## Writing docs

Pages are MDX under `content/`. The file path is the URL —
`content/documents/sensitivity.mdx` serves `/documents/sensitivity`. Ordering and
sidebar labels come from the `_meta.ts` file in each directory.

Frontmatter carries `title` and `description`; both are used by the page, the
metadata and the Ask AI index.

Nextra's built-ins are available by importing from `nextra/components` —
`Callout`, `Steps`, `Cards`, `Tabs`, `FileTree`.

After adding or editing a page, re-run `npm run ask:index` so Ask AI can see it.
`npm run build` does this for you.

## Ask AI

```
content/**.mdx
   │  scripts/build-ask-index.mjs — split at headings, embed each chunk
   ▼
data/ask-index.json               — ships with the build, no database
   │  app/api/ask/route.ts — embed the question, cosine top-6, stream an answer
   ▼
app/_components/ask-ai.tsx        — the panel in the navbar (Ctrl/Cmd + I)
```

- Embeddings: `text-embedding-3-small`, the same model casewize-v2 uses.
- Answers: `gpt-4.1-mini`, overridable with `OPENAI_DOCS_MODEL`.
- The model is told to answer **only** from the retrieved passages, so the
  citations shown under each answer are the pages the answer came from.
- Without `OPENAI_API_KEY` the site still builds: the index is written without
  vectors, and the panel reports that Ask AI is not configured. Retrieval falls
  back to keyword scoring if an unembedded index is ever queried with a key
  present.

The index is roughly 2.5 MB for ~40 pages. Rebuilding it costs one embeddings
call per 96 chunks.

## Notes

- `zod` is pinned to `4.1.13` in `overrides`. Nextra 4.6's prop schemas fail
  against zod 4.4 (`Layout` validates its props without `children`, which 4.4
  rejects as a missing non-optional field). Remove the pin only after checking
  a page still renders.
- Next.js is pinned to 15.x — the version Nextra 4.6 is built and tested
  against, rather than the 16.x the main app runs.
