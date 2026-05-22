import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readProjectLink,
  saveProjectLink,
  detectBoilerplateFromStructure,
} from './project-prep';

function touch(p: string, content = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('readProjectLink + saveProjectLink', () => {
  let repo: string;
  beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-')); });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

  it('returns null when no link file exists', () => {
    expect(readProjectLink(repo)).toBeNull();
  });

  it('round-trips a ProjectLink', () => {
    const link = { projectId: 'p-1', projectName: 'Acme', tenantId: 't-1' };
    saveProjectLink(repo, link as any);
    expect(readProjectLink(repo)).toEqual(link);
  });

  it('creates .makestudio/ directory when missing', () => {
    saveProjectLink(repo, { projectId: 'x' } as any);
    expect(fs.existsSync(path.join(repo, '.makestudio', 'project.json'))).toBe(true);
  });

  it('returns null when the link file is not valid JSON', () => {
    fs.mkdirSync(path.join(repo, '.makestudio'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.makestudio', 'project.json'), '{not json');
    expect(readProjectLink(repo)).toBeNull();
  });
});

describe('detectBoilerplateFromStructure', () => {
  let repo: string;
  beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'boil-')); });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

  it('returns null for an empty project', () => {
    expect(detectBoilerplateFromStructure(repo)).toBeNull();
  });

  it('detects fullstack-mobile (backend + frontend + mobile)', () => {
    fs.mkdirSync(path.join(repo, 'api'));
    fs.mkdirSync(path.join(repo, 'web'));
    fs.mkdirSync(path.join(repo, 'app'));
    touch(path.join(repo, 'app', 'pubspec.yaml'));
    expect(detectBoilerplateFromStructure(repo)).toBe('fullstack-mobile');
  });

  it('detects saas-enterprise when backend has tenants + docker-compose', () => {
    fs.mkdirSync(path.join(repo, 'api', 'src', 'tenants'), { recursive: true });
    touch(path.join(repo, 'api', 'src', 'main.ts'));
    fs.mkdirSync(path.join(repo, 'web'));
    touch(path.join(repo, 'docker-compose.yml'));
    expect(detectBoilerplateFromStructure(repo)).toBe('saas-enterprise');
  });

  it('detects e-commerce from package name', () => {
    touch(path.join(repo, 'api', 'package.json'), JSON.stringify({ name: 'my-ecommerce-app' }));
    touch(path.join(repo, 'api', 'src', 'main.ts'));
    fs.mkdirSync(path.join(repo, 'web'));
    touch(path.join(repo, 'docker-compose.yaml'));
    expect(detectBoilerplateFromStructure(repo)).toBe('e-commerce');
  });

  it('detects saas-multitenant as the fallback for backend+frontend+docker+nest', () => {
    touch(path.join(repo, 'api', 'package.json'), JSON.stringify({ name: 'generic-app' }));
    touch(path.join(repo, 'api', 'src', 'main.ts'));
    fs.mkdirSync(path.join(repo, 'web'));
    touch(path.join(repo, 'docker-compose.yml'));
    expect(detectBoilerplateFromStructure(repo)).toBe('saas-multitenant');
  });

  it('detects mobile-app for a solo Flutter project', () => {
    fs.mkdirSync(path.join(repo, 'app'));
    touch(path.join(repo, 'app', 'pubspec.yaml'));
    expect(detectBoilerplateFromStructure(repo)).toBe('mobile-app');
  });

  it('detects saas-starter for backend + frontend without extras', () => {
    fs.mkdirSync(path.join(repo, 'api'));
    fs.mkdirSync(path.join(repo, 'web'));
    expect(detectBoilerplateFromStructure(repo)).toBe('saas-starter');
  });

  it('detects api-minimal for Nest-backend-only projects', () => {
    touch(path.join(repo, 'src', 'main.ts'));
    expect(detectBoilerplateFromStructure(repo)).toBe('api-minimal');
  });

  it('detects spa-frontend for React-only projects', () => {
    touch(path.join(repo, 'src', 'App.tsx'));
    expect(detectBoilerplateFromStructure(repo)).toBe('spa-frontend');
  });

  it('tolerates a missing package.json without throwing', () => {
    // Bare dirs only
    fs.mkdirSync(path.join(repo, 'api'));
    expect(detectBoilerplateFromStructure(repo)).toBeNull();
  });
});
