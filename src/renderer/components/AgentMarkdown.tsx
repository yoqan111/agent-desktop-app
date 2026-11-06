import { type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface AgentMarkdownProps {
  content: string;
  streaming?: boolean;
}

export function AgentMarkdown({ content, streaming = false }: AgentMarkdownProps): ReactElement {
  const text = content || '';
  return (
    <div className={`agent-md${streaming ? ' is-streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          pre: ({ children }) => <pre className="agent-md-pre">{children}</pre>,
          code: ({ className, children, ...props }) => {
            const inline = !className && !String(children).includes('\n');
            if (inline) {
              return <code className="agent-md-inline" {...props}>{children}</code>;
            }
            return <code className={className || 'agent-md-code'} {...props}>{children}</code>;
          },
          table: ({ children }) => (
            <div className="agent-md-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming ? <span className="agent-md-cursor" aria-hidden /> : null}
    </div>
  );
}
