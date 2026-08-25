/**
 * Ask AI: retrieval over this help centre, then a streamed answer.
 *
 * The index is built at deploy time by scripts/build-ask-index.mjs and imported
 * here, so a question costs one embedding call and one completion — no vector
 * database, no per-request corpus upload.
 *
 * The model is told to answer only from the retrieved passages. That is what
 * makes the citations honest: every claim in the answer is meant to be findable
 * on the page the answer links to.
 */

import askIndex from "../../../data/ask-index.json"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** A streamed answer outlives the 10s a serverless function gets by default. */
export const maxDuration = 60

const EMBEDDING_MODEL = "text-embedding-3-small"
const ANSWER_MODEL = process.env.OPENAI_DOCS_MODEL ?? "gpt-4.1-mini"
const TOP_K = 6
const MAX_QUESTION_CHARS = 800

type Chunk = {
  id: string
  url: string
  title: string
  section: string | null
  text: string
  embedding?: number[]
}

type Body = {
  question?: unknown
  history?: unknown
}

const CHUNKS = askIndex.chunks as Chunk[]

const SYSTEM = `You are the help assistant for CaseWize, case-management and case-intelligence software for litigation firms.

Answer only from the passages given to you. They are the CaseWize help centre.

Rules:
- If the passages do not cover the question, say so plainly and point to the closest page. Never guess at a feature, a limit, a role or a setting.
- Be specific and short. Two or three sentences is usually the whole answer. Use a short list only when the answer really is a list of steps.
- Use the product's own words: matters, the case file, the lead attorney, a run, a development, a release, an ethical wall.
- Do not invent UI that is not described. Do not describe pricing numbers, plan limits or keyboard shortcuts unless a passage states them.
- Never give legal advice, and never suggest what a firm should do on an actual matter.
- Write in plain prose. Do not add a "Sources" section, and never refer to the passages by number or as "passages" — the interface shows the sources itself.`

export async function POST(request: Request) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return text("That request could not be read.", 400)
  }

  const question =
    typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION_CHARS) : ""

  if (!question) return text("Ask a question first.", 400)

  const key = process.env.OPENAI_API_KEY
  if (!key) {
    return text(
      "Ask AI is not configured on this deployment — OPENAI_API_KEY is missing. The search box still works.",
      503,
    )
  }
  if (CHUNKS.length === 0) {
    return text(
      "The help centre index is empty. Run `npm run ask:index` and deploy again.",
      503,
    )
  }

  const history = parseHistory(body.history)

  let matches: Chunk[]
  try {
    matches = await retrieve(question, key)
  } catch (error) {
    return text(
      `The question could not be matched against the docs. ${(error as Error).message}`,
      502,
    )
  }

  const sources = dedupeSources(matches)
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )

      send("sources", sources)

      try {
        await streamAnswer({ question, history, matches, key }, (delta) =>
          send("delta", { text: delta }),
        )
      } catch (error) {
        send("error", { message: (error as Error).message })
      }

      send("done", {})
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}

function text(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

function parseHistory(value: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(-3)
    .filter(
      (turn): turn is { question: string; answer: string } =>
        typeof turn?.question === "string" && typeof turn?.answer === "string",
    )
    .map((turn) => ({
      question: turn.question.slice(0, MAX_QUESTION_CHARS),
      answer: turn.answer.slice(0, 1200),
    }))
}

async function retrieve(question: string, key: string): Promise<Chunk[]> {
  if (!askIndex.embedded) return lexical(question)

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: question }),
  })

  if (!response.ok) throw new Error(`Embedding failed (${response.status}).`)

  const payload = (await response.json()) as { data: { embedding: number[] }[] }
  const query = payload.data[0].embedding

  return CHUNKS.map((chunk) => ({
    chunk,
    score: chunk.embedding ? cosine(query, chunk.embedding) : 0,
  }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map((hit) => hit.chunk)
}

/** The no-key fallback: term overlap, weighted towards title and heading. */
function lexical(question: string): Chunk[] {
  const terms = tokenize(question)
  if (terms.length === 0) return CHUNKS.slice(0, TOP_K)

  return CHUNKS.map((chunk) => {
    const haystack = tokenize(
      `${chunk.title} ${chunk.section ?? ""} ${chunk.title} ${chunk.section ?? ""} ${chunk.text}`,
    )
    const counts = new Map<string, number>()
    for (const token of haystack) counts.set(token, (counts.get(token) ?? 0) + 1)

    let score = 0
    for (const term of terms) score += Math.min(counts.get(term) ?? 0, 4)

    return { chunk, score }
  })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map((hit) => hit.chunk)
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2)
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

function dedupeSources(matches: Chunk[]) {
  const seen = new Set<string>()
  const out: { title: string; section: string | null; url: string }[] = []

  for (const chunk of matches) {
    const url = chunk.section
      ? `${chunk.url}#${slug(chunk.section)}`
      : chunk.url
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ title: chunk.title, section: chunk.section, url })
    if (out.length === 4) break
  }

  return out
}

/** Matches the anchor ids Nextra generates for headings. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
}

async function streamAnswer(
  args: {
    question: string
    history: { question: string; answer: string }[]
    matches: Chunk[]
    key: string
  },
  onDelta: (text: string) => void,
) {
  const passages = args.matches
    .map(
      (chunk, i) =>
        `[${i + 1}] ${chunk.title}${chunk.section ? ` › ${chunk.section}` : ""}\n${chunk.text}`,
    )
    .join("\n\n---\n\n")

  const messages = [
    { role: "system", content: SYSTEM },
    ...args.history.flatMap((turn) => [
      { role: "user", content: turn.question },
      { role: "assistant", content: turn.answer },
    ]),
    {
      role: "user",
      content: `Passages from the CaseWize help centre:\n\n${passages}\n\n---\n\nQuestion: ${args.question}`,
    },
  ]

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANSWER_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 700,
      stream: true,
    }),
  })

  if (!response.ok || !response.body) {
    throw new Error(
      `The model did not answer (${response.status}). Try again in a moment.`,
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf("\n")
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 1)
      boundary = buffer.indexOf("\n")

      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") return

      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[]
        }
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) onDelta(delta)
      } catch {
        /* A partial frame; the next read completes it. */
      }
    }
  }
}
