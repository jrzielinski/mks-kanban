import React, { useState, useEffect } from 'react';
import clsx from 'clsx';
import { invoke } from '../../ipc/client';

type Tab = 'makestudio' | 'kanban';

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

export function StudioTabBar(): React.ReactElement {
  const [active, setActive] = useState<Tab>('makestudio');

  // Avisa o main process que a tab bar está montada (ele usa y=40 para posicionar a BrowserView)
  useEffect(() => {
    invoke('studio:tab-bar-ready', { height: 40 }).catch(() => {});
  }, []);

  const switchTab = (tab: Tab) => {
    if (tab === active) return;
    setActive(tab);
    invoke('studio:switch-tab', { tab }).catch((err) => {
      console.warn('[StudioTabBar] switch-tab failed:', err);
    });
  };

  return (
    <div
      style={{
        height: 40,
        minHeight: 40,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: isMac ? 80 : 12,
        paddingRight: 12,
        gap: 4,
        background: 'var(--color-surface-0, #0C0A08)',
        borderBottom: '1px solid var(--color-border-subtle, rgba(255,255,255,0.06))',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        WebkitAppRegion: 'drag' as any,
        zIndex: 9999,
      }}
    >
      <Tab icon="🤖" label="MakeStudio" active={active === 'makestudio'} onClick={() => switchTab('makestudio')} />
      <Tab icon="📋" label="Kanban" active={active === 'kanban'} onClick={() => switchTab('kanban')} />
    </div>
  );
}

function Tab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        WebkitAppRegion: 'no-drag' as any,
        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
        border: 'none',
        borderRadius: 6,
        color: active ? '#f9fafb' : '#6b7280',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 500,
        transition: 'all 0.15s',
        outline: 'none',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
          (e.currentTarget as HTMLButtonElement).style.color = '#d1d5db';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          (e.currentTarget as HTMLButtonElement).style.color = '#6b7280';
        }
      }}
    >
      <span style={{ fontSize: 13 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
