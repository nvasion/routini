// A small markdown renderer for postmortems: headings, bullet and task lists,
// paragraphs, **bold**, _italic_ and `code`. Builds React elements only (no
// HTML injection), so incident text from alerts cannot inject markup.

import type { ReactNode } from 'react'

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${key}-${i++}`
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>)
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let list: ReactNode[] = []
  let para: string[] = []
  const flushList = () => {
    if (list.length) blocks.push(<ul key={`ul${blocks.length}`}>{list}</ul>)
    list = []
  }
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '), `p${blocks.length}`)}</p>)
    para = []
  }
  for (const [n, raw] of text.split('\n').entries()) {
    const line = raw.trimEnd()
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    const li = /^\s*[-*]\s+(?:\[( |x)\]\s+)?(.*)$/.exec(line)
    if (h) {
      flushList()
      flushPara()
      const content = inline(h[2]!, `h${n}`)
      blocks.push(h[1]!.length === 1 ? <h1 key={n}>{content}</h1> : h[1]!.length === 2 ? <h2 key={n}>{content}</h2> : <h3 key={n}>{content}</h3>)
    } else if (li) {
      flushPara()
      list.push(
        <li key={n}>
          {li[1] !== undefined && <input type="checkbox" checked={li[1] === 'x'} readOnly aria-label={li[1] === 'x' ? 'done' : 'not done'} style={{ marginRight: 6 }} />}
          {inline(li[2]!, `li${n}`)}
        </li>,
      )
    } else if (!line.trim()) {
      flushList()
      flushPara()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushList()
  flushPara()
  return <div className="md">{blocks}</div>
}
