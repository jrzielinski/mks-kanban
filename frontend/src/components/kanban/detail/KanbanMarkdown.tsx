import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import KanbanMermaidBlock from './KanbanMermaidBlock'
import {
  _normalizeMarkdown,
  _extractMermaid,
  _extractText,
  _MERMAID_FENCE_LANG_RE,
  _MERMAID_KEYWORD_RE,
  _normalizeMermaidCode,
  rehypeMarkInlineCode,
  _MONO,
} from './mermaid-utils'

const _mdComponents: Record<string, React.ComponentType<any>> = {
  img: ({ src, alt }: any) => (
    <img src={src || ''} alt={alt || ''} className="mt-3 max-h-[320px] w-auto max-w-full rounded-xl border border-slate-200 object-contain shadow-sm" />
  ),
  pre: ({ children, ...props }: any) => {
    const codeEl = React.Children.toArray(children).find(
      (c): c is React.ReactElement<any> => React.isValidElement(c)
    )
    if (codeEl) {
      const rawCls: unknown = codeEl.props.className
      const cls = Array.isArray(rawCls) ? rawCls.join(' ') : (typeof rawCls === 'string' ? rawCls : '')
      const langMatch = cls.match(/language-([\w-]+)/i)
      const lang = langMatch?.[1] ?? ''
      const isMermaidLang = _MERMAID_FENCE_LANG_RE.test(lang)
      const rawText = _extractText(codeEl.props.children).trim()
      // Detecção mais permissiva: o keyword pode estar em qualquer uma
      // das ~10 primeiras linhas e a presença de uma `language-xxx` não
      // mermaid (text/plain/etc) não invalida. Antes o `!lang` exigia
      // fence sem lang E a primeira linha começar com keyword — falhava
      // em pastes indented ou com fences ` ```text`.
      const firstLines = rawText.split('\n').slice(0, 10)
      const isMermaidContent = firstLines.some((l) => _MERMAID_KEYWORD_RE.test(l.trimStart()))
      if (isMermaidLang || isMermaidContent) {
        // Se houver prefixo antes do keyword (linhas vazias / lixo),
        // recorta a partir da primeira linha que casar.
        const lines = rawText.split('\n')
        const startIdx = lines.findIndex((l) => _MERMAID_KEYWORD_RE.test(l.trimStart()))
        const mermaidBody = lines.slice(Math.max(0, startIdx)).join('\n')
        return <KanbanMermaidBlock code={_normalizeMermaidCode(mermaidBody)} />
      }
    }
    return (
      <pre
        className="rounded-xl overflow-x-auto my-3 bg-gray-50 dark:bg-[#0d1117] p-4 border border-gray-200 dark:border-gray-700/50 text-sm leading-relaxed text-gray-800 dark:text-gray-200"
        style={{ fontFamily: _MONO }}
        {...props}
      >{children}</pre>
    )
  },
  code: ({ className, children, ...props }: any) => {
    const classes: string[] = Array.isArray(className) ? className : (className || '').split(' ').filter(Boolean)
    const isInline = classes.includes('__km-inline__')
    const hasLanguage = classes.some(c => /^language-/.test(c))
    if (isInline && !hasLanguage) {
      const text = typeof children === 'string' && children.startsWith('`') && children.endsWith('`') && children.length > 2
        ? children.slice(1, -1)
        : children
      return (
        <code
          className="mx-0.5 rounded-md border border-[#d8dee6] bg-[#f0f2f5] px-[5px] py-[2px] text-[0.83em] font-medium text-[#c7254e] dark:border-[#3b4754] dark:bg-[#2c333a] dark:text-[#e06c75]"
          style={{ fontFamily: _MONO }}
        >
          {text}
        </code>
      )
    }
    const blockClass = classes.filter(c => c !== '__km-inline__').join(' ')
    return <code className={`${blockClass} hljs`.trim()} style={{ fontFamily: _MONO }} {...props}>{children}</code>
  },
  table: ({ children }: any) => (
    <div className="overflow-x-auto my-3 rounded-lg border border-gray-200 dark:border-gray-700/50">
      <table className="w-full text-sm text-left border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => (
    <thead className="bg-gray-100 dark:bg-gray-800/80 text-gray-700 dark:text-gray-300 uppercase text-xs tracking-wider">{children}</thead>
  ),
  tbody: ({ children }: any) => (
    <tbody className="divide-y divide-gray-200 dark:divide-gray-700/50">{children}</tbody>
  ),
  tr: ({ children }: any) => (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">{children}</tr>
  ),
  th: ({ children, ...props }: any) => (
    <th className="px-3 py-2.5 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600/50 whitespace-nowrap" {...props}>{children}</th>
  ),
  td: ({ children, ...props }: any) => (
    <td className="px-3 py-2 text-gray-600 dark:text-gray-400" {...props}>{children}</td>
  ),
}

const KanbanMarkdown: React.FC<{ content: string }> = ({ content }) => {
  const { processed, blocks, normalized } = React.useMemo(() => {
    const norm = _normalizeMarkdown(content)
    const result = _extractMermaid(norm)
    return { ...result, normalized: norm }
  }, [content])

  const _rehype: any = [[rehypeHighlight, { detect: true }], rehypeMarkInlineCode]

  if (blocks.length === 0) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={_rehype} urlTransform={u => u} components={_mdComponents}>
        {normalized}
      </ReactMarkdown>
    )
  }

  const parts = processed.split(/<!--kmermaid:(\d+)-->/)
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) return <KanbanMermaidBlock key={i} code={blocks[parseInt(part, 10)]} />
        if (!part.trim()) return null
        return (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={_rehype} urlTransform={u => u} components={_mdComponents}>
            {part}
          </ReactMarkdown>
        )
      })}
    </>
  )
}

export default KanbanMarkdown
