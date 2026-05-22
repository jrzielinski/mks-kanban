import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface Props {
  defaultOpen?: boolean;
  hasBody?: boolean;
  header: React.ReactNode;
  body?: React.ReactNode;
}

export function CollapsibleToolShell({
  defaultOpen = false,
  hasBody = true,
  header,
  body,
}: Props): React.ReactElement {
  const [open, setOpen] = React.useState(defaultOpen);
  const showBody = open && hasBody && body != null;

  return (
    <div className="my-2 rounded-md border border-border-subtle bg-surface-1/60">
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        disabled={!hasBody}
        className="flex w-full items-center gap-2 border-b border-border-subtle/60 bg-surface-2/40 px-3 py-1.5 text-left transition-colors disabled:cursor-default enabled:hover:bg-surface-2/70"
        aria-expanded={open}
      >
        {hasBody ? (
          open ? (
            <ChevronDown size={12} className="shrink-0 text-dim" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-dim" />
          )
        ) : (
          <span className="w-3" />
        )}
        <div className="min-w-0 flex-1">{header}</div>
      </button>
      {showBody && <div>{body}</div>}
    </div>
  );
}
