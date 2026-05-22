/**
 * `analyze` command — prompts module. Extracted from analyze.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import chalk from 'chalk';

const dim    = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green  = chalk.hex('#22C55E');
const cyan   = chalk.hex('#22D3EE');
const red    = chalk.hex('#EF4444');
const blue   = chalk.hex('#60A5FA');

export const ANALYZE_PROMPT = `You are a senior software architect performing an exhaustive codebase analysis.

OUTPUT LANGUAGE RULE: All descriptive text (description, summary, endpoint descriptions, pattern names, component types) MUST be written in PORTUGUESE (pt-BR). Technical names (class names, field names, framework names, file paths) keep their original form.

Your task: Analyze this project directory completely and return a structured JSON with the full codebase analysis.

## MANDATORY STEPS — execute ALL of them in order, do not skip any

### STEP 1 — Project metadata
- Read package.json (or requirements.txt / pubspec.yaml / go.mod / Cargo.toml if present)
- Read README.md if present

### STEP 2 — Exhaustive entity/model enumeration
Run these Bash commands to get the FULL list, then read EVERY file returned:
\`\`\`
grep -rl "@Entity\\|@Schema\\|BaseModel\\|db.Model" . --include="*.ts" --include="*.py" --include="*.go" --include="*.java" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git
\`\`\`
Also try:
\`\`\`
find . -name "*.entity.ts" -o -name "*.model.ts" -o -name "*.schema.ts" | grep -v node_modules | grep -v dist
\`\`\`
Read EACH file found. Extract the class name and ALL @Column/@Prop/field definitions from the class body.
DO NOT stop after a few — enumerate ALL of them.

### STEP 3 — Exhaustive endpoint enumeration
Run this to get ALL controller files:
\`\`\`
grep -rl "@Controller" . --include="*.ts" | grep -v node_modules | grep -v dist | grep -v .git
\`\`\`
For non-NestJS projects also search: router.get, app.get, @app.route, @router, FastAPI @app, etc.

Read EVERY controller file found. For each file:
- Find the @Controller('basePath') prefix
- Find every @Get(), @Post(), @Patch(), @Put(), @Delete() method
- Combine base path + method path to build the full route
- Note the HTTP method

DO NOT summarize or skip — list EVERY individual endpoint found across ALL controller files.

### STEP 4 — Frontend components (if applicable)
\`\`\`
find . -name "*.tsx" -o -name "*.jsx" | grep -v node_modules | grep -v dist | head -200
\`\`\`
Sample key component files and extract component names.

### STEP 5 — Architecture patterns
- Read app.module.ts or equivalent entry point
- Check for: guards, middleware, interceptors, decorators
- Check for: queue files (bull, celery, sidekiq), WebSocket gateways, event emitters
- Check for: Redis, caching decorators, rate limiting
- Read one auth guard/service file

## Output Format

Return ONLY a valid JSON object (no markdown fences, no explanation):

{
  "name": "project name from package.json or directory name",
  "stack": {
    "backend": ["NestJS 11", "TypeORM 0.3"],
    "frontend": ["React 18", "TailwindCSS"],
    "mobile": [],
    "database": ["PostgreSQL", "Redis"],
    "infra": ["Docker", "Bull queues"]
  },
  "dependencies": ["top 20 most important dependencies with versions"],
  "entities": [
    { "name": "User", "fields": ["id", "email", "name", "role", "tenantId"], "file": "src/users/entities/user.entity.ts" }
  ],
  "endpoints": [
    { "method": "GET", "path": "/v1/users", "file": "src/users/users.controller.ts", "description": "Lista todos os usuários do tenant" }
  ],
  "components": [
    { "name": "UserForm", "file": "src/components/UserForm.tsx", "type": "formulário" }
  ],
  "patterns": ["Autenticação JWT com refresh token", "RBAC com guards NestJS", "Multi-tenant via middleware", "Repository Pattern com TypeORM", "Filas assíncronas com Bull/Redis"],
  "description": "Um parágrafo em português descrevendo o que este sistema faz e seu propósito principal",
  "summary": "Análise arquitetural detalhada em markdown EM PORTUGUÊS com 500+ palavras cobrindo: arquitetura geral, módulos principais, padrões de design usados, pontos fortes, riscos e áreas de melhoria"
}

## CRITICAL RULES
- entities array MUST contain ALL entities found in STEP 2 — if you found 50 entity files, include all 50
- endpoints array MUST contain ALL endpoints found in STEP 3 — if you found 200 endpoints across 40 controllers, include all 200
- Do NOT sample or truncate — completeness is mandatory
- For each entity, read the actual file and list real field names from @Column/@Prop decorators
- For each endpoint, combine the controller base path with the method decorator path

## MANDATORY FINAL STEP — do this LAST, after all analysis is complete

Build the complete JSON object in memory, then run this exact bash command to save it:
\`\`\`
cat > /tmp/codebase_analysis.json << 'ENDJSON'
<paste the complete JSON here>
ENDJSON
\`\`\`

After saving, output ONLY this single line and nothing else:
JSON_SAVED:/tmp/codebase_analysis.json
`;

export const DEEP_ANALYZE_PROMPT = `You are a senior software architect performing an exhaustive codebase analysis.
TOKEN EFFICIENCY IS CRITICAL — use batch shell commands to extract many files at once. Never cat files one by one.

OUTPUT LANGUAGE RULE: All descriptive text MUST be written in PORTUGUESE (pt-BR). Technical names keep their original form.

## MANDATORY STEPS — execute in order

### STEP 1 — Project metadata (single read)
\`\`\`bash
cat package.json 2>/dev/null || cat requirements.txt 2>/dev/null || cat go.mod 2>/dev/null || cat pubspec.yaml 2>/dev/null | head -60
cat README.md 2>/dev/null | head -80
\`\`\`

### STEP 2 — Exhaustive entity extraction (BATCH — do NOT cat files individually)
Find all entity files then extract fields in ONE shell command:
\`\`\`bash
grep -rl "@Entity\\|@Schema\\|BaseModel" . --include="*.ts" --include="*.py" --include="*.go" 2>/dev/null | grep -v node_modules | grep -v dist | while read f; do echo "=== $f ==="; grep -E "^export class |@Entity|@Column|@PrimaryGeneratedColumn|@ManyToOne|@OneToMany|@ManyToMany|@OneToOne|@Prop|@Field|readonly |  [a-z].*:" "$f" 2>/dev/null | head -60; echo; done
\`\`\`
Also try this fallback to catch any missed files:
\`\`\`bash
find . -name "*.entity.ts" -o -name "*.model.ts" -o -name "*.schema.ts" 2>/dev/null | grep -v node_modules | grep -v dist | while read f; do echo "=== $f ==="; grep -E "class |@Column|@Prop|@Field|@Primary" "$f" 2>/dev/null | head -40; echo; done
\`\`\`

### STEP 3 — Exhaustive endpoint extraction (BATCH — single grep command)
\`\`\`bash
grep -rn "@Controller\\|@Get\\|@Post\\|@Put\\|@Patch\\|@Delete\\|@Head\\|@Options" . --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v ".spec." | grep -v ".test."
\`\`\`
For non-NestJS also check:
\`\`\`bash
grep -rn "router\\.get\\|router\\.post\\|app\\.get\\|app\\.post\\|@app\\.route\\|@router\\." . --include="*.py" --include="*.js" --include="*.go" 2>/dev/null | grep -v node_modules | head -200
\`\`\`

### STEP 4 — Frontend components (list only, no full reads)
\`\`\`bash
find . -name "*.tsx" -o -name "*.jsx" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v ".test." | head -200
ls src/pages/ 2>/dev/null; ls src/components/ 2>/dev/null; ls src/screens/ 2>/dev/null
\`\`\`

### STEP 5 — Architecture scan (batch)
\`\`\`bash
cat src/main.ts 2>/dev/null | head -80 || cat main.go 2>/dev/null | head -80 || cat app.py 2>/dev/null | head -80
grep -rn "@UseGuards\\|@Injectable\\|@Module\\|@Global\\|@EventEmitter\\|@WebSocketGateway\\|@Cron\\|BullModule" . --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v ".spec." | head -100
grep -rn "bcrypt\\|argon2\\|jwt\\|passport\\|helmet\\|throttle\\|rateLimit\\|cache" . --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v ".spec." | head -60
\`\`\`

### STEP 6 — Additional deep checks (batch)
\`\`\`bash
find . -name "*.migration.ts" -o -name "*migration*.ts" 2>/dev/null | grep -v node_modules | wc -l
find . -name "*.spec.ts" -o -name "*.test.ts" 2>/dev/null | grep -v node_modules | wc -l
ls .github/workflows/ 2>/dev/null
grep -rn "TODO\\|FIXME\\|HACK" . --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v dist | wc -l
grep -c "console\\.log" $(find . -name "*.ts" | grep -v node_modules | grep -v dist | grep -v ".spec.") 2>/dev/null | grep -v ":0" | wc -l
\`\`\`

## Output Format
Return ONLY a valid JSON object (no markdown fences, no explanation):
{
  "name": "project name from package.json or directory name",
  "stack": {
    "backend": ["NestJS 11", "TypeORM 0.3"],
    "frontend": ["React 18", "TailwindCSS"],
    "mobile": [],
    "database": ["PostgreSQL", "Redis"],
    "infra": ["Docker", "Bull queues"]
  },
  "dependencies": ["top 20 most important dependencies with versions"],
  "entities": [
    { "name": "User", "fields": ["id", "email", "name", "role", "tenantId"], "file": "src/users/entities/user.entity.ts" }
  ],
  "endpoints": [
    { "method": "GET", "path": "/v1/users", "file": "src/users/users.controller.ts", "description": "Lista todos os usuários do tenant" }
  ],
  "components": [
    { "name": "UserForm", "file": "src/components/UserForm.tsx", "type": "formulário" }
  ],
  "patterns": ["Autenticação JWT com refresh token", "RBAC com guards NestJS", "Multi-tenant via middleware"],
  "description": "Um parágrafo em português descrevendo o que este sistema faz e seu propósito principal",
  "summary": "Análise arquitetural detalhada em markdown EM PORTUGUÊS com 500+ palavras"
}

## CRITICAL RULES
- entities: include ALL entities found — do not truncate
- endpoints: build full path by combining @Controller prefix + @Get/@Post path
- Use BATCH commands — never read files one by one with cat
- Do NOT sample or skip entities/endpoints for brevity

## MANDATORY FINAL STEP
Build the complete JSON, then save it:
\`\`\`bash
cat > /tmp/codebase_analysis.json << 'ENDJSON'
<paste the complete JSON here>
ENDJSON
\`\`\`
After saving, output ONLY this line:
JSON_SAVED:/tmp/codebase_analysis.json
`;

export const AUDIT_PROMPT = `Você é um arquiteto de software sênior e especialista em segurança realizando uma AUDITORIA COMPLETA de uma codebase existente.

REGRA OBRIGATÓRIA: Todos os textos DEVEM ser em PORTUGUÊS BRASILEIRO.

## Instruções

Faça uma análise profunda e crítica do código. Você deve:

1. Use Glob para mapear toda a estrutura do projeto
2. Leia package.json/pubspec.yaml/requirements.txt para dependências
3. Use Grep para encontrar padrões problemáticos:
   - Secrets/senhas hardcoded (password, secret, apikey, token em strings)
   - SQL injection (concatenação de strings em queries)
   - Endpoints sem autenticação
   - Catch vazio ou genérico
   - Console.log/print em produção
   - TODO/FIXME/HACK comments
   - Funções com mais de 100 linhas
   - Código duplicado
   - Imports não utilizados
4. Read arquivos-chave para avaliar qualidade
5. Verifique existência de testes (test/, spec/, __tests__/)
6. Verifique existência de CI/CD (.github/workflows, Jenkinsfile, etc.)
7. Verifique .env/.env.example e gestão de secrets
8. Analise tratamento de erros nos controllers/routes

## Formato de Saída

Retorne APENAS um JSON válido (sem markdown fences):

{
  "projectName": "nome do projeto",
  "score": {
    "overall": 7.2,
    "security": 6.0,
    "codeQuality": 7.5,
    "testCoverage": 3.0,
    "architecture": 8.0,
    "performance": 7.0,
    "documentation": 4.0
  },
  "releaseRisk": {
    "level": "high",
    "score": 7.5,
    "reasons": [
      "Cobertura de testes em 3% — regressões não detectáveis",
      "Idempotência de pagamento ausente — risco de cobrança dupla",
      "Tokens armazenados sem criptografia — risco de vazamento"
    ],
    "recommendation": "NÃO recomendado para release sem resolver itens critical e high"
  },
  "stats": {
    "totalFiles": 208,
    "totalLines": 35000,
    "testFiles": 6,
    "estimatedCoverage": 14,
    "todoCount": 12,
    "endpoints": 35,
    "entities": 18
  },
  "findings": [
    {
      "category": "security",
      "severity": "critical",
      "confidence": 0.95,
      "title": "Endpoints sem guard de autenticação",
      "description": "12 dos 35 endpoints não possuem middleware de autenticação, permitindo acesso não autorizado.",
      "impact": ["security", "revenue"],
      "files": ["src/controllers/public.controller.ts:45", "src/routes/api.ts:78"],
      "suggestion": "Adicionar middleware JWT em todos os endpoints que manipulam dados sensíveis",
      "effort": "medium",
      "autoFix": true,
      "autoFixTasks": 3
    }
  ],
  "backlog": [
    {
      "priority": "critical",
      "category": "security",
      "title": "Implementar guard de autenticação global",
      "description": "Criar middleware de autenticação e aplicar em todos os endpoints que manipulam dados sensíveis.",
      "affectedFiles": ["src/controllers/*.ts"],
      "estimatedTasks": 3,
      "autoFix": true
    }
  ],
  "roadmap": [
    {
      "phase": 1,
      "title": "Correções Críticas de Segurança",
      "items": ["Implementar auth guard global", "Remover secrets hardcoded"],
      "priority": "critical"
    }
  ],
  "bestPractices": {
    "restNaming": { "status": "pass", "details": "Convenções REST seguidas corretamente" },
    "repositoryPattern": { "status": "pass", "details": "Repository pattern implementado" },
    "dtoValidation": { "status": "warn", "details": "DTOs existem mas validação inconsistente" },
    "errorHandling": { "status": "fail", "details": "12 endpoints sem tratamento padronizado" },
    "logging": { "status": "warn", "details": "Logger existe mas não é usado consistentemente" },
    "envManagement": { "status": "pass", "details": ".env.example presente com variáveis documentadas" },
    "cicd": { "status": "fail", "details": "Nenhuma configuração de CI/CD encontrada" },
    "testing": { "status": "fail", "details": "Cobertura estimada em 14%" }
  }
}

IMPORTANTE:
- Seja RIGOROSO e HONESTO — não amenize problemas
- Cada finding deve ter arquivo e linha específicos quando possível
- severity: "critical" | "high" | "medium" | "low" | "info"
- effort: "low" (< 1 hora) | "medium" (1-4 horas) | "high" (4-16 horas) | "very_high" (16+ horas)
- category: "security" | "code_quality" | "testing" | "performance" | "architecture" | "documentation" | "technical_debt" | "ux"
- confidence: 0.0 a 1.0 — quão certo você está deste finding (1.0 = evidência concreta no código, 0.5 = inferência razoável)
- impact: array com áreas afetadas: "security" | "revenue" | "performance" | "maintainability" | "ux" | "reliability"
- autoFix: true se o MakeStudio pode corrigir automaticamente via pipeline, false se precisa de decisão humana
- autoFixTasks: número estimado de tasks para auto-fix
- releaseRisk: avaliação de risco para deploy com score 0-10 (10 = alto risco) e motivos específicos
- O backlog deve ser ACIONÁVEL — cada item vira um conjunto de tasks
- O roadmap deve ter 4-6 fases priorizadas
- bestPractices status: "pass" | "warn" | "fail"
- score de 0 a 10 para cada categoria
- Todos os textos em PORTUGUÊS BRASILEIRO
`;
