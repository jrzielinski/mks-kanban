import React from 'react';
import { Copy, Check } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

export function CodeBlock({ children }: Props): React.ReactElement {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [copied, setCopied] = React.useState(false);
  const language = extractLanguage(children);

  const handleCopy = React.useCallback(async () => {
    const node = wrapperRef.current;
    if (!node) return;
    const codeEl = node.querySelector('code');
    const text = (codeEl?.textContent ?? node.innerText ?? '').replace(/\n$/, '');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard pode falhar em contexto não-seguro; ignora silenciosamente
    }
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="group relative my-3 overflow-hidden rounded-md border border-border-subtle bg-code-bg"
    >
      <div className="flex items-center justify-between border-b border-border-subtle/60 bg-surface-2/40 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-dim">
        <span>{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-dim-soft transition-colors hover:bg-surface-3/60 hover:text-text"
          aria-label={copied ? 'Copiado' : 'Copiar código'}
        >
          {copied ? (
            <>
              <Check size={12} strokeWidth={2.5} className="text-success" />
              <span className="text-success">Copiado</span>
            </>
          ) : (
            <>
              <Copy size={12} strokeWidth={2} />
              <span>Copiar</span>
            </>
          )}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto bg-transparent p-3 text-[13px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

function extractLanguage(children: React.ReactNode): string {
  // react-markdown entrega <code class="language-X"> como filho do <pre>
  let lang = '';
  React.Children.forEach(children, (child) => {
    if (lang) return;
    if (!React.isValidElement<{ className?: string }>(child)) return;
    const cls = child.props.className ?? '';
    const m = /language-([\w+-]+)/i.exec(cls);
    if (m) lang = m[1];
  });
  return lang;
}
