import { swallow } from '../utils/log';
/**
 * bootstrap-repo.ts — agent-side repo bootstrap.
 *
 * Two strategies, picked automatically:
 *
 *   A) **Template Repository** (preferred when `templateRepo` is set):
 *      `gh repo create <owner>/<name> --template <templateRepo>`
 *      One atomic GitHub call, keeps a discoverable lineage to the
 *      template, and lets the user `gh repo sync` future updates.
 *
 *   B) **Legacy clone-and-push** (fallback for boilerplates not yet
 *      published as standalone template repos):
 *      1. Resolve source from `~/develop/boilerplates/<id>/` or shallow
 *         clone of the monorepo `jrzielinski/boilerplates`.
 *      2. `gh repo create` empty → cp -R → git init/commit/push.
 *
 * Both paths run on the user's machine using the local `gh auth`, so no
 * PAT is exchanged with the VPS.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOCAL_BOILERPLATES_DIR = path.join(os.homedir(), 'develop', 'boilerplates');

export interface BootstrapInput {
  owner: string;
  name: string;
  isPrivate: boolean;
  boilerplateId: string;
  /** "<owner>/<repo>" of a GitHub Template Repository. When provided,
   *  selects the `gh repo create --template` strategy. */
  templateRepo?: string;
}

export async function bootstrapRepoFromBoilerplate(
  input: BootstrapInput,
): Promise<{ repoUrl: string; branch: string }> {
  // ── 0. Preconditions ──────────────────────────────────────────────
  try {
    execSync('gh auth status', { stdio: 'pipe' });
  } catch {
    throw new Error(
      '`gh` CLI is not authenticated on this machine. Run `gh auth login` first.',
    );
  }

  const { owner, name, isPrivate, boilerplateId, templateRepo } = input;

  // ── Strategy A: GitHub Template Repository ────────────────────────
  if (templateRepo) {
    return bootstrapFromTemplate({
      owner,
      name,
      isPrivate,
      templateRepo,
      boilerplateId,
    });
  }

  // ── Strategy B: legacy clone + cp -R + push ───────────────────────
  return bootstrapFromMonorepo({ owner, name, isPrivate, boilerplateId });
}

/** Atomic create-from-template. The new repo's default branch is whatever
 *  the template uses (we set ours to `main`), and the lineage is preserved
 *  in GitHub's "Generated from <template>" header. */
async function bootstrapFromTemplate(args: {
  owner: string;
  name: string;
  isPrivate: boolean;
  templateRepo: string;
  boilerplateId: string;
}): Promise<{ repoUrl: string; branch: string }> {
  const visibility = args.isPrivate ? '--private' : '--public';
  const slug = `${args.owner}/${args.name}`;
  try {
    execSync(
      `gh repo create ${slug} ${visibility} --template ${args.templateRepo} --description "Bootstrapped from ${args.boilerplateId} (template ${args.templateRepo})"`,
      { stdio: 'pipe', timeout: 60_000 },
    );
  } catch (err: any) {
    const stderr = err?.stderr?.toString() || err?.message || '';
    throw new Error(`gh repo create --template failed: ${stderr.split('\n').slice(0, 3).join(' | ')}`);
  }

  // Resolve the actual default branch GitHub gave us — most templates
  // ship `main`, but a few use `develop`. Read it instead of guessing.
  let branch = 'main';
  try {
    const out = execSync(
      `gh api repos/${slug} --jq .default_branch`,
      { stdio: 'pipe', timeout: 15_000 },
    ).toString().trim();
    if (out) branch = out;
  } catch (err) { swallow(err); }

  return { repoUrl: `https://github.com/${args.owner}/${args.name}.git`, branch };
}

async function bootstrapFromMonorepo(args: {
  owner: string;
  name: string;
  isPrivate: boolean;
  boilerplateId: string;
}): Promise<{ repoUrl: string; branch: string }> {
  const { owner, name, isPrivate, boilerplateId } = args;
  const branch = 'develop';

  // ── 1. Resolve boilerplate source ─────────────────────────────────
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bootstrap-repo-${name}-`));
  let sourceDir = path.join(LOCAL_BOILERPLATES_DIR, boilerplateId);

  if (!fs.existsSync(sourceDir)) {
    // Fall back: clone the boilerplates registry into tmp
    const clonedRegistry = path.join(tmpRoot, 'boilerplates');
    try {
      execSync(`gh repo clone jrzielinski/boilerplates ${clonedRegistry} -- --depth 1`, {
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err: any) {
      cleanup(tmpRoot);
      throw new Error(
        `Boilerplate '${boilerplateId}' not in ~/develop/boilerplates/ and gh clone failed: ${err.message?.split('\n')[0]}`,
      );
    }
    sourceDir = path.join(clonedRegistry, boilerplateId);
    if (!fs.existsSync(sourceDir)) {
      cleanup(tmpRoot);
      throw new Error(`Boilerplate '${boilerplateId}' does not exist in the registry`);
    }
  }

  const targetDir = path.join(tmpRoot, 'target');
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    // ── 2. Create the GitHub repo via gh ─────────────────────────────
    const visibility = isPrivate ? '--private' : '--public';
    const slug = `${owner}/${name}`;
    let repoCreatedOnGitHub = false;
    try {
      execSync(
        `gh repo create ${slug} ${visibility} --description "Bootstrapped from MakeStudio boilerplate '${boilerplateId}'" --disable-wiki`,
        { stdio: 'pipe', timeout: 30_000 },
      );
      repoCreatedOnGitHub = true;
    } catch (err: any) {
      const stderr = err?.stderr?.toString() || err?.message || '';
      throw new Error(`gh repo create failed: ${stderr.split('\n').slice(0, 3).join(' | ')}`);
    }

    // From here on, ANY failure must `gh repo delete` to avoid leaving an
    // empty repo on the user's GitHub. The previous version threw on push
    // failure leaving the repo orphaned; next attempt with the same name
    // would fail at gh repo create and the user had to clean up by hand.
    try {
      // ── 3. Copy boilerplate contents into target ────────────────────
      execSync(`cp -R ${sourceDir}/. ${targetDir}/`, { stdio: 'pipe' });

      // ── 4. Init git + commit + push ─────────────────────────────────
      execSync(`git init -q -b ${branch}`, { cwd: targetDir, stdio: 'pipe' });
      execSync('git add -A', { cwd: targetDir, stdio: 'pipe' });
      execSync(
        `git -c user.email=bootstrap@makestudio -c user.name="MakeStudio" commit -qm "chore: bootstrap from ${boilerplateId} boilerplate"`,
        { cwd: targetDir, stdio: 'pipe' },
      );

      // Use gh's auth for the push — no need to handle the token ourselves
      const repoUrl = `https://github.com/${owner}/${name}.git`;
      execSync(`git remote add origin ${repoUrl}`, { cwd: targetDir, stdio: 'pipe' });

      // `gh auth setup-git` configures a helper so `git push` uses the
      // logged-in user's credentials automatically. Idempotent + safe.
      try { execSync('gh auth setup-git', { stdio: 'pipe' }); } catch (err) { swallow(err); }

      execSync(`git push -u origin ${branch}`, {
        cwd: targetDir,
        stdio: 'pipe',
        timeout: 120_000,
      });

      return { repoUrl, branch };
    } catch (postCreateErr: any) {
      // Best-effort delete of the empty repo we just created. If this
      // also fails (network, perm) the user gets a helpful message.
      if (repoCreatedOnGitHub) {
        try {
          execSync(`gh repo delete ${slug} --yes`, { stdio: 'pipe', timeout: 30_000 });
        } catch (err) { swallow(err); }
      }
      throw postCreateErr;
    }
  } finally {
    cleanup(tmpRoot);
  }
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { swallow(err); }
}
