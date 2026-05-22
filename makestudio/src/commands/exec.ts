import { getApiClient } from '../network/api-client';
import { ensureAuthenticated } from '../network/auth';
import { logInfo, logSuccess, logError, logWarning } from '../ui/terminal';

export async function execCommand(taskId: string): Promise<void> {
  try {
    await ensureAuthenticated();
    const api = getApiClient();

    logInfo(`Despachando task ${taskId} para agent local...`);

    const { data } = await api.post(`/dark-factory/agents/dispatch/${taskId}`);

    if (data.error) {
      logError(data.error);
      return;
    }

    logSuccess(`Task despachada! Job ID: ${data.jobId}`);
    logInfo('O agent local conectado receberá a task automaticamente.');
    logInfo(`Acompanhe: makestudio status`);
  } catch (err: any) {
    logError(err?.response?.data?.message || err.message);
  }
}
