"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import styles from "./ask-ai.module.css"

type Source = { title: string; section: string | null; url: string }

type Turn = {
  question: string
  answer: string
  sources: Source[]
  error: string | null
  done: boolean
}

const SUGGESTIONS = [
  "Who can release a document to the client?",
  "Why is my document not being read by the analysis?",
  "What stops a matter from going active?",
  "What does an ethical wall actually hide?",
]

/** Parses the event/data frames the /api/ask route streams back. */
function readFrames(buffer: string): {
  frames: { event: string; data: string }[]
  rest: string
} {
  const frames: { event: string; data: string }[] = []
  let rest = buffer

  for (;;) {
    const end = rest.indexOf("\n\n")
    if (end === -1) break

    const block = rest.slice(0, end)
    rest = rest.slice(end + 2)

    let event = "message"
    const data: string[] = []
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    }
    frames.push({ event, data: data.join("\n") })
  }

  return { frames, rest }
}

export function AskAI() {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
        event.preventDefault()
        setOpen(true)
      }
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else abortRef.current?.abort()
  }, [open])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [turns])

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || busy) return

      setQuestion("")
      setBusy(true)

      const history = turns
        .filter((turn) => turn.answer && !turn.error)
        .slice(-3)
        .map((turn) => ({ question: turn.question, answer: turn.answer }))

      const index = turns.length
      setTurns((prev) => [
        ...prev,
        { question: trimmed, answer: "", sources: [], error: null, done: false },
      ])

      const update = (patch: Partial<Turn>) =>
        setTurns((prev) =>
          prev.map((turn, i) => (i === index ? { ...turn, ...patch } : turn)),
        )

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: trimmed, history }),
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "")
          throw new Error(detail || `Request failed (${response.status}).`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        let answer = ""

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const { frames, rest } = readFrames(buffer)
          buffer = rest

          for (const frame of frames) {
            if (frame.event === "sources") {
              update({ sources: JSON.parse(frame.data) as Source[] })
            } else if (frame.event === "delta") {
              answer += (JSON.parse(frame.data) as { text: string }).text
              update({ answer })
            } else if (frame.event === "error") {
              update({
                error: (JSON.parse(frame.data) as { message: string }).message,
              })
            }
          }
        }

        update({ done: true })
      } catch (error) {
        if ((error as Error).name === "AbortError") return
        update({ error: (error as Error).message, done: true })
      } finally {
        abortRef.current = null
        setBusy(false)
      }
    },
    [busy, turns],
  )

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <SparkIcon />
        Ask AI
        <kbd>Ctrl I</kbd>
      </button>

      {open ? (
        <div
          className={styles.overlay}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-label="Ask AI"
          >
            <div className={styles.head}>
              <SparkIcon />
              <span className={styles.headTitle}>Ask the CaseWize docs</span>
              <span className={styles.headNote}>
                Answers come from these pages
              </span>
              <button
                type="button"
                className={styles.close}
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                &#10005;
              </button>
            </div>

            <div className={styles.body} ref={bodyRef}>
              {turns.length === 0 ? (
                <>
                  <p className={styles.intro}>
                    Ask a question about running a matter in CaseWize. The answer
                    is written from this help centre and cites the pages it used,
                    so you can check it.
                  </p>
                  <div className={styles.suggestions}>
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className={styles.suggestion}
                        onClick={() => ask(suggestion)}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                turns.map((turn, index) => (
                  <div className={styles.turn} key={index}>
                    <p className={styles.question}>{turn.question}</p>
                    {turn.error ? (
                      <p className={styles.error}>{turn.error}</p>
                    ) : (
                      <div className={styles.answer}>
                        {turn.answer}
                        {!turn.done ? <span className={styles.caret} /> : null}
                      </div>
                    )}
                    {turn.sources.length > 0 ? (
                      <div className={styles.sources}>
                        <span className={styles.sourcesLabel}>Sources</span>
                        {turn.sources.map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            className={styles.source}
                            onClick={() => setOpen(false)}
                          >
                            {source.title}
                            {source.section ? ` — ${source.section}` : ""}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault()
                void ask(question)
              }}
            >
              <input
                ref={inputRef}
                className={styles.input}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Ask a question..."
                aria-label="Your question"
              />
              <button
                type="submit"
                className={styles.send}
                disabled={busy || question.trim().length === 0}
              >
                {busy ? "Thinking..." : "Ask"}
              </button>
            </form>

            <p className={styles.disclaimer}>
              This assistant explains how the product works. It cannot see your
              firm, your matters or your documents, and nothing it says is legal
              advice.
            </p>
          </div>
        </div>
      ) : null}
    </>
  )
}

function SparkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm6.5 11l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" />
    </svg>
  )
}
