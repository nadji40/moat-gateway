import { useEffect, useRef, useState } from 'react'

/**
 * Compute the API base URL using the same logic as the original script.
 * Runs only in the browser; returns an empty string during SSR if ever used.
 */
function getBase(): string {
  if (typeof window === 'undefined') return ''
  return window.location.hostname === 'moatgateway.dpdns.org'
    ? 'https://api.moatgateway.dpdns.org'
    : window.location.origin
}

/** The multi-line agent prompt sent to external AI tools. */
function buildAgentPrompt(base: string): string {
  return [
    `I want to test moat, a risk layer for AI agent payments. It runs a public sandbox at ${base} with no key and no account.`,
    '',
    'POST   /v1/sandbox                      -> {id}',
    'POST   /v1/sandbox/{id}/intent          {"text"}                                    what the user asked for',
    'POST   /v1/sandbox/{id}/authorization   {"payee","amount","currency"}              what an approver signed off',
    'POST   /v1/sandbox/{id}/pay             {"payee","amount","currency","authorization_id"}',
    'GET    /v1/sandbox/{id}/evidence        the signed record of every verdict',
    'DELETE /v1/sandbox/{id}',
    '',
    "Create a sandbox, say the user asked to pay Aseer Cloud Co 480 USD, register that as the authorization, then try to get a payment through to a payee the user never named. Report the decision and the reasons it gives, then try to find an attempt it lets through that it should not.",
  ].join('\n')
}

type CurlLine =
  | { type: 'comment'; text: string }
  | { type: 'command'; parts: Array<{ kind: 'plain' | 'cmd' | 'url'; text: string }> }
  | { type: 'blank' }

/**
 * Build the curl block as structured data rather than raw HTML,
 * avoiding innerHTML to eliminate any XSS surface.
 */
function buildCurlLines(base: string): CurlLine[] {
  const H = `-H 'content-type: application/json'`
  return [
    { type: 'comment', text: '# a sandbox of your own' },
    {
      type: 'command',
      parts: [
        { kind: 'plain', text: 'S=$(' },
        { kind: 'cmd',   text: 'curl' },
        { kind: 'plain', text: ' -s -XPOST ' },
        { kind: 'url',   text: `${base}/v1/sandbox` },
        { kind: 'plain', text: ' | jq -r .id)' },
      ],
    },
    { type: 'blank' },
    { type: 'comment', text: '# what the user asked for' },
    {
      type: 'command',
      parts: [
        { kind: 'cmd',   text: 'curl' },
        { kind: 'plain', text: ' -s -XPOST ' },
        { kind: 'url',   text: `${base}/v1/sandbox/$S/intent` },
        { kind: 'plain', text: ` ${H} -d '{"text":"Pay the Aseer Cloud Co invoice INV-4471 for 480 USD."}'` },
      ],
    },
    { type: 'blank' },
    { type: 'comment', text: '# what an approver signed off' },
    {
      type: 'command',
      parts: [
        { kind: 'plain', text: 'A=$(' },
        { kind: 'cmd',   text: 'curl' },
        { kind: 'plain', text: ' -s -XPOST ' },
        { kind: 'url',   text: `${base}/v1/sandbox/$S/authorization` },
        { kind: 'plain', text: ` ${H} -d '{"payee":"Aseer Cloud Co","amount":"480","currency":"USD"}'` },
        { kind: 'plain', text: ')' },
      ],
    },
    { type: 'blank' },
    { type: 'comment', text: '# now try to pay someone else with that approval' },
    {
      type: 'command',
      parts: [
        { kind: 'plain', text: 'P=$(' },
        { kind: 'cmd',   text: 'echo' },
        { kind: 'plain', text: ' "$A" | jq -c \'{payee:"Qassim Trading Est",amount:480,currency:"USD",authorization_id,invoice_id}\')' },
      ],
    },
    {
      type: 'command',
      parts: [
        { kind: 'cmd',   text: 'curl' },
        { kind: 'plain', text: ' -s -XPOST ' },
        { kind: 'url',   text: `${base}/v1/sandbox/$S/pay` },
        { kind: 'plain', text: ` ${H} -d "$P"` },
      ],
    },
    { type: 'blank' },
    { type: 'comment', text: '# the signed record of why' },
    {
      type: 'command',
      parts: [
        { kind: 'cmd',   text: 'curl' },
        { kind: 'plain', text: ' -s -XGET ' },
        { kind: 'url',   text: `${base}/v1/sandbox/$S/evidence` },
      ],
    },
  ]
}

/**
 * Render a structured curl line as JSX spans with the same colour classes
 * as the original (c=comment, k=command, u=url).
 */
function CurlLine({ line }: { line: CurlLine }) {
  if (line.type === 'blank') return '\n'
  if (line.type === 'comment') return <span className="c">{line.text}</span>
  return (
    <>
      {line.parts.map((p, i) => {
        if (p.kind === 'plain') return <span key={i}>{p.text}</span>
        if (p.kind === 'cmd')   return <span key={i} className="k">{p.text}</span>
        if (p.kind === 'url')   return <span key={i} className="u">{p.text}</span>
      })}
    </>
  )
}

/**
 * SandboxDemo — the "Try it" section with a live curl example and links
 * to ask ChatGPT, Claude, or Perplexity to run it.
 *
 * The curl block is rendered as React elements (not innerHTML) to avoid
 * any XSS surface. The Copy button has aria-label and clipboard feedback
 * uses a role="status" live region for screen readers.
 */
export default function SandboxDemo() {
  const [base] = useState<string>(() => getBase())
  const [copyLabel, setCopyLabel] = useState('Copy')
  const [announcement, setAnnouncement] = useState('')
  const preRef = useRef<HTMLPreElement>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Use the current origin so sandbox commands follow the deployed environment.
  const prompt = buildAgentPrompt(base)
  const gptUrl = `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`
  const claudeUrl = `https://claude.ai/new?q=${encodeURIComponent(prompt)}`
  const plxUrl = `https://www.perplexity.ai/search?q=${encodeURIComponent(prompt)}`

  const curlLines = buildCurlLines(base)

  /**
   * Clipboard copy with a two-stage fallback: navigator.clipboard → execCommand.
   * On failure the pre element's text is selected so Ctrl+C still works.
   */
  async function handleCopy() {
    const text = preRef.current?.textContent ?? ''
    let ok = false

    try {
      if (navigator.clipboard && isSecureContext) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch { ok = false }

    if (!ok) {
      const ta = document.createElement('textarea')
      try {
        ta.value = text
        ta.style.cssText = 'position:fixed;top:0;opacity:0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
      } catch { ok = false }
      finally { ta.remove() }
    }

    if (!ok && preRef.current) {
      const r = document.createRange()
      r.selectNodeContents(preRef.current)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    }

    const label = ok ? 'Copied' : 'Press ctrl C'
    const message = ok ? 'Curl example copied to clipboard.' : 'Could not copy; text selected — press Ctrl C.'
    setCopyLabel(label)
    setAnnouncement(message)

    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => {
      setCopyLabel('Copy')
      setAnnouncement('')
    }, 1600)
  }

  // Clean up the timer on unmount
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  return (
    <section id="api" className="tight">
      <div className="head">
        <h2>Try it. No key needed.</h2>
      </div>

      <div className="codewrap">
        <div className="codebar">
          {/* Accessible label explains WHAT is being copied */}
          <button
            className="chip"
            id="copy-curl"
            aria-label="Copy curl example to clipboard"
            onClick={handleCopy}
          >
            {copyLabel}
          </button>

          <span className="codebar-sep" />
          <span className="codebar-lbl">Hand it to</span>

          <a className="chip" id="ask-gpt" href={gptUrl} target="_blank" rel="noopener noreferrer">
            ChatGPT
          </a>
          <a className="chip" id="ask-claude" href={claudeUrl} target="_blank" rel="noopener noreferrer">
            Claude
          </a>
          <a className="chip" id="ask-plx" href={plxUrl} target="_blank" rel="noopener noreferrer">
            Perplexity
          </a>
        </div>

        {/* Clipboard action feedback for screen readers */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>

        <pre className="glass" id="curl" ref={preRef}>
          {curlLines.map((line, i) => (
            <span key={i}>
              <CurlLine line={line} />
              {line.type !== 'blank' && '\n'}
            </span>
          ))}
        </pre>
      </div>
    </section>
  )
}
