import React from 'react';
import ReactDiffViewer from 'react-diff-viewer-continued';

interface Props {
  oldValue: string;
  newValue: string;
  splitView?: boolean;
}

/**
 * Wrapper centralizado pro react-diff-viewer-continued. Mantém visual
 * coerente com o tema escuro da app (overrides via styles prop) e
 * padroniza colapso de linhas inalteradas.
 */
export const DiffView = React.memo(function DiffView({
  oldValue,
  newValue,
  splitView = false,
}: Props): React.ReactElement {
  return (
    <div className="diff-view text-[12.5px]">
      {/*
        react-diff-viewer-continued hardcodes `pre { line-height: 25px }`
        on its outermost `<table>` (label `diff-container`) — at our 12px
        font that's ~2× line-height and every row feels double-spaced.
        We can't target `.diff-container` directly because emotion mangles
        the label in prod builds, so we hit `<pre>` and `<td>` (the cells
        that wrap the markers/numbers) inside the `.diff-view` wrapper.
        `tr` gets a tight height too — the previous override only fixed
        `pre`, but the table row itself still grew with the gutter cells.
      */}
      <style>{`
        .diff-view pre { line-height: 1.35 !important; padding: 0 !important; }
        .diff-view td { line-height: 1.35 !important; padding-top: 0 !important; padding-bottom: 0 !important; vertical-align: middle !important; }
        .diff-view tr { line-height: 1.35 !important; height: auto !important; }
      `}</style>
      <ReactDiffViewer
        oldValue={oldValue}
        newValue={newValue}
        splitView={splitView}
        useDarkTheme
        hideLineNumbers={false}
        showDiffOnly
        extraLinesSurroundingDiff={2}
        styles={{
          variables: {
            dark: {
              diffViewerBackground: 'var(--color-surface-1)',
              diffViewerColor: 'var(--color-text-soft)',
              addedBackground: 'rgba(127, 176, 105, 0.12)',
              addedColor: 'var(--color-text)',
              removedBackground: 'rgba(224, 107, 107, 0.12)',
              removedColor: 'var(--color-text)',
              wordAddedBackground: 'rgba(127, 176, 105, 0.34)',
              wordRemovedBackground: 'rgba(224, 107, 107, 0.34)',
              addedGutterBackground: 'rgba(127, 176, 105, 0.18)',
              removedGutterBackground: 'rgba(224, 107, 107, 0.18)',
              gutterBackground: 'var(--color-surface-1)',
              gutterBackgroundDark: 'var(--color-surface-2)',
              highlightBackground: 'rgba(232, 93, 39, 0.08)',
              highlightGutterBackground: 'rgba(232, 93, 39, 0.16)',
              codeFoldGutterBackground: 'var(--color-surface-2)',
              codeFoldBackground: 'var(--color-surface-2)',
              emptyLineBackground: 'transparent',
              gutterColor: 'var(--color-dim)',
              addedGutterColor: 'var(--color-success)',
              removedGutterColor: 'var(--color-danger)',
              codeFoldContentColor: 'var(--color-dim)',
              diffViewerTitleBackground: 'var(--color-surface-2)',
              diffViewerTitleColor: 'var(--color-text-soft)',
              diffViewerTitleBorderColor: 'var(--color-border-subtle)',
            },
          },
          contentText: {
            fontFamily:
              'JetBrains Mono, SF Mono, Menlo, Consolas, monospace',
            fontSize: '12px',
            lineHeight: '1.55',
          },
          gutter: {
            fontFamily:
              'JetBrains Mono, SF Mono, Menlo, Consolas, monospace',
            fontSize: '11px',
          },
        }}
      />
    </div>
  );
});
