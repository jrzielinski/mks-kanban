// flowbuilder/src/pages/KanbanBoardsPage.tsx
import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
// @ts-ignore
import { Plus, LayoutGrid, Trash2, X, Star, Globe, Lock, Users, FolderOpen, ChevronDown, ChevronRight, LayoutTemplate, Gauge, AlertTriangle, Calendar, TrendingUp, BarChart2, CheckSquare, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';
import kanbanService, { KanbanBoard, KanbanList } from '@/services/kanban.service';
import { useConfirm } from '@/hooks/useConfirm';

const BOARD_COLORS = [
  '#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444',
  '#06b6d4','#ec4899','#84cc16','#f97316','#6366f1',
];

const WS_COLORS = ['#6366f1','#8b5cf6','#3b82f6','#10b981','#f59e0b','#ef4444','#ec4899'];

interface Workspace { id: string; name: string; color: string; tenantId: string; }
// @ts-ignore
interface BoardWithStar extends KanbanBoard { isStarred?: boolean; workspaceId?: string | null; visibility?: 'private'|'workspace'|'public'; isTemplate?: boolean; }

const VisibilityIcon: React.FC<{ visibility?: string }> = ({ visibility }) => {
  const { t } = useTranslation('common');
  // @ts-ignore
  if (visibility === 'public') return <Globe className="w-3 h-3 text-white/70" title={t('kanbanBoardsPage.visibility.public')} />;
  // @ts-ignore
  if (visibility === 'workspace') return <Users className="w-3 h-3 text-white/70" title={t('kanbanBoardsPage.visibility.workspace')} />;
  // @ts-ignore
  return <Lock className="w-3 h-3 text-white/70" title={t('kanbanBoardsPage.visibility.private')} />;
};

const SemiGauge: React.FC<{ value: number; label: string }> = ({ value, label }) => {
  const { t } = useTranslation('common');
  const R = 46, cx = 60, cy = 63;
  const arcLen = Math.PI * R;
  const valLen = (value / 100) * arcLen;
  const color = value >= 80 ? '#10b981' : value >= 60 ? '#3b82f6' : value >= 30 ? '#f59e0b' : '#ef4444';
  const rating = value >= 80 ? t('kanbanBoardsPage.gauge.great') : value >= 60 ? t('kanbanBoardsPage.gauge.good') : value >= 30 ? t('kanbanBoardsPage.gauge.fair') : t('kanbanBoardsPage.gauge.critical');
  return (
    <div className="flex flex-col items-center">
      <p className="text-[10px] font-bold text-[#1e3a5f] dark:text-slate-300 uppercase tracking-wide text-center leading-tight mb-0.5">{label}</p>
      <svg viewBox="0 0 120 82" className="w-full max-w-[130px]">
        <path d={`M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`} fill="none" stroke="#cbd5e1" strokeWidth="9" strokeLinecap="round" />
        <path d={`M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${valLen} ${arcLen + 20}`} />
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="15" fontWeight="900" fill="#1e3a5f">{value}%</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="9" fontWeight="700" fill={color}>{rating}</text>
        <text x={cx - R} y={cy + 14} textAnchor="start" fontSize="7" fill="#94a3b8">{t('kanbanBoardsPage.gauge.poor')}</text>
        <text x={cx + R} y={cy + 14} textAnchor="end" fontSize="7" fill="#94a3b8">{t('kanbanBoardsPage.gauge.great')}</text>
      </svg>
    </div>
  );
};

export const KanbanBoardsPage: React.FC = () => {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { confirm } = useConfirm();
  const [boards, setBoards] = useState<BoardWithStar[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [templates, setTemplates] = useState<KanbanBoard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createTab, setCreateTab] = useState<'blank'|'template'>('blank');
  const [newTitle, setNewTitle] = useState('');
  const [newColor, setNewColor] = useState(BOARD_COLORS[0]);
  const [newWorkspaceId, setNewWorkspaceId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set());

  // Workspace create
  const [showCreateWs, setShowCreateWs] = useState(false);
  const [wsName, setWsName] = useState('');
  const [wsColor, setWsColor] = useState(WS_COLORS[0]);
  const [creatingWs, setCreatingWs] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setIsLoading(true);
    try {
      const [b, ws, tmpl] = await Promise.all([
        kanbanService.listBoards(),
        kanbanService.listWorkspaces(),
        kanbanService.listTemplates(),
      ]);
      setBoards(b as BoardWithStar[]);
      setWorkspaces(ws);
      setTemplates(tmpl);
    } catch { toast.error(t('kanbanBoardsPage.toasts.loadBoardsError')); }
    finally { setIsLoading(false); }
  };

  const starredBoards = useMemo(() => boards.filter((b) => b.isStarred), [boards]);
  const noWorkspaceBoards = useMemo(() => boards.filter((b) => !b.workspaceId), [boards]);
  const boardsByWorkspace = useMemo(() => {
    const map = new Map<string, BoardWithStar[]>();
    for (const ws of workspaces) map.set(ws.id, []);
    for (const b of boards) {
      if (b.workspaceId && map.has(b.workspaceId)) {
        map.get(b.workspaceId)!.push(b);
      }
    }
    return map;
  }, [boards, workspaces]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const board = await kanbanService.createBoard({
        title: newTitle.trim(),
        color: newColor,
        // @ts-ignore
        workspaceId: newWorkspaceId || undefined,
      });
      setBoards((p) => [board as BoardWithStar, ...p]);
      setShowCreate(false);
      setNewTitle('');
      navigate(`/kanban/${(board as any).slug ?? board.id}`);
    } catch { toast.error(t('kanbanBoardsPage.toasts.createBoardError')); }
    finally { setCreating(false); }
  };

  const handleCreateFromTemplate = async (templateId: string) => {
    if (!newTitle.trim()) { toast.error(t('kanbanBoardsPage.toasts.enterBoardName')); return; }
    setCreating(true);
    try {
      const board = await kanbanService.createBoard({
        title: newTitle.trim(),
        color: newColor,
        // @ts-ignore
        templateId,
        workspaceId: newWorkspaceId || undefined,
      });
      setBoards((p) => [board as BoardWithStar, ...p]);
      setShowCreate(false);
      setNewTitle('');
      navigate(`/kanban/${(board as any).slug ?? board.id}`);
    } catch { toast.error(t('kanbanBoardsPage.toasts.createBoardError')); }
    finally { setCreating(false); }
  };

  // Paleta default — cobre os tons mais usados em board apps.
  // O modal aceita também cor custom via input hex/color picker nativo.
  const BOARD_COLOR_PRESETS = [
    '#0c66e4', // azul (default)
    '#8b5cf6', // roxo
    '#ec4899', // rosa
    '#ef4444', // vermelho
    '#f97316', // laranja
    '#f59e0b', // amarelo
    '#22c55e', // verde
    '#14b8a6', // teal
    '#06b6d4', // ciano
    '#475569', // cinza-azulado
    '#1e293b', // grafite
  ];

  const [editTarget, setEditTarget] = useState<{ id: string; title: string; color: string } | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editColor, setEditColor] = useState('#0c66e4');

  const openEdit = (e: React.MouseEvent, board: BoardWithStar) => {
    e.stopPropagation();
    setEditTarget({ id: board.id, title: board.title, color: board.color || '#0c66e4' });
    setEditTitle(board.title);
    setEditColor(board.color || '#0c66e4');
  };

  const commitEdit = async () => {
    if (!editTarget) return;
    const newTitle = editTitle.trim();
    const titleChanged = !!newTitle && newTitle !== editTarget.title;
    const colorChanged = editColor !== editTarget.color;
    if (!titleChanged && !colorChanged) {
      setEditTarget(null);
      return;
    }
    if (!newTitle) {
      toast.error('Nome do board não pode ser vazio');
      return;
    }
    try {
      const patch: Partial<BoardWithStar> = {};
      if (titleChanged) patch.title = newTitle;
      if (colorChanged) patch.color = editColor;
      const updated = await kanbanService.updateBoard(editTarget.id, patch);
      setBoards((p) => p.map((b) => b.id === editTarget.id ? { ...b, ...updated } : b));
      toast.success('Board atualizado');
    } catch {
      toast.error('Falha ao atualizar board');
    } finally {
      setEditTarget(null);
    }
  };

  const handleDelete = async (e: React.MouseEvent, boardId: string, boardTitle: string) => {
    e.stopPropagation();
    const ok = await confirm({ title: t('kanbanBoardsPage.confirm.removeBoardTitle'), message: t('kanbanBoardsPage.confirm.removeBoardMessage', { title: boardTitle }), type: 'danger', typeToConfirm: boardTitle });
    if (!ok) return;
    try {
      await kanbanService.deleteBoard(boardId);
      setBoards((p) => p.filter((b) => b.id !== boardId));
      toast.success(t('kanbanBoardsPage.toasts.boardRemoved'));
    } catch { toast.error(t('kanbanBoardsPage.toasts.removeBoardError')); }
  };

  const handleStar = async (e: React.MouseEvent, board: BoardWithStar) => {
    e.stopPropagation();
    try {
      if (board.isStarred) {
        await kanbanService.unstarBoard(board.id);
      } else {
        await kanbanService.starBoard(board.id);
      }
      setBoards((p) => p.map((b) => b.id === board.id ? { ...b, isStarred: !b.isStarred } : b));
    } catch { toast.error(t('kanbanBoardsPage.toasts.favoriteError')); }
  };

  const handleCreateWorkspace = async () => {
    if (!wsName.trim()) return;
    setCreatingWs(true);
    try {
      const ws = await kanbanService.createWorkspace({ name: wsName.trim(), color: wsColor });
      setWorkspaces((p) => [...p, ws]);
      setShowCreateWs(false);
      setWsName('');
      toast.success(t('kanbanBoardsPage.toasts.workspaceCreated'));
    } catch { toast.error(t('kanbanBoardsPage.toasts.createWorkspaceError')); }
    finally { setCreatingWs(false); }
  };

  const handleDeleteWorkspace = async (wsId: string, wsName: string) => {
    const ok = await confirm({ title: t('kanbanBoardsPage.confirm.removeWorkspaceTitle'), message: t('kanbanBoardsPage.confirm.removeWorkspaceMessage', { name: wsName }) });
    if (!ok) return;
    try {
      await kanbanService.deleteWorkspace(wsId);
      setWorkspaces((p) => p.filter((w) => w.id !== wsId));
      setBoards((p) => p.map((b) => b.workspaceId === wsId ? { ...b, workspaceId: null } : b));
      toast.success(t('kanbanBoardsPage.toasts.workspaceRemoved'));
    } catch { toast.error(t('kanbanBoardsPage.toasts.removeWorkspaceError')); }
  };

  // Multi-board dashboard
  const [showDashboard, setShowDashboard] = useState(false);
  const [dashboardData, setDashboardData] = useState<{ boardTitle: string; boardColor: string; lists: KanbanList[] }[]>([]);
  const [loadingDashboard, setLoadingDashboard] = useState(false);

  const loadDashboard = async () => {
    setShowDashboard(true);
    setLoadingDashboard(true);
    try {
      const results = await Promise.all(boards.map(async (b) => {
        const full = await kanbanService.getBoard(b.id);
        return { boardTitle: b.title, boardColor: b.color, lists: full.lists ?? [] };
      }));
      setDashboardData(results);
    } catch { toast.error(t('kanbanBoardsPage.toasts.loadDashboardError')); }
    finally { setLoadingDashboard(false); }
  };

  const dashboardStats = useMemo(() => {
    if (dashboardData.length === 0) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 86400000);

    const doneKw = ['done', 'concluí', 'finaliz', 'feito', 'feita', 'complet', 'entregue', 'aprovad', 'encerr'];
    const ipKw = ['andamento', 'progress', 'fazendo', 'doing', 'execuç', 'working', 'review', 'revisão', 'teste'];
    const isDone = (t: string) => doneKw.some(k => t.toLowerCase().includes(k));
    const isInProgress = (t: string) => ipKw.some(k => t.toLowerCase().includes(k));

    let totalCards = 0, overdueCards = 0, dueToday = 0, doneItems = 0, totalItems = 0, recentCards = 0;
    let doneCards = 0, inProgressCards = 0;

    const byBoard: {
      title: string; color: string; total: number; overdue: number;
      done: number; inProgress: number; checklistDone: number; checklistTotal: number;
    }[] = [];

    for (const bd of dashboardData) {
      let bTotal = 0, bOver = 0, bDone = 0, bIP = 0, bCkDone = 0, bCkTotal = 0;
      for (const list of bd.lists) {
        const lDone = isDone(list.title);
        const lIP = isInProgress(list.title);
        for (const card of list.cards) {
          totalCards++; bTotal++;
          if (lDone) { doneCards++; bDone++; }
          else if (lIP) { inProgressCards++; bIP++; }
          if (card.dueDate) {
            const d = new Date(card.dueDate);
            const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            if (dDay < today) { overdueCards++; bOver++; }
            if (dDay.getTime() === today.getTime()) dueToday++;
          }
          const items = card.checklists?.flatMap((g: any) => g.items) ?? card.checklist ?? [];
          const itemDone = (items as any[]).filter(i => i.done).length;
          doneItems += itemDone; bCkDone += itemDone;
          totalItems += items.length; bCkTotal += items.length;
          if (card.createdAt && new Date(card.createdAt) >= weekAgo) recentCards++;
        }
      }
      byBoard.push({ title: bd.boardTitle, color: bd.boardColor, total: bTotal, overdue: bOver, done: bDone, inProgress: bIP, checklistDone: bCkDone, checklistTotal: bCkTotal });
    }

    const checklistPct = totalItems > 0 ? Math.round(doneItems / totalItems * 100) : 0;
    const completionRate = totalCards > 0 ? Math.round(doneCards / totalCards * 100) : 0;
    const punctualityRate = totalCards > 0 ? Math.round((totalCards - overdueCards) / totalCards * 100) : 100;
    const activityRate = Math.min(100, totalCards > 0 ? Math.round((recentCards / totalCards) * 200) : 0);
    const backlogCards = totalCards - doneCards - inProgressCards;

    const enriched = byBoard.map(b => ({
      ...b,
      score: b.total > 0 ? Math.round((b.done / b.total) * 100) - Math.round((b.overdue / b.total) * 30) : 0,
      completionPct: b.total > 0 ? Math.round(b.done / b.total * 100) : 0,
      checklistPct: b.checklistTotal > 0 ? Math.round(b.checklistDone / b.checklistTotal * 100) : 0,
    }));

    return {
      totalCards, overdueCards, dueToday, recentCards, checklistPct, doneItems, totalItems,
      doneCards, inProgressCards, backlogCards,
      completionRate, punctualityRate, activityRate,
      byBoard: enriched,
      rankedBoards: [...enriched].sort((a, b) => b.score - a.score),
    };
  }, [dashboardData]);

  const toggleCollapse = (wsId: string) => {
    setCollapsedWs((prev) => {
      const next = new Set(prev);
      next.has(wsId) ? next.delete(wsId) : next.add(wsId);
      return next;
    });
  };

  const BoardCard: React.FC<{ board: BoardWithStar }> = ({ board }) => (
    <div
      key={board.id}
      onClick={() => navigate(`/kanban/${(board as any).slug ?? board.id}`)}
      className="relative group cursor-pointer rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all h-28"
      style={{ background: `linear-gradient(135deg, ${board.color}dd, ${board.color}99)` }}
    >
      {board.backgroundImage && (
        <div className="absolute inset-0 bg-cover bg-center opacity-30" style={{ backgroundImage: `url(${board.backgroundImage})` }} />
      )}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-all" />
      <div className="relative p-3 h-full flex flex-col justify-between">
        <p className="font-bold text-white text-sm leading-snug line-clamp-2">{board.title}</p>
        <div className="flex items-center justify-between">
          <VisibilityIcon visibility={board.visibility} />
          <div className="flex gap-1">
            <button
              onClick={(e) => handleStar(e, board)}
              className={`p-1 rounded transition-opacity ${board.isStarred ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              title="Favoritar"
            >
              <Star className={`w-3.5 h-3.5 ${board.isStarred ? 'fill-yellow-300 text-yellow-300' : 'text-white'}`} />
            </button>
            <button
              onClick={(e) => openEdit(e, board)}
              className="p-1 rounded bg-black/20 hover:bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity"
              title="Renomear / mudar cor"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => handleDelete(e, board.id, board.title)}
              className="p-1 rounded bg-black/20 hover:bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity"
              title="Apagar"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const AddTile: React.FC = () => (
    <div
      onClick={() => setShowCreate(true)}
      className="cursor-pointer rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all h-28 flex flex-col items-center justify-center gap-2 text-gray-400 hover:text-blue-500"
    >
      <Plus className="w-5 h-5" />
      <span className="text-xs font-medium">{t('kanbanBoardsPage.actions.newBoard')}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <LayoutGrid className="w-7 h-7 text-blue-500" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('kanbanBoardsPage.labels.pageTitle')}</h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={showDashboard ? () => setShowDashboard(false) : () => void loadDashboard()}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${showDashboard ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300'}`}
            >
              <Gauge className="w-4 h-4" /> {t('kanbanBoardsPage.actions.dashboard')}
            </button>
            <button
              onClick={() => setShowCreateWs(true)}
              className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium transition-colors"
            >
              <FolderOpen className="w-4 h-4" /> {t('kanbanBoardsPage.actions.newWorkspace')}
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              <Plus className="w-4 h-4" /> {t('kanbanBoardsPage.actions.newBoard')}
            </button>
          </div>
        </div>

        {/* Multi-board Dashboard */}
        {showDashboard && (
          <div className="mb-8 rounded-xl overflow-hidden border border-slate-300 dark:border-gray-600 shadow-2xl">
            {loadingDashboard ? (
              <div className="flex items-center justify-center h-48" style={{ background: 'linear-gradient(135deg, #0a1f3d, #1e3a5f)' }}>
                <div className="flex flex-col items-center gap-3">
                  <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-white" />
                  <p className="text-white text-sm font-medium tracking-wide">{t('kanbanBoardsPage.loading.dashboard')}</p>
                </div>
              </div>
            ) : dashboardStats ? (
              <div>
                {/* ── HEADER BANNER ─────────────────────────────────────────── */}
                <div style={{ background: 'linear-gradient(90deg, #080f1e 0%, #0f2744 30%, #1e3a5f 50%, #0f2744 70%, #080f1e 100%)' }} className="py-2.5 px-5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Gauge className="w-5 h-5 text-blue-400" />
                    <h2 className="text-base font-black text-white tracking-[0.25em] uppercase">{t('kanbanBoardsPage.dashboard.title')}</h2>
                  </div>
                  <p className="text-[11px] text-blue-300 font-medium hidden sm:block">
                    {new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                  </p>
                  <button onClick={() => setShowDashboard(false)} className="text-blue-400 hover:text-white transition-colors p-1">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* ── KPI STRIP ─────────────────────────────────────────────── */}
                <div style={{ background: 'linear-gradient(180deg, #0f2744 0%, #162f54 100%)' }} className="grid grid-cols-5 divide-x divide-white/10">
                  {[
                    { label: t('kanbanBoardsPage.dashboard.totalCards'), value: dashboardStats.totalCards, sub: t('kanbanBoardsPage.dashboard.inBoards', { count: dashboardData.length }), icon: BarChart2, warn: false },
                    { label: t('kanbanBoardsPage.dashboard.activeBoards'), value: dashboardData.length, sub: t('kanbanBoardsPage.dashboard.withActivity', { count: dashboardStats.byBoard.filter(b => b.total > 0).length }), icon: LayoutGrid, warn: false },
                    { label: t('kanbanBoardsPage.dashboard.overdue'), value: dashboardStats.overdueCards, sub: t('kanbanBoardsPage.dashboard.ofTotal', { percent: dashboardStats.totalCards > 0 ? Math.round(dashboardStats.overdueCards / dashboardStats.totalCards * 100) : 0 }), icon: AlertTriangle, warn: dashboardStats.overdueCards > 0 },
                    { label: t('kanbanBoardsPage.dashboard.completion'), value: `${dashboardStats.completionRate}%`, sub: t('kanbanBoardsPage.dashboard.completed', { count: dashboardStats.doneCards }), icon: CheckSquare, warn: false },
                    { label: t('kanbanBoardsPage.dashboard.activeWeek'), value: dashboardStats.recentCards, sub: t('kanbanBoardsPage.dashboard.newThisWeek'), icon: TrendingUp, warn: false },
                  ].map((s, i) => {
                    const Icon = s.icon;
                    return (
                      <div key={i} className="px-4 py-3">
                        <div className="flex items-start justify-between mb-1">
                          <p className="text-[9px] font-bold text-blue-200 uppercase tracking-widest leading-tight">{s.label}</p>
                          <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${s.warn ? 'text-red-300' : 'text-blue-400'}`} />
                        </div>
                        <p className={`text-2xl font-black leading-none ${s.warn && dashboardStats.overdueCards > 0 ? 'text-red-300' : 'text-white'}`}>{s.value}</p>
                        <p className="text-[10px] text-blue-300 mt-1">{s.sub}</p>
                      </div>
                    );
                  })}
                </div>

                {/* separator */}
                <div className="h-[3px]" style={{ background: 'linear-gradient(90deg, #0f2744, #3b82f6 30%, #60a5fa 50%, #3b82f6 70%, #0f2744)' }} />

                {/* ── GAUGES ROW ─────────────────────────────────────────────── */}
                <div className="bg-[#e8eef5] dark:bg-gray-850 dark:bg-gray-800 p-4">
                  <div className="grid grid-cols-6 gap-3 items-center">
                    <SemiGauge value={dashboardStats.checklistPct} label={t('kanbanBoardsPage.dashboard.checklistEfficiency')} />
                    <SemiGauge value={dashboardStats.completionRate} label={t('kanbanBoardsPage.dashboard.completionRate')} />
                    <SemiGauge value={dashboardStats.punctualityRate} label={t('kanbanBoardsPage.dashboard.punctuality')} />
                    <SemiGauge value={dashboardStats.activityRate} label={t('kanbanBoardsPage.dashboard.activityWeek')} />

                    {/* Mini bar chart */}
                    <div className="bg-white dark:bg-gray-700 rounded-lg p-3 h-full flex flex-col">
                      <p className="text-[9px] font-bold text-[#1e3a5f] dark:text-gray-200 uppercase tracking-wide mb-2">{t('kanbanBoardsPage.dashboard.volumeByBoard')}</p>
                      <div className="flex-1 flex items-end gap-1 min-h-[56px]">
                        {(() => {
                          const sorted = dashboardStats.byBoard.slice().sort((a, b) => b.total - a.total).slice(0, 7);
                          const mx = Math.max(...sorted.map(x => x.total), 1);
                          return sorted.map((b, i) => (
                            <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={b.title}>
                              <div className="w-full rounded-t-sm transition-all" style={{ height: `${Math.max((b.total / mx) * 52, 4)}px`, backgroundColor: b.color }} />
                              <p className="text-[7px] text-gray-400">{b.total}</p>
                            </div>
                          ));
                        })()}
                      </div>
                    </div>

                    {/* Big highlight number */}
                    <div className="bg-white dark:bg-gray-700 rounded-lg p-3 flex flex-col items-center justify-center h-full gap-1">
                      <CheckSquare className="w-5 h-5 text-green-500" />
                      <p className="text-3xl font-black text-[#1e3a5f] dark:text-white leading-none">{dashboardStats.doneCards}</p>
                      <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 text-center" dangerouslySetInnerHTML={{ __html: t('kanbanBoardsPage.dashboard.cardsDone').replace('\n', '<br />') }} />
                    </div>
                  </div>
                </div>

                {/* ── CHARTS ROW ─────────────────────────────────────────────── */}
                <div className="bg-white dark:bg-gray-900 p-4">
                  <div className="grid grid-cols-3 gap-4">

                    {/* Cards por board (bar) */}
                    <div className="bg-[#f8fafc] dark:bg-gray-800 rounded-lg p-3">
                      <h3 className="text-[10px] font-black text-[#1e3a5f] dark:text-gray-200 uppercase tracking-widest mb-3">{t('kanbanBoardsPage.dashboard.cardsByBoard')}</h3>
                      <div className="space-y-2">
                        {dashboardStats.byBoard.slice().sort((a, b) => b.total - a.total).slice(0, 7).map((b, i) => {
                          const mx = Math.max(...dashboardStats.byBoard.map(x => x.total), 1);
                          return (
                            <div key={i}>
                              <div className="flex justify-between text-[10px] mb-0.5">
                                <span className="font-medium text-gray-600 dark:text-gray-400 truncate max-w-[130px]">{b.title}</span>
                                <span className="font-black text-[#1e3a5f] dark:text-white ml-1 flex-shrink-0">
                                  {b.total}{b.overdue > 0 && <span className="text-red-500 font-bold"> ({b.overdue})</span>}
                                </span>
                              </div>
                              <div className="h-3 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${(b.total / mx) * 100}%`, backgroundColor: b.color }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Status distribution (donut via conic-gradient) */}
                    <div className="bg-[#f8fafc] dark:bg-gray-800 rounded-lg p-3 flex flex-col">
                      <h3 className="text-[10px] font-black text-[#1e3a5f] dark:text-gray-200 uppercase tracking-widest mb-3">{t('kanbanBoardsPage.dashboard.statusDistribution')}</h3>
                      <div className="flex-1 flex items-center gap-4">
                        {(() => {
                          const total = dashboardStats.totalCards || 1;
                          const donePct = (dashboardStats.doneCards / total) * 100;
                          const ipPct = (dashboardStats.inProgressCards / total) * 100;
                          const backPct = 100 - donePct - ipPct;
                          return (
                            <>
                              <div className="relative flex-shrink-0 w-28 h-28 rounded-full" style={{ background: `conic-gradient(#10b981 0% ${donePct}%, #3b82f6 ${donePct}% ${donePct + ipPct}%, #94a3b8 ${donePct + ipPct}% 100%)` }}>
                                <div className="absolute inset-4 rounded-full bg-[#f8fafc] dark:bg-gray-800 flex flex-col items-center justify-center">
                                  <p className="text-sm font-black text-[#1e3a5f] dark:text-white leading-none">{donePct.toFixed(0)}%</p>
                                  <p className="text-[8px] text-gray-400 font-medium">{t('kanbanBoardsPage.dashboard.done')}</p>
                                </div>
                              </div>
                              <div className="space-y-2 flex-1">
                                {[
                                  { label: t('kanbanBoardsPage.dashboard.statusDone'), value: dashboardStats.doneCards, pct: donePct, color: '#10b981' },
                                  { label: t('kanbanBoardsPage.dashboard.statusInProgress'), value: dashboardStats.inProgressCards, pct: ipPct, color: '#3b82f6' },
                                  { label: t('kanbanBoardsPage.dashboard.statusBacklog'), value: dashboardStats.backlogCards, pct: backPct, color: '#94a3b8' },
                                ].map((s, i) => (
                                  <div key={i} className="flex items-center gap-2">
                                    <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex justify-between text-[10px]">
                                        <span className="text-gray-600 dark:text-gray-400 font-medium truncate">{s.label}</span>
                                        <span className="font-black ml-1" style={{ color: s.color }}>{s.value}</span>
                                      </div>
                                      <div className="h-1.5 bg-gray-200 dark:bg-gray-600 rounded-full mt-0.5">
                                        <div className="h-full rounded-full" style={{ width: `${s.pct}%`, backgroundColor: s.color }} />
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Checklists por board */}
                    <div className="bg-[#f8fafc] dark:bg-gray-800 rounded-lg p-3">
                      <h3 className="text-[10px] font-black text-[#1e3a5f] dark:text-gray-200 uppercase tracking-widest mb-3">{t('kanbanBoardsPage.dashboard.checklistsByBoard')}</h3>
                      {dashboardStats.byBoard.filter(b => b.checklistTotal > 0).length > 0 ? (
                        <div className="space-y-2">
                          {dashboardStats.byBoard.filter(b => b.checklistTotal > 0).slice(0, 7).map((b, i) => {
                            const cc = b.checklistPct >= 80 ? '#10b981' : b.checklistPct >= 50 ? '#3b82f6' : '#f59e0b';
                            return (
                              <div key={i}>
                                <div className="flex justify-between text-[10px] mb-0.5">
                                  <span className="font-medium text-gray-600 dark:text-gray-400 truncate max-w-[130px]">{b.title}</span>
                                  <span className="font-black flex-shrink-0 ml-1" style={{ color: cc }}>{b.checklistPct}%</span>
                                </div>
                                <div className="h-3 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${b.checklistPct}%`, backgroundColor: cc }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-8">{t('kanbanBoardsPage.dashboard.noChecklists')}</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* separator */}
                <div className="h-[3px]" style={{ background: 'linear-gradient(90deg, #0f2744, #3b82f6 30%, #60a5fa 50%, #3b82f6 70%, #0f2744)' }} />

                {/* ── BOTTOM ROW ─────────────────────────────────────────────── */}
                <div className="bg-[#e8eef5] dark:bg-gray-800 p-4">
                  <div className="grid grid-cols-3 gap-4">

                    {/* Atrasados por board */}
                    <div className="bg-white dark:bg-gray-700 rounded-lg p-3">
                      <h3 className="text-[10px] font-black text-[#1e3a5f] dark:text-gray-200 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> {t('kanbanBoardsPage.dashboard.overdueByBoard')}
                      </h3>
                      <div className="space-y-2">
                        {dashboardStats.byBoard.slice().sort((a, b) => b.overdue - a.overdue).filter(b => b.total > 0).slice(0, 7).map((b, i) => {
                          const mx = Math.max(...dashboardStats.byBoard.map(x => x.overdue), 1);
                          return (
                            <div key={i}>
                              <div className="flex justify-between text-[10px] mb-0.5">
                                <span className="font-medium text-gray-600 dark:text-gray-400 truncate max-w-[120px]">{b.title}</span>
                                <span className={`font-black flex-shrink-0 ml-1 ${b.overdue > 0 ? 'text-red-500' : 'text-green-500'}`}>
                                  {b.overdue > 0 ? b.overdue : '✓'}
                                </span>
                              </div>
                              <div className="h-3 bg-gray-100 dark:bg-gray-600 rounded-full overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: b.overdue > 0 ? `${(b.overdue / mx) * 100}%` : '100%', backgroundColor: b.overdue > 0 ? '#ef4444' : '#10b981' }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* ── RANKING PODIUM ── */}
                    <div className="bg-white dark:bg-gray-700 rounded-lg p-3">
                      <h3 className="text-[10px] font-black text-[#1e3a5f] dark:text-gray-200 uppercase tracking-widest mb-2 text-center">{t('kanbanBoardsPage.dashboard.boardRanking')}</h3>
                      <p className="text-[9px] text-gray-400 dark:text-gray-500 text-center mb-3">{t('kanbanBoardsPage.dashboard.rankingDescription')}</p>
                      {/* Podium */}
                      <div className="flex items-end justify-center gap-2" style={{ height: '96px' }}>
                        {/* 2nd place */}
                        {dashboardStats.rankedBoards[1] ? (
                          <div className="flex flex-col items-center" style={{ width: '30%' }}>
                            <p className="text-[9px] font-bold text-gray-500 dark:text-gray-400 text-center truncate w-full leading-tight mb-0.5">{dashboardStats.rankedBoards[1].title}</p>
                            <p className="text-[8px] text-gray-400 dark:text-gray-500 mb-0.5">{dashboardStats.rankedBoards[1].score}pts</p>
                            <div className="w-full flex items-center justify-center rounded-t font-black text-white text-lg" style={{ height: '58px', background: 'linear-gradient(180deg, #b0bec5, #78909c)' }}>2</div>
                          </div>
                        ) : <div style={{ width: '30%' }} />}
                        {/* 1st place */}
                        {dashboardStats.rankedBoards[0] ? (
                          <div className="flex flex-col items-center" style={{ width: '30%' }}>
                            <p className="text-[9px] font-bold text-yellow-600 dark:text-yellow-400 text-center truncate w-full leading-tight mb-0.5">{dashboardStats.rankedBoards[0].title}</p>
                            <p className="text-[8px] text-yellow-500 mb-0.5">{dashboardStats.rankedBoards[0].score}pts</p>
                            <div className="w-full flex items-center justify-center rounded-t font-black text-white text-lg" style={{ height: '80px', background: 'linear-gradient(180deg, #fbbf24, #d97706)' }}>1</div>
                          </div>
                        ) : <div style={{ width: '30%' }} />}
                        {/* 3rd place */}
                        {dashboardStats.rankedBoards[2] ? (
                          <div className="flex flex-col items-center" style={{ width: '30%' }}>
                            <p className="text-[9px] font-bold text-gray-500 dark:text-gray-400 text-center truncate w-full leading-tight mb-0.5">{dashboardStats.rankedBoards[2].title}</p>
                            <p className="text-[8px] text-gray-400 dark:text-gray-500 mb-0.5">{dashboardStats.rankedBoards[2].score}pts</p>
                            <div className="w-full flex items-center justify-center rounded-t font-black text-white text-lg" style={{ height: '44px', background: 'linear-gradient(180deg, #c8956c, #a0673a)' }}>3</div>
                          </div>
                        ) : <div style={{ width: '30%' }} />}
                      </div>
                      {/* Ranks 4-6 */}
                      {dashboardStats.rankedBoards.length > 3 && (
                        <div className="mt-2 space-y-0.5 pt-2 border-t border-gray-100 dark:border-gray-600">
                          {dashboardStats.rankedBoards.slice(3, 7).map((b, i) => (
                            <div key={i} className="flex items-center gap-1.5 text-[10px]">
                              <span className="text-gray-400 font-bold w-4 flex-shrink-0">{i + 4}.</span>
                              <span className="flex-1 text-gray-600 dark:text-gray-400 truncate">{b.title}</span>
                              <span className="text-gray-400 flex-shrink-0">{b.score}pts</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Resumo geral */}
                    <div className="bg-white dark:bg-gray-700 rounded-lg p-3">
                      <h3 className="text-[10px] font-black text-[#1e3a5f] dark:text-gray-200 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                        <CheckSquare className="w-3.5 h-3.5 text-blue-400" /> {t('kanbanBoardsPage.dashboard.generalSummary')}
                      </h3>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="relative flex-shrink-0 w-16 h-16 rounded-full" style={{ background: `conic-gradient(${dashboardStats.checklistPct >= 80 ? '#10b981' : '#3b82f6'} 0% ${dashboardStats.checklistPct}%, #e2e8f0 ${dashboardStats.checklistPct}% 100%)` }}>
                          <div className="absolute inset-2 rounded-full bg-white dark:bg-gray-700 flex items-center justify-center">
                            <span className="text-[11px] font-black text-[#1e3a5f] dark:text-white">{dashboardStats.checklistPct}%</span>
                          </div>
                        </div>
                        <div>
                          <p className="text-xl font-black text-[#1e3a5f] dark:text-white leading-none">{dashboardStats.doneItems}</p>
                          <p className="text-[10px] text-gray-500 dark:text-gray-400">{t('kanbanBoardsPage.dashboard.ofItems', { count: dashboardStats.totalItems })}</p>
                          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">{t('kanbanBoardsPage.dashboard.checklistsCompleted')}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: t('kanbanBoardsPage.dashboard.labelBacklog'), value: dashboardStats.backlogCards, color: '#64748b' },
                          { label: t('kanbanBoardsPage.dashboard.labelInProgress'), value: dashboardStats.inProgressCards, color: '#3b82f6' },
                          { label: t('kanbanBoardsPage.dashboard.labelDone'), value: dashboardStats.doneCards, color: '#10b981' },
                          { label: t('kanbanBoardsPage.dashboard.labelDueToday'), value: dashboardStats.dueToday, color: '#f59e0b' },
                        ].map((s, i) => (
                          <div key={i} className="rounded-lg p-2 text-center" style={{ backgroundColor: s.color + '18' }}>
                            <p className="text-lg font-black leading-none" style={{ color: s.color }}>{s.value}</p>
                            <p className="text-[9px] font-semibold text-gray-500 dark:text-gray-400 mt-0.5">{s.label}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-gray-400">{t('kanbanBoardsPage.loading.generic')}</div>
        ) : (
          <div className="space-y-8">
            {/* Favoritos */}
            {starredBoards.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                  <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">{t('kanbanBoardsPage.sections.starred')}</h2>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                  {starredBoards.map((b) => <BoardCard key={b.id} board={b} />)}
                </div>
              </section>
            )}

            {/* Workspaces */}
            {workspaces.map((ws) => {
              const wsBoards = boardsByWorkspace.get(ws.id) ?? [];
              const collapsed = collapsedWs.has(ws.id);
              return (
                <section key={ws.id}>
                  <div className="flex items-center justify-between mb-3">
                    <button className="flex items-center gap-2 group" onClick={() => toggleCollapse(ws.id)}>
                      <div className="w-4 h-4 rounded" style={{ background: ws.color }} />
                      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{ws.name}</h2>
                      <span className="text-xs text-gray-400">({wsBoards.length})</span>
                      {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                    </button>
                    <button
                      onClick={() => handleDeleteWorkspace(ws.id, ws.name)}
                      className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded"
                    >{t('kanbanBoardsPage.actions.remove')}</button>
                  </div>
                  {!collapsed && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                      {wsBoards.map((b) => <BoardCard key={b.id} board={b} />)}
                      <AddTile />
                    </div>
                  )}
                </section>
              );
            })}

            {/* Boards sem workspace */}
            <section>
              {workspaces.length > 0 && (
                <div className="flex items-center gap-2 mb-3">
                  <LayoutGrid className="w-4 h-4 text-gray-400" />
                  <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t('kanbanBoardsPage.sections.noWorkspace')}</h2>
                </div>
              )}
              {noWorkspaceBoards.length === 0 && workspaces.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-gray-400 gap-4">
                  <LayoutGrid className="w-12 h-12 opacity-30" />
                  <p className="text-lg">{t('kanbanBoardsPage.empty.noBoards')}</p>
                  <button onClick={() => setShowCreate(true)} className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold">{t('kanbanBoardsPage.actions.createBoard')}</button>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                  {noWorkspaceBoards.map((b) => <BoardCard key={b.id} board={b} />)}
                  <AddTile />
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Create Board Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">{t('kanbanBoardsPage.modal.createBoardTitle')}</h2>
              <button onClick={() => setShowCreate(false)} className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-700 mb-4">
              {([['blank',t('kanbanBoardsPage.modal.blank')],['template',t('kanbanBoardsPage.modal.fromTemplate')]] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  onClick={() => setCreateTab(tab)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${createTab === tab ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                >{label}</button>
              ))}
            </div>

            {createTab === 'blank' ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('kanbanBoardsPage.fields.boardName')}</label>
                  <input
                    autoFocus
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                    placeholder={t('kanbanBoardsPage.placeholders.boardName')}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                {workspaces.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('kanbanBoardsPage.fields.workspaceOptional')}</label>
                    <select
                      value={newWorkspaceId}
                      onChange={(e) => setNewWorkspaceId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value="">{t('kanbanBoardsPage.defaults.noWorkspace')}</option>
                      {workspaces.map((ws) => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kanbanBoardsPage.fields.color')}</label>
                  <div className="flex flex-wrap gap-2">
                    {BOARD_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setNewColor(c)}
                        className={`w-8 h-8 rounded-full transition-all ${newColor === c ? 'ring-2 ring-offset-2 ring-blue-500 scale-110' : 'hover:scale-105'}`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                </div>
                <div className="w-full h-14 rounded-xl flex items-center px-4 font-bold text-white text-sm" style={{ background: `linear-gradient(135deg, ${newColor}dd, ${newColor}88)` }}>
                  {newTitle || t('kanbanBoardsPage.defaults.boardPreview')}
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setShowCreate(false)} className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">{t('kanbanBoardsPage.actions.cancel')}</button>
                  <button onClick={handleCreate} disabled={!newTitle.trim() || creating} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors">
                    {creating ? t('kanbanBoardsPage.loading.creating') : t('kanbanBoardsPage.actions.createBoard')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('kanbanBoardsPage.fields.boardName')}</label>
                  <input
                    autoFocus
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder={t('kanbanBoardsPage.placeholders.newBoardName')}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                {templates.length === 0 ? (
                  <div className="flex flex-col items-center py-8 text-gray-400 gap-2">
                    <LayoutTemplate className="w-8 h-8 opacity-40" />
                    <p className="text-sm">{t('kanbanBoardsPage.empty.noTemplates')}</p>
                    <p className="text-xs">{t('kanbanBoardsPage.empty.noTemplatesHint')}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                    {templates.map((tmpl) => (
                      <button
                        key={tmpl.id}
                        onClick={() => handleCreateFromTemplate(tmpl.id)}
                        disabled={creating}
                        className="text-left rounded-lg overflow-hidden border-2 border-transparent hover:border-blue-400 transition-all disabled:opacity-50"
                      >
                        <div className="h-16 flex items-end p-2" style={{ background: `linear-gradient(135deg, ${tmpl.color}cc, ${tmpl.color}88)` }}>
                          <span className="text-white text-xs font-semibold line-clamp-2">{tmpl.title.replace(/^\[Template\] /, '')}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => setShowCreate(false)} className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700">{t('kanbanBoardsPage.actions.cancel')}</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Workspace Modal */}
      {showCreateWs && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">{t('kanbanBoardsPage.modal.createWorkspaceTitle')}</h2>
              <button onClick={() => setShowCreateWs(false)} className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('kanbanBoardsPage.fields.name')}</label>
                <input
                  autoFocus
                  type="text"
                  value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateWorkspace()}
                  placeholder={t('kanbanBoardsPage.placeholders.workspaceName')}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kanbanBoardsPage.fields.color')}</label>
                <div className="flex gap-2">
                  {WS_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setWsColor(c)}
                      className={`w-7 h-7 rounded-full transition-all ${wsColor === c ? 'ring-2 ring-offset-2 ring-blue-500 scale-110' : 'hover:scale-105'}`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowCreateWs(false)} className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium">{t('kanbanBoardsPage.actions.cancel')}</button>
              <button onClick={handleCreateWorkspace} disabled={!wsName.trim() || creatingWs} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold">
                {creatingWs ? t('kanbanBoardsPage.loading.creating') : t('kanbanBoardsPage.actions.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de editar board (nome + cor) */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-800">
            <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">Editar board</h2>

            <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-gray-300">Nome</label>
            <input
              autoFocus
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitEdit();
                if (e.key === 'Escape') setEditTarget(null);
              }}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-[#0c66e4] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              placeholder="Nome do board"
            />

            <label className="mb-1.5 mt-4 block text-xs font-medium text-slate-600 dark:text-gray-300">Cor</label>
            <div className="flex flex-wrap items-center gap-2">
              {BOARD_COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setEditColor(c)}
                  className={`h-8 w-8 rounded-lg border-2 transition-transform hover:scale-110 ${editColor === c ? 'border-slate-900 dark:border-white shadow-md' : 'border-transparent'}`}
                  style={{ background: c }}
                  title={c}
                />
              ))}
              {/* Color picker custom */}
              <label
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-300 text-xs text-slate-500 transition-colors hover:border-slate-500 dark:border-gray-600 dark:text-gray-400 dark:hover:border-gray-400"
                title="Cor personalizada"
              >
                <input
                  type="color"
                  value={editColor}
                  onChange={(e) => setEditColor(e.target.value)}
                  className="h-0 w-0 opacity-0"
                />
                +
              </label>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-gray-400">Preview:</span>
              <div
                className="h-10 w-32 rounded-lg shadow-inner"
                style={{ background: `linear-gradient(135deg, ${editColor}dd, ${editColor}99)` }}
              />
              <input
                type="text"
                value={editColor}
                onChange={(e) => setEditColor(e.target.value)}
                className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-mono text-slate-700 outline-none focus:border-[#0c66e4] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                placeholder="#0c66e4"
              />
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                onClick={() => setEditTarget(null)}
                className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
              >
                Cancelar
              </button>
              <button
                onClick={() => void commitEdit()}
                className="rounded-xl bg-[#0c66e4] px-4 py-2 text-sm font-medium text-white hover:bg-[#0055cc]"
              >
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
