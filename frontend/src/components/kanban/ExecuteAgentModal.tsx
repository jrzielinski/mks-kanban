// flowbuilder/src/components/kanban/ExecuteAgentModal.tsx
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  ChevronDown,
  ChevronUp,
  Loader2,
  // @ts-ignore
  GitBranch,
  FolderGit2,
  Sparkles,
  Wand2,
  Code2,
  BarChart3,
  TestTube2,
  SearchCheck,
  PencilLine,
  Paintbrush2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  ExecType, KanbanBoardRepo,
  EXEC_TYPE_LABELS, EXEC_TYPE_EMOJIS,
  executeCard,
} from '@/services/kanbanAgent.service';

const EXEC_TYPES: ExecType[] = ['code', 'analysis', 'mockup', 'tests', 'review', 'custom'];

interface Props {
  cardId: string;
  repos: KanbanBoardRepo[];
  defaultExecType?: ExecType;
  defaultRepoId?: string;
  onClose: () => void;
  onExecuted: (execId: string) => void;
}

export const ExecuteAgentModal: React.FC<Props> = ({
  cardId, repos, defaultExecType, defaultRepoId, onClose, onExecuted,
}) => {
  const { t } = useTranslation('flow-builder');

  const [execType, setExecType] = useState<ExecType>(defaultExecType || 'analysis');
  const [repoId, setRepoId] = useState<string>(defaultRepoId || '');
  const selectedRepo = repos.find(r => r.id === repoId);
  const [branch, setBranch] = useState(selectedRepo?.defaultBranch || 'main');
  const [showPrompt, setShowPrompt] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');
  const [loading, setLoading] = useState(false);

  // Update branch when repo changes
  const handleRepoChange = (id: string) => {
    setRepoId(id);
    const repo = repos.find(r => r.id === id);
    if (repo) setBranch(repo.defaultBranch || 'main');
  };

  const handleExecute = async () => {
    setLoading(true);
    try {
      const result = await executeCard(cardId, {
        execType,
        repoId: repoId || undefined,
        branch: branch || undefined,
        customPrompt: customPrompt || undefined,
      });
      onExecuted(result.execId);
      onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Erro ao executar');
    } finally {
      setLoading(false);
    }
  };

  const execTypeDescriptions = useMemo<Record<ExecType, string>>(() => ({
    code: 'Implementa alterações no código com suporte a branch.',
    analysis: 'Analisa o contexto do card e devolve um diagnóstico estruturado.',
    mockup: 'Cria proposta visual ou protótipo para a demanda do card.',
    tests: 'Foca em cobertura, cenários de validação e testes automatizados.',
    review: 'Revisa o contexto técnico e aponta riscos, falhas e melhorias.',
    custom: 'Executa uma instrução livre escrita por você.',
  }), []);

  const execTypeIcons = useMemo<Record<ExecType, React.ReactNode>>(() => ({
    code: <Code2 className="h-4 w-4" />,
    analysis: <BarChart3 className="h-4 w-4" />,
    mockup: <Paintbrush2 className="h-4 w-4" />,
    tests: <TestTube2 className="h-4 w-4" />,
    review: <SearchCheck className="h-4 w-4" />,
    custom: <PencilLine className="h-4 w-4" />,
  }), []);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#dcdfe4] bg-white shadow-2xl xl:max-h-none dark:border-[#2e3541] dark:bg-[#1e2433]">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[#dcdfe4] px-6 py-5 dark:border-[#2e3541]">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e9efff] text-[#0c66e4] dark:bg-[#22324a] dark:text-blue-300">
                <Sparkles className="h-4.5 w-4.5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-[#172b4d] dark:text-white">Executar no Agente</h2>
                <p className="text-sm text-[#626f86] dark:text-gray-400">
                  Escolha como o agente deve atuar neste card e, se quiser, refine o contexto antes de disparar.
                </p>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-[#626f86] hover:bg-[#f1f2f4] dark:text-gray-400 dark:hover:bg-[#2e3541]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-6 xl:overflow-visible">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
            <div className="rounded-2xl border border-[#dcdfe4] bg-[#fbfcff] p-4 dark:border-[#2e3541] dark:bg-[#161b27]">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#626f86] dark:text-gray-400">
                    Tipo de execução
                  </div>
                  <p className="mt-1 text-sm text-[#626f86] dark:text-gray-400">
                    Defina a intenção principal antes de executar.
                  </p>
                </div>
                <span className="rounded-full bg-[#e9efff] px-2.5 py-1 text-[11px] font-semibold text-[#0c66e4] dark:bg-[#22324a] dark:text-blue-300">
                  {EXEC_TYPE_LABELS[execType]}
                </span>
              </div>

              <div className="grid gap-2 lg:grid-cols-2">
              {EXEC_TYPES.map(type => (
                <button
                  key={type}
                  onClick={() => setExecType(type)}
                  className={`group rounded-xl border px-3 py-3 text-left transition-all ${
                    execType === type
                      ? 'border-[#579dff] bg-[#f8fbff] text-[#0c66e4] shadow-[inset_0_0_0_1px_rgba(87,157,255,0.12)] dark:border-blue-500 dark:bg-blue-900/10 dark:text-blue-300'
                      : 'border-[#dcdfe4] bg-white text-[#44546f] hover:border-[#b6c2cf] hover:bg-[#fcfdff] dark:border-[#2e3541] dark:bg-[#1b2230] dark:text-gray-400 dark:hover:bg-[#232c3c]'
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex min-h-[24px] items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#626f86] dark:text-gray-500">
                        <div className={`shrink-0 ${
                          execType === type
                            ? 'text-[#0c66e4] dark:text-blue-300'
                            : 'text-[#626f86] dark:text-gray-300'
                        }`}>
                          {execTypeIcons[type]}
                        </div>
                        <div>
                          {EXEC_TYPE_LABELS[type]}
                        </div>
                      </div>
                      {execType === type && (
                        <span className="rounded-full bg-[#e9f2ff] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#0c66e4] dark:bg-[#22324a] dark:text-blue-300">
                          Ativo
                        </span>
                      )}
                    </div>
                    <p className="text-[13px] leading-6 text-[#626f86] transition-colors group-hover:text-[#44546f] dark:text-gray-400 dark:group-hover:text-gray-300">
                      {execTypeDescriptions[type]}
                    </p>
                  </div>
                </button>
              ))}
              </div>
            </div>

            <div className="space-y-4 rounded-2xl border border-[#dcdfe4] bg-white p-4 dark:border-[#2e3541] dark:bg-[#161b27]">
              <div className="flex items-center gap-2">
                <Wand2 className="h-4 w-4 text-[#0c66e4] dark:text-blue-300" />
                <div>
                  <div className="text-sm font-semibold text-[#172b4d] dark:text-white">{t('nodes.executeAgentModal.tsx.resumoDaExecucao')}</div>
                  <p className="text-xs text-[#626f86] dark:text-gray-400">
                    Revise o contexto antes de disparar o agente.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <div className="rounded-xl border border-[#dcdfe4] bg-[#fbfcff] px-3 py-2.5 dark:border-[#2e3541] dark:bg-[#1b2230]">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#626f86] dark:text-gray-500">
                    Tipo selecionado
                  </div>
                  <div className="mt-1 text-sm font-semibold text-[#172b4d] dark:text-white">
                    {EXEC_TYPE_EMOJIS[execType]} {EXEC_TYPE_LABELS[execType]}
                  </div>
                  <div className="mt-1 text-xs text-[#626f86] dark:text-gray-400">
                    {execTypeDescriptions[execType]}
                  </div>
                </div>

                <div className="rounded-xl border border-dashed border-[#c8d1e0] bg-white/70 px-3 py-3 dark:border-[#31405a] dark:bg-[#151b28]">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#626f86] dark:text-gray-500">
                    <FolderGit2 className="h-3.5 w-3.5" />
                    Contexto de código
                  </div>
                  <div className="mt-1 text-sm text-[#172b4d] dark:text-white">
                    {selectedRepo
                      ? `Vai usar ${selectedRepo.name}${repoId ? ` em ${branch || selectedRepo.defaultBranch || 'main'}` : ''}.`
                      : 'Esta execução será feita sem repositório vinculado.'}
                  </div>
                  <div className="mt-1 text-xs text-[#626f86] dark:text-gray-400">
                    {selectedRepo
                      ? 'Indicado para código, testes e revisão com contexto versionado.'
                      : 'Use para análise, mockup ou prompts que não dependem de branch e arquivos.'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-[#dcdfe4] bg-white p-4 dark:border-[#2e3541] dark:bg-[#161b27]">
              <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[#626f86] dark:text-gray-400">
                Repositório
              </label>
              <select
                value={repoId}
                onChange={e => handleRepoChange(e.target.value)}
                className="w-full rounded-xl border border-[#dcdfe4] bg-white px-3 py-2.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#2e3541] dark:bg-[#1b2230] dark:text-white"
              >
                <option value="">{t('nodes.executeAgentModal.tsx.semRepositorio')}</option>
                {repos.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-[#626f86] dark:text-gray-400">
                Use um repositório quando a execução precisar criar branch, revisar código ou alterar arquivos.
              </p>
            </div>

            <div className="rounded-2xl border border-[#dcdfe4] bg-white p-4 dark:border-[#2e3541] dark:bg-[#161b27]">
              <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[#626f86] dark:text-gray-400">
                Branch
              </label>
              <input
                value={branch}
                onChange={e => setBranch(e.target.value)}
                placeholder={repoId ? 'main' : 'Não aplicável sem repositório'}
                disabled={!repoId}
                className="w-full rounded-xl border border-[#dcdfe4] bg-white px-3 py-2.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] disabled:cursor-not-allowed disabled:bg-[#f7f8fa] disabled:text-[#9fadbc] dark:border-[#2e3541] dark:bg-[#1b2230] dark:text-white dark:disabled:bg-[#131824] dark:disabled:text-gray-500"
              />
              <p className="mt-2 text-xs text-[#626f86] dark:text-gray-400">
                {repoId
                  ? 'Defina a branch base ou de destino para a execução.'
                  : 'Selecione um repositório para editar a branch.'}
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#dcdfe4] bg-white p-4 dark:border-[#2e3541] dark:bg-[#161b27]">
            <button
              onClick={() => setShowPrompt(v => !v)}
              className="flex w-full items-center justify-between"
            >
              <div className="text-left">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#626f86] dark:text-gray-400">
                  Instrução adicional
                </div>
                <p className="mt-1 text-sm text-[#626f86] dark:text-gray-400">
                  Use apenas quando quiser sobrescrever ou complementar o prompt padrão da lista.
                </p>
              </div>
              <div className="rounded-lg bg-[#f1f2f4] p-1.5 text-[#626f86] dark:bg-[#2e3541] dark:text-gray-400">
                {showPrompt ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </div>
            </button>
            {showPrompt && (
              <textarea
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
                rows={5}
                placeholder={t('nodes.executeAgentModal.tsx.descrevaComClarezaOQueOAgenteDeveFazerQuaisRestricoesSeguirEQualResultadoVoceEsperaReceber_placeholder')}
                className="mt-3 w-full resize-none rounded-xl border border-[#dcdfe4] bg-white px-3 py-2.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#2e3541] dark:bg-[#1b2230] dark:text-white"
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#dcdfe4] bg-white px-6 py-4 dark:border-[#2e3541] dark:bg-[#1e2433]">
          <div className="text-xs text-[#626f86] dark:text-gray-400">
            O agente executará a ação no contexto do card atual.
          </div>
          <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[#44546f] hover:bg-[#f1f2f4] dark:text-gray-400 dark:hover:bg-[#2e3541]"
          >
            Cancelar
          </button>
          <button
            onClick={handleExecute}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg bg-[#0c66e4] px-4 py-2 text-sm font-medium text-white hover:bg-[#0055cc] disabled:opacity-60"
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Executar
          </button>
          </div>
        </div>
      </div>
    </div>
  );
};
