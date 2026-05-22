/**
 * Test-only re-export of internals from `per-requirement-loop.ts`.
 *
 * `spawnCliAndCapture` is exported from the loop module so the Phase 2
 * overwrite-detector spec can call it directly without spinning up a
 * real `claude` CLI. Keeping the re-export in a paired file lets us
 * relocate the symbol when Phase 3 splits the loop into structure-pass
 * and enrich-pass without touching the spec.
 */
export { spawnCliAndCapture, type WrittenFile } from './per-requirement-loop';
