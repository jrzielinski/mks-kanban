let _mermaidReady = false

async function _initMermaid() {
  if (_mermaidReady) return
  const m = (await import('mermaid')).default
  m.initialize({
    startOnLoad: false,
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
    securityLevel: 'loose',
    fontFamily: 'sans-serif',
  })
  _mermaidReady = true
}

function _sanitizeMermaid(code: string): string {
  // 1) Strip invisible chars que o paste do Chrome/Notion injeta — esses são
  //    o motivo nº1 de "syntax error" sem motivo aparente.
  let out = code
    .replace(/​/g, '')      // zero-width space
    .replace(/‌/g, '')      // zero-width non-joiner
    .replace(/‍/g, '')      // zero-width joiner
    .replace(/﻿/g, '')      // BOM
    .replace(/ /g, ' ')     // NBSP → espaço normal
    .replace(/\r\n?/g, '\n')     // CRLF/CR → LF

  // 2) `subgraph NAME ["label"]` (com espaço) é inválido em mermaid v10+.
  //    Forma certa: `subgraph NAME["label"]` colado, OU `subgraph "label"`.
  //    Convertendo pra forma colada.
  out = out.replace(/^(\s*subgraph\s+\S+)\s+(\[)/gm, '$1$2')

  // 3) `<br/>` em alguns parsers quebra; `<br>` é universalmente aceito.
  out = out.replace(/<br\s*\/>/gi, '<br>')

  // 4) Quote de labels não-ASCII e escape de parens SOLTOS.
  //    IMPORTANTE: NÃO escapa parens se o conteúdo está em aspas (já é
  //    label quoted) ou se faz parte da sintaxe composta `[(...)]` (cilindro),
  //    `(["..."])` (stadium), etc. Antes o escape genérico estava
  //    destruindo `Node[("texto")]` -> `Node[#40;"texto"#41;]`, o que
  //    quebrava o parser ("got STR").
  out = out.replace(/\[([^\]]*)\]/g, (_m, c) => {
    let fixed = c
    const trimmed = c.trim()
    const isQuoted = /^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)
    const isCompound = /^\(.*\)$/.test(trimmed) || /^\/.*\/$/.test(trimmed) || /^\\.*\\$/.test(trimmed)
    if (!isQuoted && !isCompound) {
      fixed = c.replace(/\(/g, '#40;').replace(/\)/g, '#41;')
    }
    if (/[^\x00-\x7E]/.test(fixed) && !isQuoted && !isCompound) {
      fixed = `"${fixed.replace(/"/g, "'")}"`
    }
    return `[${fixed}]`
  })

  // 5) Decision diamonds `{"..."}` com vírgula/HTML às vezes quebram parsers
  //    antigos. Mermaid v10 aceita, mas quando NÃO está quoted, vírgula
  //    estoura. Garante quoting se houver conteúdo "feio".
  out = out.replace(/\{([^{}]*)\}/g, (full, c) => {
    const trimmed = c.trim()
    // Já está quoted? deixa.
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return full
    // Sem nada suspeito? deixa.
    if (!/[,<>]/.test(trimmed)) return full
    return `{"${trimmed.replace(/"/g, "'")}"}`
  })

  return out
}

const _MERMAID_KEYWORD_RE = /^(sequenceDiagram|graph\s+(?:TD|TB|BT|RL|LR|t|b|l|r)\b|flowchart\s+(?:TD|TB|BT|RL|LR|t|b|l|r)\b|gantt\b|pie\b|classDiagram\b|stateDiagram(?:-v2)?\b|erDiagram\b|journey\b|gitGraph\b|mindmap\b|timeline\b|xychart-beta\b|quadrantChart\b|requirementDiagram\b)/i

function _normalizeMermaidCode(code: string): string {
  if (code.includes('\n')) return code.trim()
  return code
    .replace(/\s+(participant\s|actor\s|loop\s|alt\s|else\s|opt\s|par\s|and\s|critical\s|break\s|rect\s|Note\s|autonumber\b)/gi, '\n$1')
    .replace(/\s+(?=\w[\w\s]*(?:->>|-->>|-x|--x|-\)|--\)|->|-->))/g, '\n')
    .replace(/\s+(end\b)/gi, '\n$1')
    .trim()
}

const _MERMAID_LANG_RE = /^(mermaid|erDiagram|erdiagram|sequenceDiagram|graph|flowchart|gantt|pie|classDiagram|stateDiagram(?:-v2)?|journey|gitGraph|gitgraph|mindmap|timeline|xychart-beta|quadrantChart|requirementDiagram)$/i

function _extractMermaid(md: string): { processed: string; blocks: string[] } {
  const blocks: string[] = []
  let processed = md.replace(/(`{3,})([\w-]*)[^\n]*\n([\s\S]*?)\1/g, (fullMatch, _fence, lang, code) => {
    const trimmed = code.trim()
    const isMermaidLang = _MERMAID_LANG_RE.test(lang.trim())
    const isMermaidContent = _MERMAID_KEYWORD_RE.test(trimmed)
    if (!isMermaidLang && !isMermaidContent) return fullMatch
    const idx = blocks.length
    blocks.push(_normalizeMermaidCode(trimmed))
    return `\n<!--kmermaid:${idx}-->\n`
  })

  // Stripa CRs antes do split — pastes do Windows/Notion costumam vir
  // com \r\n e o \r solto cabava o \b da regex de keyword.
  const lines = processed.replace(/\r/g, '').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (_MERMAID_KEYWORD_RE.test(lines[i].trimStart())) {
      const codeLines: string[] = [lines[i]]
      i++
      // Acumula até bater num delimitador CLARAMENTE markdown:
      // heading, fence, listas com `-` no início, blockquote `>`,
      // ou duas linhas vazias seguidas. Linhas vazias soltas dentro
      // de subgraphs (estilo do user) NÃO fecham o bloco — antes
      // fechavam e a maior parte do diagrama virava texto solto.
      let blankCount = 0
      while (i < lines.length) {
        const raw = lines[i]
        const trimmed = raw.trim()
        if (trimmed === '') {
          blankCount++
          if (blankCount >= 2) break
          codeLines.push(raw)
          i++
          continue
        }
        blankCount = 0
        if (/^(#{1,6}\s|`{3,}|>\s|[*-]\s|\d+\.\s)/.test(trimmed)) break
        codeLines.push(raw)
        i++
      }
      const idx = blocks.length
      blocks.push(_normalizeMermaidCode(codeLines.join('\n').trim()))
      out.push('', `<!--kmermaid:${idx}-->`, '')
    } else {
      out.push(lines[i])
      i++
    }
  }
  processed = out.join('\n')

  return { processed, blocks }
}

function _normalizeMarkdown(md: string): string {
  md = md.replace(/``\s*`([^`\n]+)`\s*``/g, '`$1`')
  md = md.replace(/``([^`\n]+)``/g, '`$1`')
  const lines = md.split('\n').flatMap(line => {
    const t = line.trim()
    if (t.startsWith('|') && /\|[\s]*:?-+:?[\s]*\|/.test(t)) {
      const expanded = t.replace(/\|\s+(?=\|)/g, '|\n')
      const rows = expanded.split('\n')
      if (rows.length > 1) return rows
    }
    return [line]
  })
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const curr = lines[i].trim()
    const next = (lines[i + 1] ?? '').trim()
    const prev = (lines[i - 1] ?? '').trim()
    if (
      curr.startsWith('|') && curr.endsWith('|') &&
      next.startsWith('|') && next.endsWith('|') &&
      !next.match(/^\|[\s\-:|]+\|$/) &&
      !prev.startsWith('|')
    ) {
      const colCount = curr.split('|').length - 2
      out.push('|' + Array(colCount).fill(' --- ').join('|') + '|')
    }
  }
  return out.join('\n')
}

const _MONO = "'JetBrains Mono','Fira Code','Cascadia Code',Menlo,Monaco,Consolas,monospace"

function _extractText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(_extractText).join('');
  if (typeof node === 'object' && node.props != null) return _extractText(node.props.children);
  return '';
}

const _MERMAID_FENCE_LANG_RE = /^(mermaid|erDiagram|erdiagram|sequenceDiagram|graph|flowchart|gantt|pie|classDiagram|stateDiagram(?:-v2)?|journey|gitGraph|gitgraph|mindmap|timeline|xychart-beta|quadrantChart|requirementDiagram)$/i

function rehypeMarkInlineCode() {
  return (tree: any) => {
    function walk(node: any, parent: any) {
      if (node.tagName === 'code' && parent?.tagName !== 'pre') {
        node.properties = node.properties || {};
        const existing: string[] = node.properties.className || [];
        if (!existing.includes('__km-inline__')) {
          node.properties.className = [...existing, '__km-inline__'];
        }
      }
      (node.children || []).forEach((child: any) => walk(child, node));
    }
    walk(tree, null);
  };
}

export {
  _mermaidReady,
  _initMermaid,
  _sanitizeMermaid,
  _MERMAID_KEYWORD_RE,
  _MERMAID_LANG_RE,
  _MERMAID_FENCE_LANG_RE,
  _normalizeMermaidCode,
  _extractMermaid,
  _normalizeMarkdown,
  _extractText,
  rehypeMarkInlineCode,
  _MONO,
}
// MAGIC_MARKER_AAA_XYZ_999
