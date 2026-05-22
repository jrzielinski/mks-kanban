import React from 'react';
import { ComingSoon } from '../../components/common/ComingSoon';

export function SecuritySettingsPage(): React.ReactElement {
  return (
    <ComingSoon
      title="Segurança"
      phase={9}
      description="Trust mode, working dirs adicionais e controles de auto-approve."
      features={[
        'Trust mode toggle (autoApprove globalmente)',
        'Working dirs extras (chip list com add/remove)',
        'Env vars sensíveis ocultadas',
        'Audit log de decisões de permissão',
      ]}
    />
  );
}
