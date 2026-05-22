import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectStacks } from './doctor';

function writePkg(dir: string, deps: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: deps }), 'utf8');
}

describe('detectStacks', () => {
  let root: string;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it('returns empty when no recognisable project markers are present', () => {
    expect(detectStacks(root)).toEqual([]);
  });

  // ── API layer ─────────────────────────────────────────────────

  it('detects NestJS API in api/', () => {
    writePkg(path.join(root, 'api'), { '@nestjs/core': '10.0.0' });
    const s = detectStacks(root);
    const api = s.find((x) => x.type === 'api');
    expect(api?.framework).toBe('nestjs');
    expect(api?.label).toBe('API (nestjs)');
  });

  it('detects Express API in backend/', () => {
    writePkg(path.join(root, 'backend'), { 'express': '4.0.0' });
    const s = detectStacks(root);
    expect(s.find((x) => x.type === 'api')?.framework).toBe('express');
  });

  it('detects Fastify API in server/', () => {
    writePkg(path.join(root, 'server'), { 'fastify': '4.0.0' });
    const s = detectStacks(root);
    expect(s.find((x) => x.type === 'api')?.framework).toBe('fastify');
  });

  it('falls back to NestJS at the root when no subdir API is found', () => {
    writePkg(root, { '@nestjs/core': '10.0.0' });
    const s = detectStacks(root);
    expect(s.find((x) => x.type === 'api')?.framework).toBe('nestjs');
  });

  it('does NOT pick the root API when a subdir API already exists', () => {
    writePkg(path.join(root, 'api'), { '@nestjs/core': '10.0.0' });
    writePkg(root, { 'express': '4.0.0' });
    const apis = detectStacks(root).filter((s) => s.type === 'api');
    expect(apis.length).toBe(1);
    expect(apis[0].framework).toBe('nestjs');
  });

  // ── WEB layer ─────────────────────────────────────────────────

  it('detects Next.js frontend', () => {
    writePkg(path.join(root, 'frontend'), { 'next': '14.0.0' });
    const s = detectStacks(root);
    expect(s.find((x) => x.type === 'web')?.framework).toBe('next');
  });

  it('detects Vite+React frontend', () => {
    writePkg(path.join(root, 'web'), { 'vite': '5.0.0', 'react': '18.0.0' });
    const s = detectStacks(root);
    expect(s.find((x) => x.type === 'web')?.framework).toBe('vite+react');
  });

  it('detects bare React frontend', () => {
    writePkg(path.join(root, 'client'), { 'react': '18.0.0' });
    const s = detectStacks(root);
    expect(s.find((x) => x.type === 'web')?.framework).toBe('react');
  });

  // ── MOBILE layer ──────────────────────────────────────────────

  it('detects Flutter mobile app in app/', () => {
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'pubspec.yaml'), 'name: app');
    const s = detectStacks(root);
    expect(s.find((x) => x.type === 'mobile')?.framework).toBe('flutter');
  });

  it('falls back to root pubspec.yaml when no subdir mobile project', () => {
    fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: app');
    const s = detectStacks(root);
    expect(s.find((x) => x.type === 'mobile')?.framework).toBe('flutter');
  });

  // ── Fullstack ─────────────────────────────────────────────────

  it('combines all three layers when present', () => {
    writePkg(path.join(root, 'api'), { '@nestjs/core': '10.0.0' });
    writePkg(path.join(root, 'web'), { 'next': '14.0.0' });
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'pubspec.yaml'), 'name: app');
    const types = detectStacks(root).map((s) => s.type).sort();
    expect(types).toEqual(['api', 'mobile', 'web']);
  });

  it('tolerates malformed package.json silently', () => {
    fs.mkdirSync(path.join(root, 'api'), { recursive: true });
    fs.writeFileSync(path.join(root, 'api', 'package.json'), '{not json');
    expect(detectStacks(root)).toEqual([]);
  });
});
