/**
 * Builds the retrieval index the Ask AI panel answers from.
 *
 * Every MDX page under content/ is split at its headings, embedded once here,
 * and written to data/ask-index.json. Nothing queries a database at request
 * time — the whole corpus is a few hundred kilobytes and ships with the build.
 *
 * Without OPENAI_API_KEY the index is still written, minus the vectors, and the
 * route falls back to keyword scoring. A docs site that cannot build without a
 * model key is a docs site that stops shipping the week the key rotates.
 */

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CONTENT_DIR = join(ROOT, "content")
const OUT_FILE = join(ROOT, "data", "ask-index.json")

const EMBEDDING_MODEL = "text-embedding-3-small"
const BATCH_SIZE = 96
const MAX_CHUNK_CHARS = 1400
const MIN_CHUNK_CHARS = 120

loadEnv()

const files = walk(CONTENT_DIR).filter((file) => file.endsWith(".mdx"))
const chunks = files.flatMap((file) => chunkFile(file))

console.log(`ask-index: ${files.length} pages, ${chunks.length} chunks`)

const key = process.env.OPENAI_API_KEY
let embedded = false

if (key) {
  const vectors = await embedAll(
    chunks.map((chunk) => `${chunk.title} — ${chunk.section ?? ""}\n${chunk.text}`),
    key,
  )
  chunks.forEach((chunk, i) => {
    chunk.embedding = vectors[i]
  })
  embedded = true
} else {
  console.warn(
    "ask-index: OPENAI_API_KEY not set — writing a keyword-only index.",
  )
}

writeFileSync(
  OUT_FILE,
  JSON.stringify({
    model: embedded ? EMBEDDING_MODEL : null,
    embedded,
    chunks,
  }),
)

console.log(`ask-index: wrote ${relative(ROOT, OUT_FILE)} (embedded: ${embedded})`)

/** Reads .env / .env.local without a dependency, leaving real env vars alone. */
function loadEnv() {
  for (const name of [".env", ".env.local"]) {
    let raw
    try {
      raw = readFileSync(join(ROOT, name), "utf8")
    } catch {
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (!match) continue
      const value = match[2].trim().replace(/^["']|["']$/g, "")
      if (process.env[match[1]] === undefined) process.env[match[1]] = value
    }
  }
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function toUrl(file) {
  const rel = relative(CONTENT_DIR, file).split(sep).join("/")
  const path = rel.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "")
  return `/${path}`.replace(/\/$/, "") || "/"
}

/** MDX down to prose: no frontmatter, no imports, no component tags. */
function toPlainText(source) {
  return source
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(import|export)\s/.test(line))
    .join("\n")
    .replace(/<\/?[A-Z][\w.]*(\s[^>]*)?\/?>/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function chunkFile(file) {
  const source = readFileSync(file, "utf8")
  const url = toUrl(file)
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  const fromMatter = frontmatter
    ? /^\s*title:\s*(.+)$/m.exec(frontmatter[1])?.[1]?.replace(/^["']|["']$/g, "")
    : null
  const text = toPlainText(source)
  const title = fromMatter ?? /^#\s+(.+)$/m.exec(text)?.[1] ?? url

  const sections = []
  let current = { section: null, lines: [] }

  for (const line of text.split("\n")) {
    const heading = /^(##+)\s+(.+)$/.exec(line)
    if (heading) {
      sections.push(current)
      current = { section: heading[2].trim(), lines: [] }
      continue
    }
    if (/^#\s+/.test(line)) continue
    current.lines.push(line)
  }
  sections.push(current)

  const out = []
  for (const section of sections) {
    const body = section.lines.join("\n").trim()
    if (body.length < MIN_CHUNK_CHARS) continue

    for (const piece of split(body)) {
      out.push({
        id: createHash("sha1")
          .update(`${url}#${section.section ?? ""}#${piece.slice(0, 64)}`)
          .digest("hex")
          .slice(0, 16),
        url,
        title,
        section: section.section,
        text: piece,
      })
    }
  }

  return out
}

/** Splits on paragraph boundaries, never mid-sentence. */
function split(body) {
  if (body.length <= MAX_CHUNK_CHARS) return [body]

  const pieces = []
  let buffer = ""

  for (const paragraph of body.split(/\n\s*\n/)) {
    if (buffer && buffer.length + paragraph.length > MAX_CHUNK_CHARS) {
      pieces.push(buffer.trim())
      buffer = ""
    }
    buffer += (buffer ? "\n\n" : "") + paragraph
  }
  if (buffer.trim()) pieces.push(buffer.trim())

  return pieces
}

async function embedAll(texts, key) {
  const out = []

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE)
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    })

    if (!response.ok) {
      throw new Error(
        `Embeddings request failed (${response.status}): ${await response.text()}`,
      )
    }

    const payload = await response.json()
    for (const item of payload.data.sort((a, b) => a.index - b.index)) {
      /** Rounded: four decimals costs nothing in recall and halves the file. */
      out.push(item.embedding.map((value) => Math.round(value * 1e4) / 1e4))
    }
    console.log(`ask-index: embedded ${Math.min(start + BATCH_SIZE, texts.length)}/${texts.length}`)
  }

  return out
}
