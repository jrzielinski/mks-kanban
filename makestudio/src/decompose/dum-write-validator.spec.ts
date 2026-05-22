import { validateDumJson, formatValidationError } from './dum-write-validator';

const MIN_DESC = `## Entities

The \`users\` table holds account data.
- \`src/db/migrations/001_users.sql\` — CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL);
- Inserted via \`createUser(input: CreateUserInput): Promise<User>\` in \`src/services/users.service.ts\`.
- Status enum: \`USER_STATUS\` = ACTIVE | SUSPENDED | DELETED.
- Default created_at = NOW().
- Indexes: idx_users_email on lower(email).
- p99 read latency target ≤ 50ms.

## Mermaid

\`\`\`mermaid
erDiagram
  USERS ||--o{ POSTS : has
\`\`\`
`;

function validDum(overrides: Partial<any> = {}): string {
  return JSON.stringify({
    tempId: 'dum_017',
    title: 'Modelo de dados de Users',
    type: 'database',
    description: MIN_DESC,
    tasks: [
      {
        title: 'Criar migration users',
        description: 'Migration SQL inicial.\n- Arquivo: `src/db/migrations/001_users.sql`\n- DDL: `CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(255));`\n- Aplica via `npm run migration:run`.\n- Verificar que `\\d users` mostra 2 colunas.\n- Status code 0 ao final.',
        type: 'database',
        complexity: 'low',
        acceptanceCriteria: [
          'DADO migration vazia QUANDO rodar `npm run migration:run` ENTÃO `\\d users` mostra coluna `id UUID PK`',
          'DADO tabela vazia QUANDO INSERT INTO users (id, email) VALUES (gen_random_uuid(), "x@y.z") ENTÃO retorna 1 linha com status 200',
          'DADO valor duplicado QUANDO INSERT mesma email ENTÃO erro 23505 unique_violation',
        ],
      },
    ],
    ...overrides,
  });
}

describe('validateDumJson', () => {
  it('accepts a well-formed DUM', () => {
    const r = validateDumJson(validDum());
    if (!r.ok) console.log('UNEXPECTED ERRORS:', r.errors);
    expect(r.ok).toBe(true);
  });

  it('reports JSON parse failure with hint about \\d escapes', () => {
    const r = validateDumJson('{ "tempId": "dum_001", "bad": "\\d" ');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/JSON parse failed/);
    expect(r.errors[0]).toMatch(/\\d/);
  });

  it('flags missing tempId', () => {
    const r = validateDumJson(validDum({ tempId: undefined }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Missing required field `tempId`/);
  });

  it('flags wrong tempId when expected provided', () => {
    const r = validateDumJson(validDum(), { expectedTempId: 'dum_018' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Wrong tempId/);
  });

  it('flags wrong type when expected provided', () => {
    const r = validateDumJson(validDum(), { expectedType: 'backend' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Wrong type/);
  });

  it('flags missing required section headers', () => {
    const r = validateDumJson(validDum(), {
      expectedSections: ['Entities', 'Relationships', 'Indexes'],
    });
    expect(r.ok).toBe(false);
    // Entities present, the other two missing → error must mention them
    expect(r.errors.join(' ')).toMatch(/Relationships/);
    expect(r.errors.join(' ')).toMatch(/Indexes/);
  });

  it('flags missing file path in description', () => {
    const longNoPath =
      '## Entities\n\nLong description without any file path or extension. '.repeat(5) +
      '\n- function foo(): void {}\n- Bullet describing semantics.\n- Another descriptive bullet.\n- Yet another note.\n## Mermaid\n\nflowchart TD\nA --> B';
    const r = validateDumJson(validDum({ description: longNoPath }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/no concrete file path/);
  });

  it('flags missing signature in description', () => {
    const r = validateDumJson(
      validDum({
        description:
          '## Entities\n\nA wordy description with a file path but no signature anywhere. ' +
          'A users module with multiple bullet items below: ' +
          '- Arquivo: src/foo/bar.ts contém configurações.\n' +
          '- Mais texto descritivo sem nenhuma assinatura concreta.\n' +
          '- Lista de coisas que serão feitas mas sem signatures.\n' +
          '- Outro item explicativo de fluxos sem código.\n' +
          '- Mais um item de descrição livre.\n' +
          '- E outro item textual sem código embutido.\n' +
          '- Final do bloco descritivo da entidade.\n' +
          '- Fim das observações livres aqui.\n## Mermaid\n\nflowchart TD\nA --> B',
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/no method\/function\/DDL signature/);
  });

  it('accepts Dart-style signature (Widget build(...))', () => {
    const dartDesc =
      '## Entities\n\n- File: app/lib/screens/home.dart\n- Widget build(BuildContext context) {\n    return Scaffold();\n  }\n- Class HomeScreen extends StatelessWidget.\n- Dimensions: 360x640 baseline.\n- Status: ACTIVE_USERS counter.\n- Tested at p99 < 100ms.\n## Mermaid\n\nflowchart TD\nA --> B';
    const r = validateDumJson(validDum({ description: dartDesc }));
    if (!r.ok) console.log('errors:', r.errors);
    expect(r.ok).toBe(true);
  });

  it('flags `any` type holes in description', () => {
    const desc =
      '## Entities\n\nLong-enough description to clear the 200-char minimum threshold. ' +
      'The module covers users data persistence and exposes operations.\n\n' +
      '- File: src/foo.ts\n' +
      '- function bar(x: any): void {}\n' +
      '- Outras informações descritivas adicionais aqui.\n' +
      '- Mais detalhe sobre comportamento esperado em runtime.\n' +
      '- Outro item descritivo.\n' +
      '- Item número 5 da lista.\n' +
      '- Item número 6 da lista.\n' +
      '- Item número 7 da lista.\n' +
      '## Mermaid\n\nflowchart TD\nA --> B';
    const r = validateDumJson(validDum({ description: desc }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/type-annotation hole "any"/);
  });

  // Regression test for the false-positive that blocked legitimate DUMs.
  // The validator used to flag `\b(any|unknown)\b` anywhere in the
  // description, rejecting prose like "any of the following statuses". The
  // new contextual matcher only flags `any`/`unknown` in type-annotation
  // contexts (after `:`, in <generics>, in `as` casts).
  it('ACCEPTS `any` / `unknown` in natural prose', () => {
    const proseDesc =
      MIN_DESC.replace(
        '## Mermaid',
        'The endpoint accepts any of the following statuses: ACTIVE, SUSPENDED. ' +
          'Returns the matching record if found; otherwise returns null. ' +
          'The service may operate on unknown user agents without rejecting them. ' +
          'Any error in the upstream propagates as 502.\n\n## Mermaid',
      );
    const r = validateDumJson(validDum({ description: proseDesc }));
    if (!r.ok) console.log('UNEXPECTED ERRORS:', r.errors);
    expect(r.ok).toBe(true);
  });

  it('flags `: any` (TS type annotation)', () => {
    const desc =
      '## Entities\n\n' +
      'Long-enough description to clear the 200-char minimum threshold. ' +
      'The service exposes one method that takes a user payload.\n\n' +
      '- File: `src/services/user.service.ts`\n' +
      '- Method: `processPayload(payload: any): Promise<void>`\n' +
      '- Item descritivo aqui.\n' +
      '- Outro item.\n' +
      '- Mais um.\n' +
      '- E mais.\n' +
      '- Final.\n' +
      '- Fim.\n' +
      '## Mermaid\n\nflowchart TD\nA --> B';
    const r = validateDumJson(validDum({ description: desc }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/type-annotation hole "any"/);
  });

  it('flags `<any>` (TS generic)', () => {
    const desc =
      '## Entities\n\n' +
      'Long-enough description to clear the 200-char minimum threshold. ' +
      'The service exposes one method that returns a typed array.\n\n' +
      '- File: `src/services/user.service.ts`\n' +
      '- Method: `getAll(): Promise<Array<any>>` ← bad generic\n' +
      '- Item descritivo aqui.\n' +
      '- Outro item.\n' +
      '- Mais um.\n' +
      '- E mais.\n' +
      '- Final.\n' +
      '- Fim.\n' +
      '## Mermaid\n\nflowchart TD\nA --> B';
    const r = validateDumJson(validDum({ description: desc }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/type-annotation hole "any"/);
  });

  it('flags `as any` (TS cast)', () => {
    const desc =
      '## Entities\n\n' +
      'Long-enough description to clear the 200-char minimum threshold. ' +
      'The service exposes one method.\n\n' +
      '- File: `src/services/user.service.ts`\n' +
      '- Code: `const x = (input as any).id;`\n' +
      '- Item descritivo aqui.\n' +
      '- Outro item.\n' +
      '- Mais um.\n' +
      '- E mais.\n' +
      '- Final.\n' +
      '- Fim.\n' +
      '## Mermaid\n\nflowchart TD\nA --> B';
    const r = validateDumJson(validDum({ description: desc }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/type-annotation hole "any"/);
  });

  it('flags TODO placeholder anywhere', () => {
    const desc = MIN_DESC.replace('## Mermaid', 'TODO: integrar com serviço externo.\n\n## Mermaid');
    const r = validateDumJson(validDum({ description: desc }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/placeholder "TODO"/);
  });

  it('flags ??? placeholder', () => {
    const desc = MIN_DESC.replace('## Mermaid', '??? cobertura indefinida\n\n## Mermaid');
    const r = validateDumJson(validDum({ description: desc }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/placeholder "\?\?\?"/);
  });

  it('flags <placeholder> tag', () => {
    const desc = MIN_DESC.replace('## Mermaid', 'Substituir <placeholder> pelo nome real.\n\n## Mermaid');
    const r = validateDumJson(validDum({ description: desc }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/placeholder "<placeholder>"/);
  });

  it('flags AC without concrete value', () => {
    const r = validateDumJson(
      validDum({
        tasks: [
          {
            title: 'Task with weak ACs',
            description:
              'Migration step.\n- File `src/db/migrations/001.sql`\n- DDL `CREATE TABLE x (id UUID);`\n- Apply via runner.\n- Verify columns.\n- Validate count.\n- Confirm status.\n- Done.',
            type: 'database',
            complexity: 'low',
            acceptanceCriteria: [
              'DADO algo QUANDO acontece ENTÃO funciona corretamente',
              'DADO outra coisa QUANDO outra acao ENTÃO ok',
              'DADO terceira QUANDO acao ENTÃO sem erro',
            ],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/concrete value/);
  });

  it('flags task description too short', () => {
    const r = validateDumJson(
      validDum({
        tasks: [
          { title: 'Tiny task', description: 'tiny', type: 'database', complexity: 'low', acceptanceCriteria: ['a', 'b', 'c'] },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/description.*too short/);
  });

  // Mirror the server-side gate's ≥1 AC floor — local validator should NOT
  // reject what the server would accept.
  it('accepts a task with exactly 1 AC (matches server gate floor)', () => {
    const r = validateDumJson(
      validDum({
        tasks: [
          {
            title: 'Single AC task',
            description:
              'Migration step inicial.\n- Arquivo: `src/db/migrations/001_users.sql`\n- DDL `CREATE TABLE users (id UUID PRIMARY KEY, email VARCHAR(255));`\n- Aplica via `npm run migration:run`.\n- Verificar `\\d users` mostra 2 colunas.\n- Status code 0 ao final.',
            type: 'database',
            complexity: 'low',
            acceptanceCriteria: [
              'DADO migration `001_users.sql` QUANDO rodar `npm run migration:run` ENTÃO `\\d users` retorna 2 colunas com status 0',
            ],
          },
        ],
      }),
    );
    if (!r.ok) console.log('errors:', r.errors);
    expect(r.ok).toBe(true);
  });

  it('flags 0 acceptanceCriteria (below server floor)', () => {
    const r = validateDumJson(
      validDum({
        tasks: [
          {
            title: 'No AC task',
            description:
              'Migration step inicial.\n- Arquivo: `src/db/migrations/001_users.sql`\n- DDL `CREATE TABLE users (id UUID);`\n- Aplica.\n- Verificar.\n- Status 0.',
            type: 'database',
            complexity: 'low',
            acceptanceCriteria: [],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/at least 1 acceptanceCriteria/);
  });
});

// Pre-Write hook integration: ensure the path-pattern in writeImpl matches
// only the intended files. Captured here so we don't accidentally reject
// or skip on the wrong paths.
describe('writeImpl path-matching regex', () => {
  const re = /\.makestudio\/dums\/dum_\d+\.json$/;

  it('matches absolute path under .makestudio/dums/', () => {
    expect(re.test('/tmp/.makestudio/dums/dum_017.json')).toBe(true);
    expect(re.test('/home/u/.makestudio/repos/p/.makestudio/dums/dum_001.json')).toBe(true);
  });

  it('does NOT match other paths', () => {
    expect(re.test('/tmp/.makestudio/dums/master.json')).toBe(false);
    expect(re.test('/tmp/.makestudio/decompose-task/STRUCTURE.json')).toBe(false);
    expect(re.test('/tmp/foo/dum_001.json')).toBe(false);
    expect(re.test('/tmp/.makestudio/dums/dum_017.json.bak')).toBe(false);
  });

  it('does NOT match upper-case variations', () => {
    expect(re.test('/tmp/.makestudio/Dums/dum_001.json')).toBe(false);
    expect(re.test('/tmp/.makestudio/dums/DUM_001.json')).toBe(false);
  });
});

describe('formatValidationError', () => {
  it('returns empty string when ok', () => {
    expect(formatValidationError({ ok: true, errors: [] }, 'foo.json')).toBe('');
  });

  it('warns NOTHING WAS WRITTEN and steers to Write (not Edit)', () => {
    const msg = formatValidationError(
      { ok: false, errors: ['Missing X', 'Wrong Y'] },
      'dum_018.json',
    );
    expect(msg).toMatch(/NOTHING WAS WRITTEN/);
    expect(msg).toMatch(/dum_018\.json/);
    expect(msg).toMatch(/another Write call/);
    expect(msg).toMatch(/Do NOT use Edit/);
    expect(msg).toMatch(/Do NOT use Read/);
    expect(msg).toMatch(/Missing X/);
    expect(msg).toMatch(/Wrong Y/);
  });
});
