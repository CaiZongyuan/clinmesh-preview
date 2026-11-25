import type { ReactNode } from 'react'

// The small markdown the Copilot replies use: headings, bullet and numbered lists, blockquotes, and
// inline bold, italics and code. Everything else renders as plain paragraphs — never raw HTML.
function inline(text: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyBase}-${i++}`
    if (token.startsWith('**')) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) parts.push(<code key={key}>{token.slice(1, -1)}</code>)
    else parts.push(<em key={key}>{token.slice(1, -1)}</em>)
    last = match.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function markdown(text: string): ReactNode {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((item, i) => <li key={i}>{inline(item, `li-${blocks.length}-${i}`)}</li>)
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>)
    list = null
  }
  lines.forEach((line, i) => {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.、]\s+(.*)$/)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      if (!list || list.ordered !== ordered) {
        flush()
        list = { ordered, items: [] }
      }
      list.items.push((bullet ?? numbered)![1])
      return
    }
    flush()
    if (line.trim() === '') return
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      blocks.push(
        <p key={i} className="copilot-heading" role="heading" aria-level={heading[1].length + 1}>
          {inline(heading[2], `h-${i}`)}
        </p>,
      )
      return
    }
    if (line.startsWith('> ')) {
      blocks.push(<blockquote key={i}>{inline(line.slice(2), `q-${i}`)}</blockquote>)
      return
    }
    blocks.push(<p key={i}>{inline(line, `p-${i}`)}</p>)
  })
  flush()
  return blocks
}
