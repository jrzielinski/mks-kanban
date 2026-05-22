/**
 * security-parser.ts — Robust parser for security review markdown output.
 *
 * Parses the format:
 *   # Vuln N: Severity / Description
 *   **Severity:** High
 *   **Category:** SQL Injection
 *   **File:** src/foo.ts:42
 *   ...
 */

import type { SecurityIssueDTO } from './ipc/types';

function extractField(block: string, label: string): string {
  const patterns = [
    new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i'),
    new RegExp(`^${label}:\\s*(.+)`, 'im'),
    new RegExp(`\\*${label}:\\*\\s*(.+)`, 'i'),
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m) return m[1].replace(/\*+/g, '').trim();
  }
  return '';
}

function parseSeverity(val: string): SecurityIssueDTO['severity'] {
  const v = val.toLowerCase();
  if (v.includes('high') || v.includes('critical')) return 'High';
  if (v.includes('medium') || v.includes('moderate')) return 'Medium';
  return 'Low';
}

function parseConfidence(val: string): number {
  const m = val.match(/[\d.]+/);
  if (!m) return 0.8;
  const n = parseFloat(m[0]);
  return n > 1 ? n / 10 : n;
}

function parseFileLine(val: string): { file?: string; line?: number } {
  const m = val.match(/^(.+?)(?::(\d+))?$/);
  if (!m) return {};
  return { file: m[1].trim() || undefined, line: m[2] ? parseInt(m[2], 10) : undefined };
}

export function parseSecurityReviewMarkdown(md: string): SecurityIssueDTO[] {
  const issues: SecurityIssueDTO[] = [];

  // Split by vuln headers: "# Vuln N:" or "## Vuln N:" or "**Vuln N:**"
  const vulnHeaderRe = /^#{1,3}\s*Vuln\s*(\d+)[:\s]/im;
  const parts = md.split(/\n(?=#{1,3}\s*Vuln\s*\d+[:\s])/i);

  for (const part of parts) {
    const headerMatch = part.match(vulnHeaderRe);
    if (!headerMatch) continue;

    const id = parseInt(headerMatch[1], 10);
    const severity = parseSeverity(extractField(part, 'Severity') || extractField(part, 'Sev'));
    const category = extractField(part, 'Category') || extractField(part, 'Type') || 'Unknown';
    const fileVal = extractField(part, 'File') || extractField(part, 'Location');
    const { file, line } = parseFileLine(fileVal);
    const description = extractField(part, 'Description') || extractField(part, 'Issue') || '';
    const exploit = extractField(part, 'Exploit') || extractField(part, 'Attack') || undefined;
    const recommendation = extractField(part, 'Recommendation') || extractField(part, 'Fix') || '';
    const confidenceRaw = extractField(part, 'Confidence');
    const confidence = confidenceRaw ? parseConfidence(confidenceRaw) : 0.8;

    if (!description && !category) continue;

    issues.push({ id, severity, category, file, line, description, exploit, recommendation, confidence });
  }

  return issues;
}
