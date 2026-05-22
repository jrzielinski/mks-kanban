import React, { useEffect } from 'react';
import { invoke } from '../../ipc/client';

export function StudioTabBar(): React.ReactElement {
  // Avisa o main process que a tab bar está montada (ele usa y=40 para posicionar a BrowserView)
  useEffect(() => {
    invoke('studio:tab-bar-ready', { height: 0 }).catch(() => {});
  }, []);

  // Kanban tab removed — MakeStudio Code runs standalone without the Kanban tab.
  return <></>;
}
