import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { CodeBlock } from './CodeBlock';
import { invoke } from '../../ipc/client';
import * as CH from '@shared/channels';

// Detects `path/to/file.ext` (with optional `:line` or `:line:col` suffix).
// Anchors at the start so we only fire on inline code that IS A PATH —
// regular `someVar.method` doesn't match because it lacks an extension at
// the very end.
//
// Accepted shapes:
//   src/foo/bar.ts
//   ./relative/file.tsx
//   /abs/path/to/file.java:42
//   ~/home/file.py:45:10
//   agent/desktop/main.ts:1234
const FILE_PATH_RE =
  /^(?:[~.]?\/|[a-zA-Z]:[\\/])?(?:[\w.\-@]+[\\/])+[\w.\-@]+\.[a-zA-Z0-9]{1,8}(?::(\d+)(?::(\d+))?)?$/;

function tryParsePath(
  text: string,
): { path: string; line?: number; column?: number } | null {
  const trimmed = text.trim();
  const m = FILE_PATH_RE.exec(trimmed);
  if (!m) return null;
  const colonIdx = trimmed.lastIndexOf(':');
  let pathOnly = trimmed;
  let line: number | undefined;
  let column: number | undefined;
  if (m[1]) {
    line = Number(m[1]);
    if (m[2]) column = Number(m[2]);
    // Strip the `:line` (and optional `:col`) suffix from the path.
    const sepCount = m[2] ? 2 : 1;
    let cuts = 0;
    for (let i = trimmed.length - 1; i >= 0 && cuts < sepCount; i--) {
      if (trimmed[i] === ':') cuts++;
      if (cuts === sepCount) {
        pathOnly = trimmed.slice(0, i);
        break;
      }
    }
    void colonIdx;
  }
  return { path: pathOnly, line, column };
}

async function openInIde(spec: { path: string; line?: number; column?: number }): Promise<void> {
  try {
    await invoke(CH.IDE_OPEN_FILE, spec);
  } catch (err) {
    // Silent on Electron / contexts without an IDE handler — clicking
    // shouldn't blow up if the host doesn't know how to open files.
    // eslint-disable-next-line no-console
    console.warn('[markdown] ide:openFile failed', err);
  }
}

interface Props {
  text: string;
  className?: string;
}

// Plugins / components are STABLE references at module scope — passing them
// as inline props creates a new array/object on every parent re-render and
// disables ReactMarkdown's internal memoisation, forcing a full re-parse on
// every streaming chunk. With 30 updates/s and remarkGfm + rehypeHighlight
// running per chunk, that was the dominant slowness vs the CLI.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];
const MD_COMPONENTS = {
  h1: ({ children }: any) => (
    <h1 className="mb-3 mt-4 text-[22px] font-semibold tracking-tight text-text">
      {children}
    </h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="mb-2 mt-4 text-[18px] font-semibold tracking-tight text-text">
      {children}
    </h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="mb-2 mt-3 text-[15px] font-semibold text-text">
      {children}
    </h3>
  ),
  h4: ({ children }: any) => (
    <h4 className="mb-1.5 mt-3 text-[14px] font-semibold text-text">
      {children}
    </h4>
  ),
  p: ({ children }: any) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }: any) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-dim">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-dim">{children}</ol>
  ),
  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }: any) => (
    <blockquote className="my-3 border-l-2 border-primary/60 bg-surface-2/40 py-1 pl-3 italic text-dim-soft">
      {children}
    </blockquote>
  ),
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline-offset-2 hover:underline"
    >
      {children}
    </a>
  ),
  code: ({ className: cls, children }: any) => {
    const isInline = !/language-/.test(cls || '');
    if (isInline) {
      const text = React.Children.toArray(children)
        .map((c) => (typeof c === 'string' ? c : ''))
        .join('');
      const spec = tryParsePath(text);
      if (spec) {
        return (
          <button
            type="button"
            onClick={() => void openInIde(spec)}
            className="cursor-pointer rounded bg-code-bg px-1.5 py-0.5 font-mono text-[12.5px] text-primary underline-offset-2 hover:underline"
            title={
              spec.line
                ? `Abrir ${spec.path}:${spec.line}${spec.column ? `:${spec.column}` : ''} no editor`
                : `Abrir ${spec.path} no editor`
            }
          >
            {children}
          </button>
        );
      }
      return (
        <code className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-[12.5px] text-code-fg">
          {children}
        </code>
      );
    }
    return (
      <code className={`font-mono text-[13px] ${cls ?? ''}`}>{children}</code>
    );
  },
  pre: ({ children }: any) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }: any) => (
    <div className="my-3 overflow-x-auto rounded-md border border-border-subtle">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }: any) => (
    <th className="border-b border-border-subtle bg-surface-2/60 px-3 py-2 text-left font-semibold text-text">
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td className="border-b border-border-subtle/50 px-3 py-2 text-text-soft">
      {children}
    </td>
  ),
  hr: () => <hr className="my-4 border-border-subtle" />,
  strong: ({ children }: any) => (
    <strong className="font-semibold text-text">{children}</strong>
  ),
  em: ({ children }: any) => <em className="italic">{children}</em>,
};

/**
 * Markdown renderer pro chat. Usa react-markdown com GFM (tabelas,
 * strikethrough, task lists, autolinks) e rehype-highlight pra
 * syntax highlighting com o tema github-dark.
 *
 * Memoizado: só re-renderiza quando o text muda.
 */
export const Markdown = React.memo(function Markdown({
  text,
  className,
}: Props): React.ReactElement {
  // Trim de quebras supérfluas no fim — evita espaço morto após blocos.
  const trimmed = React.useMemo(() => (text ?? '').replace(/\s+$/, ''), [text]);

  return (
    <div className={`md-body text-[14px] leading-[1.65] text-text-soft ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MD_COMPONENTS}
      >
        {trimmed}
      </ReactMarkdown>
    </div>
  );
});
