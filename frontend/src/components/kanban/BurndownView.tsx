// flowbuilder/src/components/kanban/BurndownView.tsx
import React, { useState, useEffect } from 'react';
import {
  // @ts-ignore
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, Area, ComposedChart,
} from 'recharts';
import { TrendingDown, RefreshCw, Calendar, Target, Zap, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import kanbanService, { BurndownChartData } from '@/services/kanban.service';
import { useTranslation } from 'react-i18next';

interface Props {
  boardId: string;
}

export const BurndownView: React.FC<Props> = ({
  boardId,
}) => {
  const { t } = useTranslation('flow-builder');
  const [data, setData] = useState<BurndownChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await kanbanService.getBurndownData(boardId);
      setData(result);
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = (status === 404 || status === 400)
        ? 'Burndown power-up não está habilitado para este board.'
        : (err?.response?.data?.message || 'Erro ao carregar dados do Burndown Chart.');
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [boardId]);

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#0c66e4]" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-3">
        <TrendingDown className="h-8 w-8 opacity-40 text-[#8590a2] dark:text-gray-500" />
        <p className="text-sm font-medium text-[#626f86] dark:text-gray-400">{error || 'Nenhum dado disponível'}</p>
        <p className="text-xs text-[#8590a2] dark:text-gray-500 max-w-md text-center">
          Para usar o Burndown Chart, instale o power-up "Burndown Chart" nas configurações do board e defina as listas de conclusão e duração do sprint.
        </p>
      </div>
    );
  }

  const chartData = data.dataPoints
    .filter((p) => p.actual >= 0)
    .map((p) => ({
      ...p,
      date: new Date(p.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
    }));

  const futureData = data.dataPoints
    .filter((p) => p.actual < 0)
    .map((p) => ({
      date: new Date(p.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      ideal: p.ideal,
    }));

  const allChartData = [
    ...chartData,
    ...futureData.map((f) => ({ ...f, actual: undefined, completed: undefined, added: undefined })),
  ];

  const handleNewSprint = async () => {
    try {
      await kanbanService.startNewSprint(boardId);
      toast.success('Novo sprint iniciado!');
      loadData();
    } catch {
      toast.error('Erro ao iniciar novo sprint');
    }
  };

  const progressPercent = data.totalScope > 0
    ? Math.round((data.completedCount / data.totalScope) * 100)
    : 0;

  return (
    <div className="space-y-6 p-4">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
        <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 dark:bg-blue-900/30">
            <Target className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-[#172b4d] dark:text-white">{data.totalScope}</p>
            <p className="text-xs text-[#626f86] dark:text-gray-400">Escopo total</p>
          </div>
        </div>

        <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-green-50 dark:bg-green-900/30">
            <TrendingDown className="h-5 w-5 text-green-600 dark:text-green-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-[#172b4d] dark:text-white">{data.completedCount}</p>
            <p className="text-xs text-[#626f86] dark:text-gray-400">{t('nodes.burndownView.tsx.concluidos')}</p>
          </div>
        </div>

        <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-orange-50 dark:bg-orange-900/30">
            <Calendar className="h-5 w-5 text-orange-600 dark:text-orange-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-[#172b4d] dark:text-white">{data.remainingCount}</p>
            <p className="text-xs text-[#626f86] dark:text-gray-400">Restantes</p>
          </div>
        </div>

        <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-purple-50 dark:bg-purple-900/30">
            <Zap className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-[#172b4d] dark:text-white">{data.velocity}/dia</p>
            <p className="text-xs text-[#626f86] dark:text-gray-400">Velocidade</p>
          </div>
        </div>

        <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center">
            <svg viewBox="0 0 36 36" className="h-11 w-11 -rotate-90">
              <path d="M18 2.0845a 15.9155 15.9155 0 0 1 0 31.831a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e5e7eb" strokeWidth="3" className="dark:stroke-gray-700" />
              <path d="M18 2.0845a 15.9155 15.9155 0 0 1 0 31.831a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#22c55e" strokeWidth="3" strokeDasharray={`${progressPercent}, 100`} />
            </svg>
          </div>
          <div>
            <p className="text-2xl font-bold text-[#172b4d] dark:text-white">{progressPercent}%</p>
            <p className="text-xs text-[#626f86] dark:text-gray-400">
              {data.projectedEndDate ? `Previsão: ${new Date(data.projectedEndDate).toLocaleDateString('pt-BR')}` : 'Progresso'}
            </p>
          </div>
        </div>
      </div>

      {/* Sprint info + actions */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-[#626f86] dark:text-gray-400">
          Sprint: <span className="font-medium">{new Date(data.sprintStartDate).toLocaleDateString('pt-BR')}</span> → <span className="font-medium">{new Date(data.sprintEndDate).toLocaleDateString('pt-BR')}</span>
        </div>
        <div className="flex gap-2">
          <button onClick={loadData} className="flex items-center gap-1 rounded-lg border border-[#cfd3d8] px-3 py-1.5 text-xs text-[#44546f] hover:bg-slate-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700">
            <RefreshCw className="h-3 w-3" /> Atualizar
          </button>
          <button onClick={handleNewSprint} className="flex items-center gap-1 rounded-lg bg-[#0c66e4] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0055cc]">
            Novo Sprint
          </button>
        </div>
      </div>

      {/* Burndown Chart */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-4 text-sm font-semibold text-[#172b4d] dark:text-white">Burndown Chart</h3>
        <ResponsiveContainer width="100%" height={400}>
          <ComposedChart data={allChartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#626f86' }} />
            <YAxis tick={{ fontSize: 11, fill: '#626f86' }} />
            <Tooltip
              contentStyle={{
                backgroundColor: 'white',
                border: '1px solid #e5e7eb',
                borderRadius: '12px',
                fontSize: '12px',
              }}
              // @ts-ignore
              formatter={(value: any, name: string) => {
                const labels: Record<string, string> = {
                  ideal: 'Ideal',
                  actual: 'Real',
                  completed: 'Concluídos (acum.)',
                  added: 'Adicionados (acum.)',
                };
                return [value, labels[name] || name];
              }}
            />
            <Legend
              formatter={(value: string) => {
                const labels: Record<string, string> = {
                  ideal: 'Linha Ideal',
                  actual: 'Progresso Real',
                  completed: 'Concluídos',
                };
                return labels[value] || value;
              }}
              wrapperStyle={{ fontSize: '12px' }}
            />
            <Line type="monotone" dataKey="ideal" stroke="#8590a2" strokeDasharray="5 5" strokeWidth={2} dot={false} name="ideal" />
            <Line type="monotone" dataKey="actual" stroke="#0c66e4" strokeWidth={2.5} dot={{ r: 3, fill: '#0c66e4' }} name="actual" connectNulls={false} />
            <Area type="monotone" dataKey="completed" fill="#4bce9720" stroke="#4bce97" strokeWidth={1} name="completed" />
            {data.remainingCount <= 0 && (
              <ReferenceLine y={0} stroke="#22c55e" strokeWidth={2} label={{ value: 'Concluído!', position: 'right', fill: '#22c55e', fontSize: 12 }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
