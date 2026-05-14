import React from 'react'
import { useTranslation } from 'react-i18next'
import { X, ZoomIn, ZoomOut, Maximize2, RotateCcw } from 'lucide-react'
// panzoom is loaded dynamically to avoid a hard module-not-found crash
// when the package is not installed (the lightbox still works, just without pan/zoom)
import { _initMermaid, _sanitizeMermaid } from './mermaid-utils'

// Sanitização AGRESSIVA: usada quando a primeira tentativa falha. Remove HTML
// inline (<br/>, <small>, etc), substitui por \n, e desindenta linhas em
// excesso. Última cartada antes de cair no fallback de "deu ruim".
function _sanitizeMermaidAggressive(code: string): string {
  return _sanitizeMermaid(
    code
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      // remove indentação >8 espaços (alguns parsers se perdem)
      .split('\n')
      .map((l) => l.replace(/^ {8,}/, '        '))
      .join('\n'),
  )
}

const KanbanMermaidBlock: React.FC<{ code: string }> = ({ code }) => {
  const { t } = useTranslation('common')
  const [svg, setSvg] = React.useState<string | null>(null)
  const [errMsg, setErrMsg] = React.useState<string | null>(null)
  const [lightbox, setLightbox] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    const renderId = `kmermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`
    ;(async () => {
      const tryRender = async (input: string) => {
        const m = (await import('mermaid')).default
        const { svg: rendered } = await m.render(renderId, input)
        return rendered
      }

      try {
        await _initMermaid()
        try {
          const rendered = await tryRender(_sanitizeMermaid(code))
          if (!cancelled) { setSvg(rendered); setErrMsg(null) }
        } catch (e1) {
          // Segunda tentativa: sanitização agressiva.
          try {
            const rendered = await tryRender(_sanitizeMermaidAggressive(code))
            if (!cancelled) { setSvg(rendered); setErrMsg(null) }
          } catch (e2) {
            const msg = (e2 instanceof Error ? e2.message : String(e2))
            console.error('[KanbanMermaid] render error (após 2 tentativas):', e2, '\ncode:', code)
            if (!cancelled) setErrMsg(msg)
          }
        }
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e))
        console.error('[KanbanMermaid] init error:', e)
        if (!cancelled) setErrMsg(msg)
      } finally {
        const leftover = document.getElementById(renderId)
        if (leftover) leftover.remove()
      }
    })()
    return () => { cancelled = true }
  }, [code])

  if (errMsg) return (
    <div className="my-2 rounded-lg border border-red-300 dark:border-red-700/50 bg-red-50 dark:bg-red-900/20 overflow-hidden">
      <div className="px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300 border-b border-red-200 dark:border-red-700/50 bg-red-100/50 dark:bg-red-900/30">
        Mermaid falhou ao renderizar: <span className="font-mono">{errMsg}</span>
      </div>
      <pre className="text-xs text-gray-700 dark:text-gray-300 p-3 overflow-x-auto"><code>{code}</code></pre>
    </div>
  )
  if (!svg) return <div className="my-2 p-3 rounded-lg bg-slate-50 dark:bg-gray-800/50 border border-slate-200 dark:border-gray-700 text-xs text-gray-400 flex items-center gap-2"><span className="animate-spin inline-block w-3 h-3 border-2 border-violet-400 border-t-transparent rounded-full" /> {t('kanbanCardDetailModal.mermaid.rendering')}</div>

  return (
    <>
      <div
        className="my-2 cursor-zoom-in rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 overflow-x-auto"
        onClick={(e) => { e.stopPropagation(); setLightbox(true) }}
        onDoubleClick={(e) => e.stopPropagation()}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {lightbox && <MermaidLightbox svg={svg} onClose={() => setLightbox(false)} />}
    </>
  )
}

// ── Lightbox with pan + zoom (mermaid.live style) ────────────────────────────
const MermaidLightbox: React.FC<{ svg: string; onClose: () => void }> = ({ svg, onClose }) => {
  const stageRef = React.useRef<HTMLDivElement | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pzRef = React.useRef<any>(null)
  // Suppresses the click that fires at the end of a pan-drag — without this,
  // arrastar o SVG dispara um click no backdrop e o modal fecha sozinho.
  const justPannedRef = React.useRef(false)

  // Attach panzoom to the inner SVG once after the lightbox mounts. The SVG
  // is injected via dangerouslySetInnerHTML, so we have to query the DOM
  // after the first paint.
  React.useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const svgEl = stage.querySelector('svg') as SVGSVGElement | null
    if (!svgEl) return

    // Make the SVG fill the stage so panzoom has something proper to scale.
    svgEl.style.width = '100%'
    svgEl.style.height = '100%'
    svgEl.style.maxWidth = 'none'
    svgEl.style.maxHeight = 'none'

    let cancelled = false

    // new Function escapes Vite's static import-analysis so the build
    // succeeds even when panzoom is not installed. The .catch() makes
    // pan/zoom silently unavailable in that case.
    const dynamicImport = new Function('s', 'return import(s)') as
      (s: string) => Promise<any>
    dynamicImport('panzoom').then((mod: any) => {
      if (cancelled || !stageRef.current) return
      const panzoom = mod.default ?? mod
      const pz = panzoom(svgEl, {
        maxZoom: 20,
        minZoom: 0.1,
        bounds: false,
        smoothScroll: false,
        zoomDoubleClickSpeed: 1,
      })

      // Marca "estamos no meio de um pan" — o backdrop usa este flag pra ignorar
      // o click que segue o mouseup do drag.
      pz.on('panstart', () => { justPannedRef.current = true })
      pz.on('panend', () => {
        setTimeout(() => { justPannedRef.current = false }, 0)
      })

      pzRef.current = pz
    }).catch(() => {
      // panzoom not installed — lightbox works without pan/zoom
    })

    return () => {
      cancelled = true
      pzRef.current?.dispose()
      pzRef.current = null
    }
  }, [svg])

  // ESC closes the lightbox; keyboard shortcuts mirror mermaid.live (+/-/0).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (!pzRef.current) return
      if (e.key === '+' || e.key === '=') { stepZoom(1.25); e.preventDefault() }
      else if (e.key === '-' || e.key === '_') { stepZoom(0.8); e.preventDefault() }
      else if (e.key === '0') { resetZoom(); e.preventDefault() }
      else if (e.key.toLowerCase() === 'f') { fitToStage(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stepZoom = (factor: number) => {
    const pz = pzRef.current
    const stage = stageRef.current
    if (!pz || !stage) return
    const rect = stage.getBoundingClientRect()
    pz.smoothZoom(rect.width / 2, rect.height / 2, factor)
  }
  const resetZoom = () => {
    pzRef.current?.zoomAbs(0, 0, 1)
    pzRef.current?.moveTo(0, 0)
  }
  const fitToStage = () => {
    const pz = pzRef.current
    const stage = stageRef.current
    if (!pz || !stage) return
    const svgEl = stage.querySelector('svg') as SVGSVGElement | null
    if (!svgEl) return
    const sRect = stage.getBoundingClientRect()
    const gRect = svgEl.getBBox()
    const scale = Math.min(sRect.width / gRect.width, sRect.height / gRect.height) * 0.9
    pz.zoomAbs(0, 0, scale)
    pz.moveTo(
      (sRect.width - gRect.width * scale) / 2 - gRect.x * scale,
      (sRect.height - gRect.height * scale) / 2 - gRect.y * scale,
    )
  }

  // Click no backdrop fecha o modal, MAS só quando não vier logo após um pan.
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (justPannedRef.current) {
      // veio do mouseup de um drag — engole o click
      justPannedRef.current = false
      return
    }
    onClose()
  }
  // Bloqueia eventos pra não vazar pro card (edição inline, etc) por trás
  // enquanto o lightbox está aberto.
  //
  // IMPORTANTE: só interceptamos click/dblclick — NUNCA mousedown/mouseup.
  // O panzoom registra o listener de `mouseup` no `document`; se um ancestral
  // React chamar stopPropagation no mouseup, o React também para a propagação
  // do evento nativo e o panzoom nunca finaliza o drag (pan "preso").
  const stop = (e: React.SyntheticEvent) => { e.stopPropagation() }

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/85 backdrop-blur-sm flex items-center justify-center"
      onClick={handleBackdropClick}
      onDoubleClick={stop}
    >
      <div
        className="relative w-[95vw] h-[95vh] bg-white dark:bg-gray-900 rounded-lg overflow-hidden shadow-2xl"
        onClick={stop}
        onDoubleClick={stop}
      >
        {/* Stage: panzoom acts on the SVG inside this div. overflow:hidden keeps the SVG inside the rounded corners. */}
        <div
          ref={stageRef}
          className="absolute inset-0 overflow-hidden cursor-grab active:cursor-grabbing"
          onDoubleClick={stop}
          dangerouslySetInnerHTML={{ __html: svg }}
        />

        {/* Toolbar (top-right) — mermaid.live style */}
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-lg bg-black/70 backdrop-blur-sm p-1 shadow-lg">
          <button
            onClick={() => stepZoom(0.8)}
            title="Zoom out (-)"
            className="p-2 rounded text-white hover:bg-white/20 transition-colors"
          >
            <ZoomOut size={16} />
          </button>
          <button
            onClick={resetZoom}
            title="Reset (0)"
            className="p-2 rounded text-white hover:bg-white/20 transition-colors"
          >
            <RotateCcw size={16} />
          </button>
          <button
            onClick={fitToStage}
            title="Fit (F)"
            className="p-2 rounded text-white hover:bg-white/20 transition-colors"
          >
            <Maximize2 size={16} />
          </button>
          <button
            onClick={() => stepZoom(1.25)}
            title="Zoom in (+)"
            className="p-2 rounded text-white hover:bg-white/20 transition-colors"
          >
            <ZoomIn size={16} />
          </button>
          <div className="w-px h-5 bg-white/30 mx-1" />
          <button
            onClick={onClose}
            title="Fechar (Esc)"
            className="p-2 rounded text-white hover:bg-white/20 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Hint */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 text-[11px] text-white/60 bg-black/40 px-2.5 py-1 rounded select-none pointer-events-none">
          Scroll = zoom · Arraste = pan · Atalhos: + − 0 F Esc
        </div>
      </div>
    </div>
  )
}

export default KanbanMermaidBlock
