// Markdown and code renderer for chat (FR-UI-02). Raw HTML is never rendered; links open in
// the system browser; remote images are shown as links so nothing loads from the network.
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { platform } from '../../platform';

const SAFE = /^(https?:|mailto:)/i;

const components: Components = {
  a({ href, children }) {
    const ok = href && SAFE.test(href);
    return ok ? (
      <a href={href} rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); platform().openExternal(href); }}>{children}</a>
    ) : <span>{children}</span>;
  },
  img({ src, alt }) {
    const url = typeof src === 'string' ? src : '';
    return SAFE.test(url) ? (
      <a href={url} rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); platform().openExternal(url); }}>{alt || url}</a>
    ) : <span>{alt}</span>;
  },
  pre({ children }) {
    return <pre className="code-block" dir="ltr">{children}</pre>;
  },
  table({ children }) {
    return <div className="table-wrap"><table>{children}</table></div>;
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md" dir="auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
