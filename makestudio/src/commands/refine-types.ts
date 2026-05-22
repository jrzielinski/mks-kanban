/**
 * Shared types used across the refine pipeline modules.
 */

export interface AuditBlocker {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium';
  description: string;
  suggestedDum?: {
    title: string;
    description: string;
    type: string;
    area: string;
  };
}

export interface AuditReport {
  score: number;
  verdict: 'SIM' | 'SIM_COM_RESSALVAS' | 'NAO';
  summary: string;
  inventory: string;
  coverage: string;
  integration: string;
  weakDums: Array<{ dumNumber: string; reason: string }>;
  gaps: Array<{ area: string; description: string }>;
  blockers: AuditBlocker[];
  recommendation: string;
}
