import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function CopilotMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      table: ({ children }) => <div className="reply-table"><table>{children}</table></div>,
      img: ({ alt }) => <span>{alt}</span>,
    }}>{text}</Markdown>
  )
}
