import { swallow } from '../utils/log';
/**
 * security-review.ts
 *
 * `makestudio security-review` — focused security review of pending changes.
 * Runs git status/diff/log, injects output into a security-engineer prompt,
 * then feeds it to the configured CLI. Report goes to .makestudio/security-reviews/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { detectInstalledCLIs } from '../core/cli-detector';
import { runLocalCLI } from './execute';
import chalk from 'chalk';

const dim = chalk.hex('#64748B');
const cyan = chalk.hex('#22D3EE');
const green = chalk.hex('#22C55E');
const red = chalk.hex('#EF4444');
const yellow = chalk.hex('#FBBF24');
const bold = chalk.bold;

export interface SecurityReviewOptions {
  cli?: string;
  cwd?: string;
  base?: string;        // ref to compare against (default: origin/HEAD)
  outputFile?: string;  // explicit path for the report (default: .makestudio/security-reviews/<timestamp>.md)
}

function gitSafe(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, timeout: 15_000, maxBuffer: 10 * 1024 * 1024 })
      .toString();
  } catch {
    return '';
  }
}

function resolveBaseRef(cwd: string, explicit?: string): string {
  if (explicit) return explicit;
  // Prefer origin/HEAD; fall back to origin/main, origin/master, then HEAD~10.
  const candidates = ['origin/HEAD', 'origin/main', 'origin/master'];
  for (const ref of candidates) {
    try {
      execSync(`git rev-parse --verify ${ref}`, { cwd, timeout: 5_000, stdio: 'pipe' });
      return ref;
    } catch (err) { swallow(err); }
  }
  return 'HEAD~10';
}

/**
 * Build the security review prompt. Git status/diff/log are run here and
 * injected inline so the CLI doesn't need to spawn subprocesses.
 */
export function buildSecurityReviewPrompt(
  cwd: string,
  base: string,
  outputFile: string,
): string {
  const gitStatus = gitSafe('git status', cwd);
  let filesModified = gitSafe(`git diff --name-only ${base}...`, cwd);
  let commits = gitSafe(`git log --no-decorate ${base}...`, cwd);
  let diff = gitSafe(`git diff ${base}...`, cwd);

  // Fallback: if 3-dot range produced nothing (no common ancestor), try 2-dot.
  if (!diff.trim()) {
    filesModified = gitSafe(`git diff --name-only ${base}`, cwd);
    commits = gitSafe(`git log --no-decorate ${base}..HEAD`, cwd);
    diff = gitSafe(`git diff ${base}`, cwd);
  }

  // Cap diff so CLI context doesn't blow up
  if (diff.length > 120_000) {
    diff = diff.slice(0, 120_000) + '\n\n[... truncated, diff too large ...]';
  }

  const outRel = path.relative(cwd, outputFile).replace(/\\/g, '/');

  return `You are a senior security engineer conducting a focused security review of the changes on this branch.

GIT STATUS:

\`\`\`
${gitStatus}
\`\`\`

FILES MODIFIED:

\`\`\`
${filesModified}
\`\`\`

COMMITS:

\`\`\`
${commits}
\`\`\`

DIFF CONTENT:

\`\`\`diff
${diff}
\`\`\`

Review the complete diff above. This contains all code changes in the PR.


OBJECTIVE:
Perform a security-focused code review to identify HIGH-CONFIDENCE security vulnerabilities that could have real exploitation potential. This is not a general code review - focus ONLY on security implications newly added by this PR. Do not comment on existing security concerns.

CRITICAL INSTRUCTIONS:
1. MINIMIZE FALSE POSITIVES: Only flag issues where you're >80% confident of actual exploitability
2. AVOID NOISE: Skip theoretical issues, style concerns, or low-impact findings
3. FOCUS ON IMPACT: Prioritize vulnerabilities that could lead to unauthorized access, data breaches, or system compromise
4. EXCLUSIONS: Do NOT report the following issue types:
   - Denial of Service (DOS) vulnerabilities, even if they allow service disruption
   - Secrets or sensitive data stored on disk (these are handled by other processes)
   - Rate limiting or resource exhaustion issues

SECURITY CATEGORIES TO EXAMINE:

**Input Validation Vulnerabilities:**
- SQL injection via unsanitized user input
- Command injection in system calls or subprocesses
- XXE injection in XML parsing
- Template injection in templating engines
- NoSQL injection in database queries
- Path traversal in file operations

**Authentication & Authorization Issues:**
- Authentication bypass logic
- Privilege escalation paths
- Session management flaws
- JWT token vulnerabilities
- Authorization logic bypasses

**Crypto & Secrets Management:**
- Hardcoded API keys, passwords, or tokens
- Weak cryptographic algorithms or implementations
- Improper key storage or management
- Cryptographic randomness issues
- Certificate validation bypasses

**Injection & Code Execution:**
- Remote code execution via deserialization
- Pickle injection in Python
- YAML deserialization vulnerabilities
- Eval injection in dynamic code execution
- XSS vulnerabilities in web applications (reflected, stored, DOM-based)

**Data Exposure:**
- Sensitive data logging or storage
- PII handling violations
- API endpoint data leakage
- Debug information exposure

Additional notes:
- Even if something is only exploitable from the local network, it can still be a HIGH severity issue

ANALYSIS METHODOLOGY:

Phase 1 - Repository Context Research (Use file search tools):
- Identify existing security frameworks and libraries in use
- Look for established secure coding patterns in the codebase
- Examine existing sanitization and validation patterns
- Understand the project's security model and threat model

Phase 2 - Comparative Analysis:
- Compare new code changes against existing security patterns
- Identify deviations from established secure practices
- Look for inconsistent security implementations
- Flag code that introduces new attack surfaces

Phase 3 - Vulnerability Assessment:
- Examine each modified file for security implications
- Trace data flow from user inputs to sensitive operations
- Look for privilege boundaries being crossed unsafely
- Identify injection points and unsafe deserialization

REQUIRED OUTPUT FORMAT:

Write your final markdown report to: \`${outRel}\`

The markdown output should contain the file, line number, severity, category (e.g. \`sql_injection\` or \`xss\`), description, exploit scenario, and fix recommendation.

For example:

# Vuln 1: XSS: \`foo.py:42\`

* Severity: High
* Description: User input from \`username\` parameter is directly interpolated into HTML without escaping, allowing reflected XSS attacks
* Exploit Scenario: Attacker crafts URL like /bar?q=<script>alert(document.cookie)</script> to execute JavaScript in victim's browser, enabling session hijacking or data theft
* Recommendation: Use Flask's escape() function or Jinja2 templates with auto-escaping enabled for all user inputs rendered in HTML

SEVERITY GUIDELINES:
- **HIGH**: Directly exploitable vulnerabilities leading to RCE, data breach, or authentication bypass
- **MEDIUM**: Vulnerabilities requiring specific conditions but with significant impact
- **LOW**: Defense-in-depth issues or lower-impact vulnerabilities

CONFIDENCE SCORING:
- 0.9-1.0: Certain exploit path identified, tested if possible
- 0.8-0.9: Clear vulnerability pattern with known exploitation methods
- 0.7-0.8: Suspicious pattern requiring specific conditions to exploit
- Below 0.7: Don't report (too speculative)

FINAL REMINDER:
Focus on HIGH and MEDIUM findings only. Better to miss some theoretical issues than flood the report with false positives. Each finding should be something a security engineer would confidently raise in a PR review.

FALSE POSITIVE FILTERING:

> You do not need to run commands to reproduce the vulnerability, just read the code to determine if it is a real vulnerability. Do not use the bash tool or write to any files except the report file mentioned above.
>
> HARD EXCLUSIONS - Automatically exclude findings matching these patterns:
> 1. Denial of Service (DOS) vulnerabilities or resource exhaustion attacks.
> 2. Secrets or credentials stored on disk if they are otherwise secured.
> 3. Rate limiting concerns or service overload scenarios.
> 4. Memory consumption or CPU exhaustion issues.
> 5. Lack of input validation on non-security-critical fields without proven security impact.
> 6. Input sanitization concerns for GitHub Action workflows unless they are clearly triggerable via untrusted input.
> 7. A lack of hardening measures. Code is not expected to implement all security best practices, only flag concrete vulnerabilities.
> 8. Race conditions or timing attacks that are theoretical rather than practical issues. Only report a race condition if it is concretely problematic.
> 9. Vulnerabilities related to outdated third-party libraries. These are managed separately and should not be reported here.
> 10. Memory safety issues such as buffer overflows or use-after-free-vulnerabilities are impossible in rust. Do not report memory safety issues in rust or any other memory safe languages.
> 11. Files that are only unit tests or only used as part of running tests.
> 12. Log spoofing concerns. Outputting un-sanitized user input to logs is not a vulnerability.
> 13. SSRF vulnerabilities that only control the path. SSRF is only a concern if it can control the host or protocol.
> 14. Including user-controlled content in AI system prompts is not a vulnerability.
> 15. Regex injection. Injecting untrusted content into a regex is not a vulnerability.
> 16. Regex DOS concerns.
> 17. Insecure documentation. Do not report any findings in documentation files such as markdown files.
> 18. A lack of audit logs is not a vulnerability.
>
> PRECEDENTS -
> 1. Logging high value secrets in plaintext is a vulnerability. Logging URLs is assumed to be safe.
> 2. UUIDs can be assumed to be unguessable and do not need to be validated.
> 3. Environment variables and CLI flags are trusted values. Attackers are generally not able to modify them in a secure environment. Any attack that relies on controlling an environment variable is invalid.
> 4. Resource management issues such as memory or file descriptor leaks are not valid.
> 5. Subtle or low impact web vulnerabilities such as tabnabbing, XS-Leaks, prototype pollution, and open redirects should not be reported unless they are extremely high confidence.
> 6. React and Angular are generally secure against XSS. These frameworks do not need to sanitize or escape user input unless it is using dangerouslySetInnerHTML, bypassSecurityTrustHtml, or similar methods. Do not report XSS vulnerabilities in React or Angular components or tsx files unless they are using unsafe methods.
> 7. Most vulnerabilities in github action workflows are not exploitable in practice. Before validating a github action workflow vulnerability ensure it is concrete and has a very specific attack path.
> 8. A lack of permission checking or authentication in client-side JS/TS code is not a vulnerability. Client-side code is not trusted and does not need to implement these checks, they are handled on the server-side. The same applies to all flows that send untrusted data to the backend, the backend is responsible for validating and sanitizing all inputs.
> 9. Only include MEDIUM findings if they are obvious and concrete issues.
> 10. Most vulnerabilities in ipython notebooks (*.ipynb files) are not exploitable in practice. Before validating a notebook vulnerability ensure it is concrete and has a very specific attack path where untrusted input can trigger the vulnerability.
> 11. Logging non-PII data is not a vulnerability even if the data may be sensitive. Only report logging vulnerabilities if they expose sensitive information such as secrets, passwords, or personally identifiable information (PII).
> 12. Command injection vulnerabilities in shell scripts are generally not exploitable in practice since shell scripts generally do not run with untrusted user input. Only report command injection vulnerabilities in shell scripts if they are concrete and have a very specific attack path for untrusted input.
>
> SIGNAL QUALITY CRITERIA - For remaining findings, assess:
> 1. Is there a concrete, exploitable vulnerability with a clear attack path?
> 2. Does this represent a real security risk vs theoretical best practice?
> 3. Are there specific code locations and reproduction steps?
> 4. Would this finding be actionable for a security team?
>
> For each finding, assign a confidence score from 1-10:
> - 1-3: Low confidence, likely false positive or noise
> - 4-6: Medium confidence, needs investigation
> - 7-10: High confidence, likely true vulnerability

START ANALYSIS:

Begin your analysis now. Do this in 3 steps:

1. Identify vulnerabilities. Use the repository exploration tools (Read, Grep, Glob) to understand the codebase context, then analyze the PR changes for security implications.
2. For each identified vulnerability, apply the "FALSE POSITIVE FILTERING" criteria above and assign a confidence score.
3. Keep ONLY vulnerabilities with confidence >= 8.

Write your final markdown report to \`${outRel}\`. The file must contain the markdown report and nothing else. Do NOT edit any source files — your job is the review only.`;
}

export async function securityReviewCommand(options: SecurityReviewOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();

  // Git repo check
  try {
    execSync('git rev-parse --show-toplevel', { cwd, timeout: 5_000, stdio: 'pipe' });
  } catch {
    console.log(`${red('✗')} Diretorio nao e um repo git: ${cwd}`);
    return;
  }

  // CLI
  let cli = options.cli || 'claude';
  const available = (await detectInstalledCLIs()).map(c => c.name);
  if (!available.includes(cli)) {
    if (available.length === 0) {
      console.log(`${red('✗')} Nenhum CLI de IA detectado (claude, codex, gemini).`);
      return;
    }
    cli = available[0];
  }

  const base = resolveBaseRef(cwd, options.base);

  // Output path
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputFile = options.outputFile || path.join(cwd, '.makestudio', 'security-reviews', `${ts}.md`);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  if (!fs.existsSync(outputFile)) fs.writeFileSync(outputFile, '', 'utf8');
  const outRel = path.relative(cwd, outputFile).replace(/\\/g, '/');

  console.log(`${cyan('◇')} ${bold('Security review')}`);
  console.log(`${dim('│')}  base: ${dim(base)}`);
  console.log(`${dim('│')}  cli:  ${dim(cli)}`);
  console.log(`${dim('│')}  out:  ${dim(outRel)}`);
  console.log(`${dim('│')}  ${dim('(analisando changes contra a base... pode demorar alguns minutos)')}`);

  const prompt = buildSecurityReviewPrompt(cwd, base, outputFile);
  const result = await runLocalCLI(cli, prompt, cwd);

  if (!result || result.exitCode !== 0) {
    console.log(`${red('✗')} CLI retornou erro (exit ${result?.exitCode ?? '?'})`);
    return;
  }

  // Read report back
  let content = '';
  try { content = fs.readFileSync(outputFile, 'utf8'); } catch (err) { swallow(err); }

  if (!content.trim()) {
    console.log(`${yellow('!')} Relatorio vazio. O CLI pode ter respondido no stdout — verifique:`);
    console.log(`${dim('│')}  ${outRel}`);
    return;
  }

  // Quick parse: count vulns by severity
  const highCount = (content.match(/Severity[:\s*]+High/gi) || []).length;
  const medCount = (content.match(/Severity[:\s*]+Medium/gi) || []).length;
  const lowCount = (content.match(/Severity[:\s*]+Low/gi) || []).length;
  const total = highCount + medCount + lowCount;

  console.log('');
  if (total === 0) {
    console.log(`  ${green('✓')} ${bold('Nenhuma vulnerabilidade detectada')} (acima do threshold de confianca)`);
  } else {
    console.log(`  ${red('✗')} ${bold(`${total} vulnerabilidade(s) detectada(s)`)}`);
    if (highCount > 0) console.log(`    ${red('•')} HIGH: ${highCount}`);
    if (medCount > 0)  console.log(`    ${yellow('•')} MEDIUM: ${medCount}`);
    if (lowCount > 0)  console.log(`    ${dim('•')} LOW: ${lowCount}`);
  }
  console.log(`  ${dim('Relatorio completo:')} ${cyan(outRel)}`);
}
