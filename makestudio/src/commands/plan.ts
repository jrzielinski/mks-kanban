import { ensureAuthenticated } from '../network/auth';
import { getApiClient } from '../network/api-client';
import { logInfo, logSuccess, logError, logWarning } from '../ui/terminal';
import chalk from 'chalk';

export async function planCommand(
  description: string,
  options: { projectId?: string },
): Promise<void> {
  if (!description?.trim()) {
    logError('Informe a descrição da feature. Ex: makestudio plan "Adicionar campo telefone no cadastro"');
    process.exit(1);
  }

  let token: string;
  try {
    token = await ensureAuthenticated();
  } catch (err: any) {
    logError(err.message);
    process.exit(1);
  }

  const api = getApiClient();

  // Resolve project ID
  let projectId = options.projectId;

  if (!projectId) {
    // Try to find the most recent project (or one matching current directory)
    logInfo('Buscando projeto mais recente...');
    try {
      const res = await api.get('/dark-factory/projects');
      const projects = Array.isArray(res.data) ? res.data : res.data?.data || [];

      if (projects.length === 0) {
        logError('Nenhum projeto encontrado. Crie um com: makestudio analyze');
        process.exit(1);
      }

      // Try to match by localPath (current directory)
      const cwd = process.cwd();
      const matchByPath = projects.find(
        (p: any) => p.metadata?.localPath === cwd || p.metadata?.codebaseAnalysis,
      );

      if (matchByPath) {
        projectId = matchByPath.id;
        logInfo(`Projeto encontrado: ${chalk.bold(matchByPath.name)} (${matchByPath.id.slice(0, 8)})`);
      } else {
        // Use most recent
        const sorted = projects.sort(
          (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        projectId = sorted[0].id;
        logInfo(`Usando projeto mais recente: ${chalk.bold(sorted[0].name)} (${sorted[0].id.slice(0, 8)})`);
      }
    } catch (err: any) {
      logError(`Falha ao buscar projetos: ${err.message}`);
      process.exit(1);
    }
  }

  console.log();
  logInfo(`Enviando plano para o projeto ${chalk.bold(projectId!.slice(0, 8))}...`);
  logInfo(`Descrição: ${chalk.italic(description.trim())}`);
  console.log();

  try {
    logInfo('Disparando pipeline completo:');
    logInfo(`  1. ${chalk.cyan('Análise autônoma')} — gerar requisitos a partir do pedido + conhecimento do código`);
    logInfo(`  2. ${chalk.cyan('Criação do D.U.M')} — documento de unidade de trabalho`);
    logInfo(`  3. ${chalk.cyan('Decomposição')} — quebrar em tasks executáveis`);
    logInfo(`  4. ${chalk.cyan('Dispatch')} — enviar tasks pro agent local executar`);
    console.log();

    const res = await api.post(`/dark-factory/projects/${projectId}/plan`, {
      description: description.trim(),
    }, {
      timeout: 6 * 60 * 60 * 1000, // 6h — pipeline can take hours
    });

    const data = res.data;

    if (data.success) {
      console.log();
      logSuccess(chalk.bold('Pipeline disparado com sucesso!'));
      logInfo(data.message || 'Análise → Requisitos → DUM → Decomposição → Tasks');

      if (data.requirementsGenerated) {
        logInfo(`Requisitos gerados: ${data.requirementsGenerated}`);
      }
      if (data.cost) {
        logInfo(`Custo da análise: $${data.cost.toFixed(4)}`);
      }

      console.log();
      logInfo('O pipeline continua em background no servidor.');
      logInfo('Acompanhe no frontend ou mantenha o agent conectado:');
      logInfo(chalk.gray(`  makestudio start`));
      console.log();
    } else {
      logError(`Falha: ${data.message || 'Erro desconhecido'}`);
    }
  } catch (err: any) {
    const msg = err.response?.data?.message || err.message;
    logError(`Falha ao executar plano: ${msg}`);
    process.exit(1);
  }
}
