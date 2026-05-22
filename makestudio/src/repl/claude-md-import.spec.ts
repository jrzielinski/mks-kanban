import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compactImportedRules, readImportFile } from './claude-md-import';

describe('compactImportedRules', () => {
  it('keeps structure while compacting and translating common PT-BR rules', () => {
    const raw = `# Claude Config

## Configurações do Projeto

- Responder sempre em português brasileiro (PT-BR)
- PROMPTS DE LLM SEMPRE EM INGLÊS

## Regras Importantes

### Execução do Backend

- NUNCA EXECUTAR O BACKEND
- PROIBIDO FAZER DEPLOY
`;

    const out = compactImportedRules(raw, 'CLAUDE.md');
    expect(out).toContain('# Imported Project Rules (CLAUDE.md)');
    expect(out).toContain('## Project Configuration');
    expect(out).toContain('## Important Rules');
    expect(out).toContain('### Backend Execution');
    expect(out).toContain('ALWAYS:');
    expect(out).toContain('Brazilian Portuguese');
    expect(out).toContain('LLM prompts must always be in English');
    expect(out).toContain('NEVER: start the backend');
    expect(out).toContain('NEVER: deploy unless explicitly requested');
  });

  it('reduces long prose paragraphs into compact rule bullets', () => {
    const raw = `## Regras Importantes

Ao implementar funcionalidades, garanta que todas as partes estejam integradas corretamente. Se o OAuth2 já existe, USE-O.
`;

    const out = compactImportedRules(raw, 'CLAUDE.md');
    expect(out).toContain('## Important Rules');
    expect(out).toContain('complete integration');
    expect(out.length).toBeLessThan(raw.length + 120);
  });
});

describe('readImportFile', () => {
  it('returns the compacted import content instead of the raw file body', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-import-'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '## Configurações do Projeto\n\n- Responder sempre em português brasileiro (PT-BR)\n', 'utf8');
    try {
      const out = readImportFile(file);
      expect(out).toContain('## Project Configuration');
      expect(out).toContain('Brazilian Portuguese');
      expect(out).not.toContain('## Configurações do Projeto');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
