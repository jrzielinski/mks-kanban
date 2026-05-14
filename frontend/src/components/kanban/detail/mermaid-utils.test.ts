import { describe, it, expect } from 'vitest'
import {
  _MERMAID_KEYWORD_RE,
  _MERMAID_LANG_RE,
  _MERMAID_FENCE_LANG_RE,
  _normalizeMermaidCode,
  _normalizeMarkdown,
  _extractText,
  rehypeMarkInlineCode,
} from './mermaid-utils'

describe('mermaid-utils', () => {
  describe('_MERMAID_KEYWORD_RE', () => {
    it('matches sequenceDiagram', () => {
      expect(_MERMAID_KEYWORD_RE.test('sequenceDiagram')).toBe(true)
    })
    it('matches graph TD', () => {
      expect(_MERMAID_KEYWORD_RE.test('graph TD')).toBe(true)
    })
    it('matches flowchart LR', () => {
      expect(_MERMAID_KEYWORD_RE.test('flowchart LR')).toBe(true)
    })
    it('does not match plain text', () => {
      expect(_MERMAID_KEYWORD_RE.test('Hello world')).toBe(false)
    })
  })

  describe('_MERMAID_LANG_RE / _MERMAID_FENCE_LANG_RE', () => {
    it('matches mermaid lang', () => {
      expect(_MERMAID_LANG_RE.test('mermaid')).toBe(true)
      expect(_MERMAID_FENCE_LANG_RE.test('mermaid')).toBe(true)
    })
    it('matches erDiagram lang', () => {
      expect(_MERMAID_LANG_RE.test('erDiagram')).toBe(true)
    })
    it('matches sequenceDiagram lang', () => {
      expect(_MERMAID_LANG_RE.test('sequenceDiagram')).toBe(true)
    })
    it('does not match javascript', () => {
      expect(_MERMAID_LANG_RE.test('javascript')).toBe(false)
    })
  })

  describe('_normalizeMermaidCode', () => {
    it('trims code with newlines', () => {
      expect(_normalizeMermaidCode('  hello\nworld  ')).toBe('hello\nworld')
    })
    it('inserts newlines before participant/actor keywords', () => {
      const result = _normalizeMermaidCode('Alice->>Bob: hello participant Carol')
      expect(result).toContain('\nparticipant')
    })
    it('handles single-line sequence diagram', () => {
      const result = _normalizeMermaidCode('Alice->>Bob: hello')
      expect(result).toBe('Alice->>Bob: hello')
    })
  })

  describe('_normalizeMarkdown', () => {
    it('removes extra backticks around inline code', () => {
      expect(_normalizeMarkdown('`` `code` ``')).toContain('`code`')
    })
    it('expands table header rows', () => {
      const input = '| a | b |\n| --- | --- |\n| 1 | 2 |'
      const result = _normalizeMarkdown(input)
      expect(result).toContain('| a |')
    })
  })

  describe('_extractText', () => {
    it('returns null/undefined as empty string', () => {
      expect(_extractText(null)).toBe('')
      expect(_extractText(undefined)).toBe('')
    })
    it('returns string as-is', () => {
      expect(_extractText('hello')).toBe('hello')
    })
    it('converts number to string', () => {
      expect(_extractText(42)).toBe('42')
    })
    it('extracts text from React children array', () => {
      expect(_extractText(['a', 'b'])).toBe('ab')
    })
    it('extracts text from React element structure', () => {
      const node = { props: { children: 'hello' } }
      expect(_extractText(node)).toBe('hello')
    })
  })

  describe('rehypeMarkInlineCode', () => {
    it('returns a function', () => {
      const fn = rehypeMarkInlineCode()
      expect(typeof fn).toBe('function')
    })
    it('adds className to code elements not inside pre', () => {
      const fn = rehypeMarkInlineCode()
      const tree: any = {
        tagName: 'p',
        children: [
          { tagName: 'code', properties: { className: [] }, children: [{ value: 'test' }] },
        ],
      }
      fn(tree)
      expect(tree.children[0].properties.className).toContain('__km-inline__')
    })
    it('does not modify code elements inside pre', () => {
      const fn = rehypeMarkInlineCode()
      const tree: any = {
        tagName: 'pre',
        children: [
          { tagName: 'code', properties: { className: [] }, children: [] },
        ],
      }
      fn(tree)
      expect(tree.children[0].properties.className).not.toContain('__km-inline__')
    })
  })
})
