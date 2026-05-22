/**
 * `execute` command — abort flag. Module-scoped so handlers and the
 * orchestrator can both check / clear it.
 */
let abortRequested = false;
export function isAbortRequested(): boolean { return abortRequested; }
export function resetAbort(): void { abortRequested = false; }
export function setAbortRequested(v: boolean): void { abortRequested = v; }
