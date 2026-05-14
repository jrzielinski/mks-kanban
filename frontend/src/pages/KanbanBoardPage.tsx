import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/auth';
// @ts-ignore
import makestudioIcon from '../../assets/makestudioicon.png';

import { useParams, useNavigate } from 'react-router-dom';
import {
  DndContext, DragOverlay, DragStartEvent, DragOverEvent, DragEndEvent,
  PointerSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ArrowLeft, MoreHorizontal, Plus, Search, Users, X, Filter,
  // @ts-ignore
  Activity, Tag, Zap, Clock3, AlertTriangle, Check, Trash2, ChevronRight,
  Calendar, Download, Copy, Archive, Bell, Keyboard, RotateCcw, Globe,
  Table2, BarChart2, Gauge, MapPin, Eye, EyeOff, Link2, Star, Plug,
  Lock, LayoutTemplate, Maximize2, Minimize2, GitBranch, Pencil, Loader2, TrendingDown,
  Kanban as KanbanIcon, RefreshCw, CheckCircle, XCircle, List,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import kanbanService, {
  KanbanBoard, KanbanList, KanbanCard, KanbanBoardMember,
  KanbanBoardLabel, KanbanAutomationRule, KanbanActivity, KanbanNotification,
  KanbanPowerUp, KanbanWorkspace,
} from '@/services/kanban.service';
import { KanbanColumn } from '@/components/kanban/KanbanColumn';
import { KanbanCardItem } from '@/components/kanban/KanbanCardItem';
import { CardDetailModal } from '@/components/kanban/CardDetailModal';
import { CalendarView } from '@/components/kanban/CalendarView';
import { TableView } from '@/components/kanban/TableView';
import { DashboardView } from '@/components/kanban/DashboardView';
import { TimelineView } from '@/components/kanban/TimelineView';
import { KanbanSearchModal } from '@/components/kanban/KanbanSearchModal';
import MapView from '@/components/kanban/MapView';
import { PowerUpTemplateWizard } from '@/components/kanban/PowerUpTemplateWizard';
import { PowerUpInstallModal } from '@/components/kanban/PowerUpInstallModal';
import {
  listMyTemplates, listAvailable, deleteTemplate as deletePuTemplate, submitTemplate as submitPuTemplate,
  listInstallationLogs,
  PowerUpTemplate, PowerUpLog, STATUS_LABELS,
} from '@/services/kanbanPowerUpTemplate.service';
import { BurndownView } from '@/components/kanban/BurndownView';
import { KanbanAutomationPanel } from '@/components/kanban/KanbanAutomationPanel';
import { LoadingDots } from './LoadingDots';
import { AddCustomFieldInline } from './AddCustomFieldInline';
import { BoardReposPanel } from './BoardReposPanel';
import { LABEL_PALETTE, BG_PALETTE, GRADIENT_PALETTE } from './kanbanPalettes';
import type { BoardPanelTab, BoardViewMode, SavedFilterView } from './kanban-board-types';

export const KanbanBoardPage: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const queryClient = useQueryClient();
  const { boardId } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [editingBoardTitle, setEditingBoardTitle] = useState(false);
  const [boardTitleDraft, setBoardTitleDraft] = useState('');
  const [lists, setLists] = useState<KanbanList[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [addingList, setAddingList] = useState(false);
  const [newListTitle, setNewListTitle] = useState('');
  const [newListColor, setNewListColor] = useState('');
  const [showMembersEditor, setShowMembersEditor] = useState(false);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [inviteEmailInput, setInviteEmailInput] = useState('');
  const [sendingInviteEmail, setSendingInviteEmail] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMemberId, setFilterMemberId] = useState('');
  const [filterLabelColor, setFilterLabelColor] = useState('');
  const [filterDueDate, setFilterDueDate] = useState('');
  const [filterNoMembers, setFilterNoMembers] = useState(false);
  const [filterHasAttachment, setFilterHasAttachment] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<{ userId: string; name?: string; email?: string }[]>([]);
  const currentUserEmail = useAuthStore(s => s.user?.email);
  const currentUserName = useAuthStore(s => s.user ? [s.user.firstName, s.user.lastName].filter(Boolean).join(' ') || s.user.email : undefined);

  const currentUserId = useMemo(() => {
    try {
      const token = localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '';
      const [, payload] = token.split('.');
      const decoded = JSON.parse(atob(payload));
      return decoded.id as string;
    } catch { return undefined; }
  }, []);

  // Board permissions derived from board settings (true by default if not restricted)
  const canEditCards = board?.permissions?.membersCanEditCards !== false;
  const canComment   = board?.permissions?.membersCanComment   !== false;

  // Focus mode (hide headers for max board space)
  const [focusMode, setFocusMode] = useState(false);

  // J/K keyboard navigation - focused card
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);

  // Board panel (activity / labels / automation)
  const [showBoardPanel, setShowBoardPanel] = useState(false);
  const [boardPanelTab, setBoardPanelTab] = useState<BoardPanelTab>('activity');
  const [boardActivities, setBoardActivities] = useState<KanbanActivity[]>([]);
  const [loadingActivities, setLoadingActivities] = useState(false);
  const [automationActivities, setAutomationActivities] = useState<KanbanActivity[]>([]);

  // Board labels
  const [newLabelText, setNewLabelText] = useState('');
  const [newLabelColor, setNewLabelColor] = useState(LABEL_PALETTE[0]);

  // Automation rules state moved to KanbanAutomationPanel component
  // App dialog (opened by open_app automation)
  const [appDialogUrl, setAppDialogUrl] = useState('');
  const [appDialogMode, setAppDialogMode] = useState<'dialog' | 'sidebar'>('dialog');
  const [appDialogTitle, setAppDialogTitle] = useState('');

  // Butler NLP
  const [butlerInput, setButlerInput] = useState('');
  const [butlerParsing, setButlerParsing] = useState(false);

  // Overdue banner
  const [overdueDismissed, setOverdueDismissed] = useState(false);

  // View mode (board / calendar)
  const [viewMode, setViewMode] = useState<BoardViewMode>('board');

  // Notifications
  const [notifications, setNotifications] = useState<KanbanNotification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifFilter, setNotifFilter] = useState<string>('all');
  const unreadCount = notifications.filter(n => !n.isRead).length;
  const filteredNotifications = notifFilter === 'all' ? notifications : notifications.filter(n => n.type === notifFilter);

  // Archived items
  const [archivedCards, setArchivedCards] = useState<KanbanCard[]>([]);
  const [archivedLists, setArchivedLists] = useState<KanbanList[]>([]);
  const [loadingArchived, setLoadingArchived] = useState(false);

  // Global search
  const [showSearch, setShowSearch] = useState(false);

  // Keyboard shortcuts panel
  const [showShortcuts, setShowShortcuts] = useState(false);

  // #37 Watch board
  const [isWatching, setIsWatching] = useState(false);

  // #36 Invite token
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);

  // #44 Power-ups
  const [powerUps, setPowerUps] = useState<KanbanPowerUp[]>([]);
  const [showAddPowerUp, setShowAddPowerUp] = useState(false);
  const [puType, setPuType] = useState<KanbanPowerUp['type']>('slack');
  const [puConfig, setPuConfig] = useState<Record<string, any>>({});
  const [showPuWizard, setShowPuWizard] = useState(false);
  const [editingPuTemplate, setEditingPuTemplate] = useState<PowerUpTemplate | null>(null);
  const [myTemplates, setMyTemplates] = useState<PowerUpTemplate[]>([]);
  const [availableTemplates, setAvailableTemplates] = useState<PowerUpTemplate[]>([]);
  const [installingTemplate, setInstallingTemplate] = useState<PowerUpTemplate | null>(null);
  const [jiraStatuses, setJiraStatuses] = useState<{ id: string; name: string; category: string }[]>([]);
  const [loadingJiraStatuses, setLoadingJiraStatuses] = useState(false);
  const [puLogsInstallId, setPuLogsInstallId] = useState<string | null>(null);
  const [puLogs, setPuLogs] = useState<PowerUpLog[]>([]);
  const [puLogsLoading, setPuLogsLoading] = useState(false);

  // #35 Visibility
  const [boardVisibility, setBoardVisibility] = useState<'private'|'workspace'|'public'>('private');

  // Workspaces (for A6 move board between workspaces)
  const [workspaces, setWorkspaces] = useState<KanbanWorkspace[]>([]);

  // Card preview fields (A8)
  const [cardPreviewFields, setCardPreviewFields] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(`kanban-preview-fields-${boardId}`);
      return saved ? JSON.parse(saved) as string[] : [];
    } catch { return []; }
  });

  // Saved filter views
  const [savedViews, setSavedViews] = useState<SavedFilterView[]>(() => {
    try {
      const saved = localStorage.getItem(`kanban-saved-views-${boardId}`);
      return saved ? JSON.parse(saved) as SavedFilterView[] : [];
    } catch { return []; }
  });
  const [showSaveViewModal, setShowSaveViewModal] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [showSavedViewsDropdown, setShowSavedViewsDropdown] = useState(false);
  const savedViewsDropdownRef = useRef<HTMLDivElement>(null);

  // Drag state
  const dragSourceListRef = useRef<string | null>(null);
  const [moveBlockDialog, setMoveBlockDialog] = useState<{ title: string; message: string } | null>(null);

  // WebSocket ref and card editors state
  const socketRef = useRef<Socket | null>(null);
  const [cardEditors, setCardEditors] = useState<{ cardId: string; userId: string; field: string }[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    if (boardId) void load(boardId);
    return () => { document.title = 'MakeStudio'; };
  }, [boardId]);

  const updateCardInLists = useCallback((updatedCard: KanbanCard) => {
    setLists(prev => prev.map(l => ({
      ...l,
      cards: l.cards.map(c => c.id === updatedCard.id ? { ...c, ...updatedCard } : c),
    })));
    setSelectedCard(prev => prev?.id === updatedCard.id ? { ...prev, ...updatedCard } : prev);
  }, []);

  const handleCardEditingStart = useCallback((cardId: string, bId: string, field: string) => {
    socketRef.current?.emit('card:editing', { cardId, boardId: bId, field });
  }, []);

  const handleCardEditingStop = useCallback((cardId: string, bId: string, field: string) => {
    socketRef.current?.emit('card:editing:stop', { cardId, boardId: bId, field });
  }, []);

  // Close saved views dropdown on outside click
  useEffect(() => {
    if (!showSavedViewsDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (savedViewsDropdownRef.current && !savedViewsDropdownRef.current.contains(e.target as Node)) {
        setShowSavedViewsDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSavedViewsDropdown]);

  // Restore saved filters for this board
  useEffect(() => {
    if (!boardId) return;
    try {
      const saved = localStorage.getItem(`kanban-filters-${boardId}`);
      if (saved) {
        const f = JSON.parse(saved) as {
          searchQuery?: string;
          filterMemberId?: string;
          filterLabelColor?: string;
          filterDueDate?: string;
          filterNoMembers?: boolean;
          filterHasAttachment?: boolean;
        };
        if (f.searchQuery) setSearchQuery(f.searchQuery);
        if (f.filterMemberId) setFilterMemberId(f.filterMemberId);
        if (f.filterLabelColor) setFilterLabelColor(f.filterLabelColor);
        if (f.filterDueDate) setFilterDueDate(f.filterDueDate);
        if (f.filterNoMembers) setFilterNoMembers(f.filterNoMembers);
        if (f.filterHasAttachment) setFilterHasAttachment(f.filterHasAttachment);
      }
    } catch {
      // ignore parse errors
    }
  }, [boardId]);

  // Persist active filters for this board
  useEffect(() => {
    if (!boardId) return;
    const hasAny = searchQuery || filterMemberId || filterLabelColor || filterDueDate || filterNoMembers || filterHasAttachment;
    if (hasAny) {
      localStorage.setItem(`kanban-filters-${boardId}`, JSON.stringify({
        searchQuery, filterMemberId, filterLabelColor, filterDueDate, filterNoMembers, filterHasAttachment,
      }));
    } else {
      localStorage.removeItem(`kanban-filters-${boardId}`);
    }
  }, [boardId, searchQuery, filterMemberId, filterLabelColor, filterDueDate, filterNoMembers, filterHasAttachment]);

  useEffect(() => {
    if (!boardId) return;
    const token = localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '';
    const socket: Socket = io('/kanban-rt', {
      auth: { token, name: currentUserName, email: currentUserEmail },
      autoConnect: false,
      transports: ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay: 3000,
    });
    let disposed = false;
    const connectTimer = window.setTimeout(() => {
      if (!disposed) socket.connect();
    }, 0);

    socket.on('connect', () => {
      socket.emit('joinBoard', { boardId });
    });

    socket.on('disconnect', (reason) => {
      // Server-initiated disconnect (auth failure) — do not reconnect
      if (reason === 'io server disconnect') {
        socket.off();
      }
    });

    socket.on('card:created', (card: KanbanCard) => {
      setLists(prev => prev.map(l =>
        l.id === card.listId
          ? { ...l, cards: [...l.cards.filter(c => c.id !== card.id), card] }
          : l
      ));
    });

    socket.on('card:updated', (card: KanbanCard) => {
      updateCardInLists(card);
      queryClient.invalidateQueries({ queryKey: ['kanban-card', card.id] });
    });

    socket.on('card:moved', ({ cardId, fromListId, toListId }: { cardId: string; fromListId: string; toListId: string }) => {
      setLists(prev => {
        const card = prev.flatMap(l => l.cards).find(c => c.id === cardId);
        if (!card) return prev;
        return prev.map(l => {
          if (l.id === fromListId) return { ...l, cards: l.cards.filter(c => c.id !== cardId) };
          if (l.id === toListId) return { ...l, cards: [...l.cards, { ...card, listId: toListId }] };
          return l;
        });
      });
    });

    socket.on('card:deleted', ({ cardId }: { cardId: string }) => {
      setLists(prev => prev.map(l => ({ ...l, cards: l.cards.filter(c => c.id !== cardId) })));
      setSelectedCard(prev => prev?.id === cardId ? null : prev);
    });

    socket.on('activity:added', ({ cardId }: { cardId: string }) => {
      // Signal to card detail modal to refresh activities when this card is open
      setSelectedCard(prev =>
        prev?.id === cardId
          ? { ...prev, _activityPing: Date.now() } as typeof prev
          : prev
      );
    });

    socket.on('board:presence', ({ users }: { users: { userId: string; name?: string; email?: string }[] }) => {
      setOnlineUsers(users);
    });

    socketRef.current = socket;

    socket.on('card:editing', ({ cardId, userId, field }: { cardId: string; userId: string; field: string }) => {
      setCardEditors(prev => {
        const filtered = prev.filter(e => !(e.userId === userId && e.cardId === cardId && e.field === field));
        return [...filtered, { cardId, userId, field }];
      });
    });

    socket.on('card:editing:stop', ({ cardId, userId, field }: { cardId: string; userId: string; field: string }) => {
      setCardEditors(prev => prev.filter(e => !(e.userId === userId && e.cardId === cardId && e.field === field)));
    });

    return () => {
      disposed = true;
      window.clearTimeout(connectTimer);
      if (socket.connected) {
        socket.emit('leaveBoard', { boardId });
      }
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
      setCardEditors([]);
      setOnlineUsers([]);
    };
  }, [boardId, updateCardInLists, currentUserName, currentUserEmail, queryClient]);

  // Escape key exits focus mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocusMode(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const load = async (id: string) => {
    setIsLoading(true);
    try {
      const data = await kanbanService.getBoard(id);
      setBoard(data);
      setLists(data.lists ?? []);
      document.title = `${data.title} — MakeStudio`;
      setInviteToken((data as any).inviteToken ?? null);
      setBoardVisibility((data as any).visibility ?? 'private');
      const pups = await kanbanService.listPowerUps(data.id).catch(() => []);
      setPowerUps(pups);
    } catch {
      toast.error(t('kanbanBoardPage.toasts.loadBoardError'));
      navigate('/kanban');
    } finally {
      setIsLoading(false);
    }
  };

  const loadBoardActivities = useCallback(async () => {
    if (!boardId) return;
    setLoadingActivities(true);
    try {
      const acts = await kanbanService.listBoardActivities(boardId);
      setBoardActivities(acts);
    } catch { /* silent */ }
    finally { setLoadingActivities(false); }
  }, [boardId]);

  useEffect(() => {
    if (showBoardPanel && boardPanelTab === 'activity') {
      void loadBoardActivities();
    }
    if (showBoardPanel && boardPanelTab === 'archive') {
      void loadArchivedItems();
    }
    if (showBoardPanel && boardPanelTab === 'settings' && workspaces.length === 0) {
      kanbanService.listWorkspaces().then(setWorkspaces).catch(() => {});
    }
    if (showBoardPanel && boardPanelTab === 'automation' && boardId) {
      kanbanService.listBoardActivities(boardId).then(acts => {
        setAutomationActivities(acts.filter(a => a.text.startsWith('🤖')));
      }).catch(() => {});
    }
    if (showBoardPanel && boardPanelTab === 'powerups' && board) {
      listMyTemplates(board.id).then(setMyTemplates).catch(() => {});
      listAvailable(board.id).then(setAvailableTemplates).catch(() => {});
    }
  }, [showBoardPanel, boardPanelTab]);

  // Load notifications on mount + poll every 30s
  useEffect(() => {
    const loadNotifs = () => kanbanService.listNotifications().then(setNotifications).catch(() => {});
    void loadNotifs();
    const interval = setInterval(loadNotifs, 30000);
    return () => clearInterval(interval);
  }, []);

  // Flat list of all visible card IDs for J/K navigation
  const allCardIds = useMemo(() => lists.flatMap(l => l.cards.map(c => c.id)), [lists]);
  const allCardsMap = useMemo(() => {
    const m = new Map<string, KanbanCard>();
    for (const l of lists) for (const c of l.cards) m.set(c.id, c);
    return m;
  }, [lists]);

  // External deep-link: when the VSCode embed shell dispatches
  // `kanban:focus-card` (driven by `kanban.searchCards`), open the
  // CardDetailModal as soon as the card lands in `allCardsMap`. The
  // pendingFocusCardId state handles the race where the event fires before
  // the board's first fetch completes — once lists populate the effect below
  // matches and clears it.
  const [pendingFocusCardId, setPendingFocusCardId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event): void => {
      const cardId = (e as CustomEvent<{ cardId?: string }>).detail?.cardId;
      if (typeof cardId === 'string' && cardId) setPendingFocusCardId(cardId);
    };
    window.addEventListener('kanban:focus-card', handler);
    return () => window.removeEventListener('kanban:focus-card', handler);
  }, []);
  useEffect(() => {
    if (!pendingFocusCardId) return;
    const card = allCardsMap.get(pendingFocusCardId);
    if (!card) return;
    setSelectedCard(card);
    setPendingFocusCardId(null);
  }, [pendingFocusCardId, allCardsMap]);

  // Keyboard shortcuts
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') { setShowSearch(false); setShowShortcuts(false); setShowNotifications(false); setFocusedCardId(null); return; }
      if (inInput) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowSearch(true); return; }
      if (e.key === '?') { setShowShortcuts(p => !p); return; }
      if (e.key === 'f' || e.key === 'F') { setShowFilterPanel(p => !p); return; }

      // J/K card navigation
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        if (allCardIds.length === 0) return;
        setFocusedCardId(prev => {
          if (!prev) return allCardIds[0];
          const idx = allCardIds.indexOf(prev);
          return allCardIds[Math.min(idx + 1, allCardIds.length - 1)];
        });
        return;
      }
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        if (allCardIds.length === 0) return;
        setFocusedCardId(prev => {
          if (!prev) return allCardIds[0];
          const idx = allCardIds.indexOf(prev);
          return allCardIds[Math.max(idx - 1, 0)];
        });
        return;
      }
      // Enter to open focused card
      if (e.key === 'Enter') {
        setFocusedCardId(prev => {
          if (prev) {
            const card = allCardsMap.get(prev);
            if (card) setTimeout(() => setSelectedCard(card), 0);
          }
          return prev;
        });
        return;
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [allCardIds, allCardsMap]);

  // ── OVERDUE CHECK ──────────────────────────────────────────────────────────

  const overdueCards = useMemo(() => {
    const now = new Date();
    return lists.flatMap(l => l.cards.filter(c => {
      if (c.isArchived) return false;
      // Botão "Concluído" no header do card grava ISO em customFields
      // __completedAt — fonte única de verdade do "feito". Atrasado e
      // vence-hoje saem do estado pra qualquer card concluído.
      if (c.customFields?.['__completedAt']) return false;
      if (!c.dueDate) return false;
      const due = new Date(c.dueDate);
      return due < now && due.toDateString() !== now.toDateString();
    }));
  }, [lists]);

  // ── FILTER ─────────────────────────────────────────────────────────────────

  // Card filter matching function (reused for ghost mode and other views)
  const cardMatchesFilter = useCallback((c: KanbanCard) => {
    if (searchQuery && !c.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterMemberId && !c.memberIds.includes(filterMemberId)) return false;
    if (filterLabelColor && !c.labels.some(lbl => lbl.color === filterLabelColor)) return false;
    if (filterDueDate) {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekEnd = new Date(todayStart.getTime() + 7 * 86400000);
      if (filterDueDate === 'none' && c.dueDate) return false;
      if (filterDueDate === 'overdue') {
        if (!c.dueDate) return false;
        const d = new Date(c.dueDate);
        if (d >= todayStart) return false;
      }
      if (filterDueDate === 'today') {
        if (!c.dueDate) return false;
        const d = new Date(c.dueDate);
        const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (dDay.getTime() !== todayStart.getTime()) return false;
      }
      if (filterDueDate === 'week') {
        if (!c.dueDate) return false;
        const d = new Date(c.dueDate);
        if (d < todayStart || d >= weekEnd) return false;
      }
      if (filterDueDate === 'has') {
        if (!c.dueDate) return false;
      }
    }
    if (filterNoMembers && c.memberIds.length > 0) return false;
    if (filterHasAttachment && c.attachments.length === 0) return false;
    return true;
  }, [searchQuery, filterMemberId, filterLabelColor, filterDueDate, filterNoMembers, filterHasAttachment]);

  const hasActiveFilter = !!searchQuery || !!filterMemberId || !!filterLabelColor || !!filterDueDate || filterNoMembers || filterHasAttachment;
  const clearFilters = () => { setSearchQuery(''); setFilterMemberId(''); setFilterLabelColor(''); setFilterDueDate(''); setFilterNoMembers(false); setFilterHasAttachment(false); localStorage.removeItem(`kanban-filters-${boardId}`); };

  const handleSaveView = useCallback(() => {
    if (!saveViewName.trim()) return;
    const newView: SavedFilterView = {
      id: `view_${Date.now()}`,
      name: saveViewName.trim(),
      searchQuery,
      filterMemberId,
      filterLabelColor,
      filterDueDate,
      filterNoMembers,
      filterHasAttachment,
      createdAt: new Date().toISOString(),
    };
    const updated = [...savedViews, newView];
    setSavedViews(updated);
    localStorage.setItem(`kanban-saved-views-${boardId}`, JSON.stringify(updated));
    setSaveViewName('');
    setShowSaveViewModal(false);
    toast.success(t('kanbanBoardPage.savedViews.saved', { name: newView.name }));
  }, [saveViewName, searchQuery, filterMemberId, filterLabelColor, filterDueDate, filterNoMembers, filterHasAttachment, savedViews, boardId]);

  const handleLoadView = useCallback((view: SavedFilterView) => {
    setSearchQuery(view.searchQuery);
    setFilterMemberId(view.filterMemberId);
    setFilterLabelColor(view.filterLabelColor);
    setFilterDueDate(view.filterDueDate);
    setFilterNoMembers(view.filterNoMembers);
    setFilterHasAttachment(view.filterHasAttachment);
    setShowSavedViewsDropdown(false);
    toast.success(t('kanbanBoardPage.savedViews.loaded', { name: view.name }));
  }, []);

  const handleDeleteView = useCallback((viewId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = savedViews.filter(v => v.id !== viewId);
    setSavedViews(updated);
    localStorage.setItem(`kanban-saved-views-${boardId}`, JSON.stringify(updated));
  }, [savedViews, boardId]);

  // Set of card IDs that match the active filter (for ghost mode in board view)
  const matchingCardIds = useMemo(() => {
    if (!hasActiveFilter) return null; // null = no filter active, show all normally
    const ids = new Set<string>();
    for (const l of lists) {
      for (const c of l.cards) {
        if (cardMatchesFilter(c)) ids.add(c.id);
      }
    }
    return ids;
  }, [lists, hasActiveFilter, cardMatchesFilter]);

  // Hide snoozed cards from the board
  const isSnoozed = useCallback((c: KanbanCard) => {
    const snoozedUntil = c.customFields?.['__snoozedUntil'];
    if (!snoozedUntil) return false;
    return new Date(snoozedUntil as string) > new Date();
  }, []);

  // For non-board views, still filter cards out completely (calendar, table, etc.)
  const filteredLists = useMemo(() => {
    const base = lists.map(l => ({
      ...l,
      cards: l.cards.filter(c => !isSnoozed(c)),
    }));
    if (!hasActiveFilter) return base;
    return base.map(l => ({
      ...l,
      cards: l.cards.filter(cardMatchesFilter),
    }));
  }, [lists, hasActiveFilter, cardMatchesFilter, isSnoozed]);

  // ── DND ────────────────────────────────────────────────────────────────────

  const findListByCardId = (cardId: string, currentLists: KanbanList[]) =>
    currentLists.find((l) => l.cards.some((c) => c.id === cardId));

  const handleDragStart = (e: DragStartEvent) => {
    const t = e.active.data.current?.type;
    if (t === 'card') {
      setActiveCard(e.active.data.current?.card);
      const src = lists.find(l => l.cards.some(c => c.id === e.active.id));
      dragSourceListRef.current = src?.id ?? null;
      return;
    }
    if (t === 'column') {
      // Drag de coluna (drag handle GripVertical na header da KanbanColumn).
      setActiveColumnId(String(e.active.id));
    }
  };

  const handleDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // Drags de coluna são resolvidos só no DragEnd; aqui não mexe em cards.
    if (active.data.current?.type === 'column') return;

    setLists((prev) => {
      const activeList = findListByCardId(String(active.id), prev);
      const overType = over.data.current?.type;
      const overList = (overType === 'list' || overType === 'column')
        ? prev.find((l) => l.id === over.data.current?.listId)
        : findListByCardId(String(over.id), prev);

      if (!activeList || !overList || activeList.id === overList.id) return prev;

      const srcCards = [...activeList.cards];
      const dstCards = [...overList.cards];
      const cardIdx = srcCards.findIndex((c) => c.id === active.id);
      const [movedCard] = srcCards.splice(cardIdx, 1);
      const overIdx = dstCards.findIndex((c) => c.id === over.id);
      dstCards.splice(overIdx >= 0 ? overIdx : dstCards.length, 0, { ...movedCard, listId: overList.id });

      return prev.map((l) => {
        if (l.id === activeList.id) return { ...l, cards: srcCards };
        if (l.id === overList.id) return { ...l, cards: dstCards };
        return l;
      });
    });
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveCard(null);
    const wasColumnDrag = active.data.current?.type === 'column';
    setActiveColumnId(null);

    const sourceListId = dragSourceListRef.current;
    dragSourceListRef.current = null;

    // ── Drag de coluna: reordena lists no estado + persiste no backend.
    if (wasColumnDrag) {
      if (!over || over.id === active.id) return;
      // Só reordena se o destino também for uma coluna.
      const overType = over.data.current?.type;
      if (overType !== 'column') return;
      const fromIdx = lists.findIndex((l) => l.id === active.id);
      const toIdx = lists.findIndex((l) => l.id === over.id);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const reorderedLists = arrayMove(lists, fromIdx, toIdx);
      setLists(reorderedLists);
      const listIds = reorderedLists.map((l) => l.id);
      kanbanService.reorderLists(boardId!, listIds)
        .catch((err) => {
          toast.error(t('kanbanBoardPage.toasts.reorderListsError', { defaultValue: 'Falha ao reordenar listas' }));
          // Rollback do estado local se a API falhou.
          void load(boardId!);
          // eslint-disable-next-line no-console
          console.error('reorderLists failed', err);
        });
      return;
    }

    if (!over) { void load(boardId!); return; }

    // Compute target list OUTSIDE setLists to avoid side effects inside state updater
    const targetListId: string | null = (() => {
      if (over.data.current?.type === 'list') return over.data.current.listId as string;
      if (over.data.current?.type === 'column') return over.data.current.listId as string;
      return (
        lists.find(l => l.cards.some(c => c.id === over.id))?.id ??
        lists.find(l => l.cards.some(c => c.id === active.id))?.id ??
        sourceListId
      );
    })();

    if (!targetListId) return;

    const targetList = lists.find(l => l.id === targetListId);
    if (!targetList) return;

    const isCrossListMove = sourceListId !== null && sourceListId !== targetListId;

    if (isCrossListMove) {
      // Check WIP limit
      const wipLimit = targetList.wipLimit ?? 0;
      if (wipLimit > 0 && targetList.cards.length > wipLimit) {
        setMoveBlockDialog({
          title: t('kanbanBoardPage.moveBlock.wipLimitTitle'),
          message: t('kanbanBoardPage.moveBlock.wipLimitMessage', { list: targetList.title, limit: wipLimit }),
        });
        void load(boardId!);
        return;
      }

      // C4: Check card blocking dependencies
      const draggedCard = lists.flatMap(l => l.cards).find(c => c.id === active.id);
      if (draggedCard?.blockedBy?.length) {
        const lastList = lists[lists.length - 1];
        const allCardsFlat = lists.flatMap(l => l.cards);
        const pendingBlockers = draggedCard.blockedBy.filter(blockerId => {
          const blocker = allCardsFlat.find(c => c.id === blockerId);
          // Blocker is pending if found AND not in the last (done) list
          return blocker && blocker.listId !== lastList?.id;
        });
        if (pendingBlockers.length > 0) {
          const blockerTitles = pendingBlockers
            .map(id => allCardsFlat.find(c => c.id === id)?.title ?? id)
            .map(t => `• ${t}`)
            .join('\n');
          setMoveBlockDialog({
            title: t('kanbanBoardPage.moveBlock.blockedTitle', { count: pendingBlockers.length }),
            message: t('kanbanBoardPage.moveBlock.blockedMessage', { blockers: blockerTitles }),
          });
          void load(boardId!);
          return;
        }
      }

      const cardIdx = targetList.cards.findIndex(c => c.id === active.id);
      const position = Math.max(0, cardIdx >= 0 ? cardIdx : targetList.cards.length);
      const targetListTitle = targetList.title;
      const cardId = String(active.id);

      void kanbanService.moveCard(cardId, { targetListId, position })
        .then(updatedCard => {
          setLists(p => p.map(l => ({
            ...l,
            cards: l.cards.map(c => c.id === updatedCard.id
              ? { ...updatedCard, commentCount: (c as any).commentCount }
              : c),
          })));
          // Check for open_app automation rules
          const openAppRules = (board?.automationRules || []).filter(
            r => r.enabled && r.action.type === 'open_app' && r.action.appId
              && r.trigger.type === 'card_moved_to_list' && r.trigger.listId === targetListId
          );
          for (const rule of openAppRules) {
            const appUrl = `/apps/${rule.action.appId}${rule.action.appPageSlug ? `/${rule.action.appPageSlug}` : ''}?cardId=${cardId}&cardTitle=${encodeURIComponent(updatedCard.title)}&listTitle=${encodeURIComponent(targetListTitle)}&boardId=${boardId}`;
            if (rule.action.openMode === 'new_tab') {
              window.open(appUrl, '_blank');
            } else if (rule.action.openMode === 'dialog' || rule.action.openMode === 'sidebar') {
              setAppDialogUrl(appUrl);
              setAppDialogMode(rule.action.openMode || 'dialog');
              setAppDialogTitle(rule.action.appName || t('kanbanBoardPage.defaults.businessApp'));
            }
          }
          // Undo toast for cross-list move. Bug histórico: o callback do
          // react-hot-toast recebe um objeto `t` (toast instance), o que
          // sombreava o `t` da useTranslation aqui dentro — chamar
          // `t('chave')` invocava o objeto-toast como função e disparava
          // "TypeError: t is not a function" no clique do botão.
          if (sourceListId) {
            const tx = t; // captura o tradutor antes do shadowing
            toast((tt) => (
              <span className="flex items-center gap-2 text-sm">
                {tx('kanbanBoardPage.toasts.cardMovedTo')} <b>{targetListTitle}</b>
                <button
                  className="ml-2 rounded bg-[#0055cc] px-2 py-0.5 text-xs text-white hover:bg-[#003d99]"
                  onClick={() => {
                    toast.dismiss(tt.id);
                    void kanbanService.moveCard(cardId, { targetListId: sourceListId, position: 0 })
                      .then(() => { toast.success(tx('kanbanBoardPage.toasts.undoMoveSuccess')); void load(boardId!); })
                      .catch(() => toast.error(tx('kanbanBoardPage.toasts.undoMoveError')));
                  }}
                >
                  {tx('kanbanBoardPage.actions.undo')}
                </button>
              </span>
            ), { duration: 6000 });
          }
        })
        .catch(err => {
          const apiMsg = err?.response?.data?.message;
          setMoveBlockDialog({
            title: t('kanbanBoardPage.moveBlock.moveFailedTitle'),
            message: apiMsg ?? t('kanbanBoardPage.moveBlock.moveFailedMessage'),
          });
          void load(boardId!);
        });

      // handleDragOver already updated visual state — no setLists needed here
      return;
    }

    // Same-list reorder
    const activeIdx = targetList.cards.findIndex(c => c.id === active.id);
    const overCardIdx = targetList.cards.findIndex(c => c.id === over.id);
    const newIdx = overCardIdx >= 0 ? overCardIdx : Math.max(0, targetList.cards.length - 1);

    if (activeIdx < 0 || activeIdx === newIdx) return;

    const reordered = arrayMove(targetList.cards, activeIdx, newIdx);
    setLists(prev => prev.map(l => l.id === targetListId ? { ...l, cards: reordered } : l));
    void kanbanService.moveCard(String(active.id), { targetListId, position: newIdx })
      .catch(() => { toast.error(t('kanbanBoardPage.toasts.reorderCardError')); void load(boardId!); });
  };

  // ── LISTS ──────────────────────────────────────────────────────────────────

  const handleAddList = async () => {
    if (!newListTitle.trim() || !boardId) return;
    try {
      const list = await kanbanService.createList(boardId, { title: newListTitle.trim(), ...(newListColor ? { color: newListColor } : {}) });
      setLists((p) => [...p, { ...list, cards: [] }]);
      setNewListTitle('');
      setNewListColor('');
      setAddingList(false);
    } catch (err: any) {
      const apiMsg = err?.response?.data?.message || err?.response?.data?.errors;
      const msg = Array.isArray(apiMsg) ? apiMsg.join(', ') : (typeof apiMsg === 'string' ? apiMsg : null);
      toast.error(msg || t('kanbanBoardPage.toasts.createListError'));
      console.error('[handleAddList] failed:', err?.response?.status, err?.response?.data, err);
    }
  };

  // ── CARDS ──────────────────────────────────────────────────────────────────

  const handleCardAdded = useCallback((card: KanbanCard) => {
    setLists((prev) => prev.map((l) => l.id === card.listId ? { ...l, cards: [...l.cards, card] } : l));
  }, []);

  const handleCardUpdated = useCallback((updated: KanbanCard) => {
    setLists((prev) => prev.map((l) => ({
      ...l,
      cards: l.cards.map((c) => c.id === updated.id ? { ...updated, commentCount: c.commentCount } : c),
    })));
    setSelectedCard(updated);
  }, []);

  const handleCardDeleted = useCallback((cardId: string) => {
    setLists((prev) => prev.map((l) => ({ ...l, cards: l.cards.filter((c) => c.id !== cardId) })));
  }, []);

  const handleListDeleted = useCallback((listId: string) => {
    setLists((prev) => prev.filter((l) => l.id !== listId));
  }, []);

  const handleListUpdated = useCallback((updated: KanbanList) => {
    setLists((prev) => prev.map((l) => l.id === updated.id ? { ...l, ...updated } : l));
  }, []);

  const handleListCopied = useCallback((newList: KanbanList & { cards: KanbanCard[] }) => {
    setLists((prev) => [...prev, newList]);
  }, []);

  // ── MEMBERS ────────────────────────────────────────────────────────────────

  const addBoardMember = async () => {
    if (!board || !newMemberName.trim()) return;
    const member: KanbanBoardMember = {
      id: `member_${Date.now()}`,
      name: newMemberName.trim(),
      avatarColor: ['#579dff', '#f87168', '#36b37e', '#9f8fef', '#f5cd47'][Math.floor(Math.random() * 5)],
      ...(newMemberEmail.trim() ? { email: newMemberEmail.trim() } : {}),
    };
    try {
      const updated = await kanbanService.updateBoard(board.id, {
        members: [...(board.members || []), member],
      });
      setBoard(updated);
      setNewMemberName('');
      setNewMemberEmail('');
    } catch {
      toast.error(t('kanbanBoardPage.toasts.addMemberError'));
    }
  };

  const removeBoardMember = async (memberId: string) => {
    if (!board) return;
    try {
      const updated = await kanbanService.updateBoard(board.id, {
        members: (board.members || []).filter((m) => m.id !== memberId),
      });
      setBoard(updated);
      setLists((prev) => prev.map((list) => ({
        ...list,
        cards: list.cards.map((card) => ({
          ...card,
          memberIds: (card.memberIds || []).filter((id) => id !== memberId),
        })),
      })));
      setSelectedCard((prev) => prev ? { ...prev, memberIds: (prev.memberIds || []).filter((id) => id !== memberId) } : prev);
    } catch {
      toast.error(t('kanbanBoardPage.toasts.removeMemberError'));
    }
  };

  // C4 – Update member role
  const updateMemberRole = async (memberId: string, role: 'member' | 'manager') => {
    if (!board) return;
    try {
      const updated = await kanbanService.updateBoard(board.id, {
        members: (board.members || []).map(m => m.id === memberId ? { ...m, role } : m),
      });
      setBoard(updated);
    } catch {
      toast.error(t('kanbanBoardPage.toasts.updateMemberRoleError'));
    }
  };

  // C5 – Update board permissions
  const updateBoardPermission = async (key: 'membersCanComment' | 'membersCanEditCards' | 'observersCanView', value: boolean) => {
    if (!board) return;
    try {
      const updated = await kanbanService.updateBoard(board.id, {
        permissions: { ...(board.permissions ?? {}), [key]: value },
      });
      setBoard(updated);
    } catch {
      toast.error(t('kanbanBoardPage.toasts.updatePermissionsError'));
    }
  };

  // ── BOARD LABELS ──────────────────────────────────────────────────────────

  const addBoardLabel = async () => {
    if (!board || !newLabelText.trim()) return;
    const label: KanbanBoardLabel = {
      id: `lbl_${Date.now()}`,
      text: newLabelText.trim(),
      color: newLabelColor,
    };
    const updated = await kanbanService.updateBoard(board.id, {
      boardLabels: [...(board.boardLabels || []), label],
    });
    setBoard(updated);
    setNewLabelText('');
  };

  const removeBoardLabel = async (labelId: string) => {
    if (!board) return;
    const updated = await kanbanService.updateBoard(board.id, {
      boardLabels: (board.boardLabels || []).filter((l) => l.id !== labelId),
    });
    setBoard(updated);
  };

  // ── AUTOMATION RULES ──────────────────────────────────────────────────────
  // Rule creation is handled by KanbanAutomationPanel component

  // Butler NLP parser
  const parseButlerRule = async () => {
    if (!butlerInput.trim() || !board) return;
    setButlerParsing(true);
    try {
      const parsed = await kanbanService.parseButlerRule(board.id, butlerInput.trim());

      const rule: KanbanAutomationRule = {
        id: `rule_${Date.now()}`,
        enabled: true,
        trigger: parsed.trigger as KanbanAutomationRule['trigger'],
        action: parsed.action as KanbanAutomationRule['action'],
        description: parsed.description,
      };

      const updated = await kanbanService.updateBoard(board.id, {
        automationRules: [...(board.automationRules || []), rule],
      });
      setBoard(updated);
      setButlerInput('');
      toast.success(t('kanbanBoardPage.toasts.butlerRuleCreated'));
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || t('kanbanBoardPage.toasts.createRuleError');
      toast.error(msg);
    }
    finally { setButlerParsing(false); }
  };

  const toggleRule = async (ruleId: string) => {
    if (!board) return;
    const updated = await kanbanService.updateBoard(board.id, {
      automationRules: board.automationRules.map(r => r.id === ruleId ? { ...r, enabled: !r.enabled } : r),
    });
    setBoard(updated);
  };

  const deleteRule = async (ruleId: string) => {
    if (!board) return;
    const updated = await kanbanService.updateBoard(board.id, {
      automationRules: board.automationRules.filter(r => r.id !== ruleId),
    });
    setBoard(updated);
    toast.success(t('kanbanBoardPage.toasts.ruleRemoved'));
  };

  // ── BOARD BACKGROUND ───────────────────────────────────────────────────────

  const setBoardBackground = async (color: string) => {
    if (!board) return;
    try {
      const updated = await kanbanService.updateBoard(board.id, { backgroundColor: color, backgroundImage: null });
      setBoard(updated);
    } catch { toast.error(t('kanbanBoardPage.toasts.updateBackgroundError')); }
  };

  const setBoardBackgroundImage = async (url: string) => {
    if (!board) return;
    try {
      const updated = await kanbanService.updateBoard(board.id, { backgroundImage: url || null, backgroundColor: url ? null : undefined });
      setBoard(updated);
    } catch { toast.error(t('kanbanBoardPage.toasts.updateBackgroundImageError')); }
  };

  // ── DUPLICATE BOARD ───────────────────────────────────────────────────────

  const handleDuplicateBoard = async () => {
    if (!board) return;
    try {
      const newBoard = await kanbanService.duplicateBoard(board.id);
      toast.success(t('kanbanBoardPage.toasts.boardCreated', { name: newBoard.title }));
      navigate(`/kanban/${newBoard.id}`);
    } catch { toast.error(t('kanbanBoardPage.toasts.duplicateBoardError')); }
  };

  // ── EXPORT ────────────────────────────────────────────────────────────────

  const handleExportJSON = () => {
    if (!board) return;
    const data = { board: { ...board }, lists };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${board.title.replace(/\s+/g, '-').toLowerCase()}-export.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    if (!board) return;
    const rows: string[][] = [[t('kanbanBoardPage.csvHeaders.id'), t('kanbanBoardPage.csvHeaders.title'), t('kanbanBoardPage.csvHeaders.list'), t('kanbanBoardPage.csvHeaders.members'), t('kanbanBoardPage.csvHeaders.dueDate'), t('kanbanBoardPage.csvHeaders.labels'), t('kanbanBoardPage.csvHeaders.description')]];
    lists.forEach(list => {
      list.cards.forEach(card => {
        rows.push([
          card.id,
          `"${card.title.replace(/"/g, '""')}"`,
          `"${list.title.replace(/"/g, '""')}"`,
          `"${card.memberIds.join('; ')}"`,
          card.dueDate ?? '',
          `"${card.labels.map(l => l.text || l.color).join('; ')}"`,
          `"${(card.description ?? '').slice(0, 200).replace(/"/g, '""').replace(/\n/g, ' ')}"`,
        ]);
      });
    });
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${board.title.replace(/\s+/g, '-').toLowerCase()}-export.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => window.print();

  // ── ARCHIVE ───────────────────────────────────────────────────────────────

  const loadArchivedItems = useCallback(async () => {
    if (!boardId) return;
    setLoadingArchived(true);
    try {
      const { cards, lists: arLists } = await kanbanService.getArchivedItems(boardId);
      setArchivedCards(cards);
      setArchivedLists(arLists);
    } catch { /* silent */ }
    finally { setLoadingArchived(false); }
  }, [boardId]);

  const restoreCard = async (cardId: string) => {
    try {
      const restored = await kanbanService.restoreCard(cardId);
      setArchivedCards(prev => prev.filter(c => c.id !== cardId));
      // Add back to lists state
      setLists(prev => prev.map(l => l.id === restored.listId ? { ...l, cards: [...l.cards, restored] } : l));
      toast.success(t('kanbanBoardPage.toasts.cardRestored'));
    } catch { toast.error(t('kanbanBoardPage.toasts.restoreCardError')); }
  };

  const restoreList = async (listId: string) => {
    try {
      await kanbanService.restoreList(listId);
      setArchivedLists(prev => prev.filter(l => l.id !== listId));
      toast.success(t('kanbanBoardPage.toasts.listRestored'));
      void load(boardId!);
    } catch { toast.error(t('kanbanBoardPage.toasts.restoreListError')); }
  };

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────

  const markAllRead = async () => {
    try {
      await kanbanService.markAllNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    } catch { /* silent */ }
  };

  // ── WATCH (#37) ───────────────────────────────────────────────────────────

  const handleToggleWatch = async () => {
    if (!board) return;
    try {
      const result = await kanbanService.toggleWatchBoard(board.id);
      setIsWatching(result.watching);
      toast.success(result.watching ? t('kanbanBoardPage.toasts.watchEnabled') : t('kanbanBoardPage.toasts.watchDisabled'));
    } catch { toast.error(t('kanbanBoardPage.toasts.watchError')); }
  };

  // ── INVITE (#36) ──────────────────────────────────────────────────────────

  const handleGenerateInviteToken = async () => {
    if (!board) return;
    setGeneratingToken(true);
    try {
      const { token } = await kanbanService.generateInviteToken(board.id);
      setInviteToken(token);
      const url = `${window.location.origin}/kanban/join/${token}`;
      await navigator.clipboard.writeText(url);
      toast.success(t('kanbanBoardPage.toasts.inviteLinkCopied'));
    } catch { toast.error(t('kanbanBoardPage.toasts.generateLinkError')); }
    finally { setGeneratingToken(false); }
  };

  const handleRevokeInviteToken = async () => {
    if (!board) return;
    try {
      await kanbanService.revokeInviteToken(board.id);
      setInviteToken(null);
      toast.success(t('kanbanBoardPage.toasts.linkRevoked'));
    } catch { toast.error(t('kanbanBoardPage.toasts.revokeLinkError')); }
  };

  // ── VISIBILITY (#35) ──────────────────────────────────────────────────────

  const handleVisibilityChange = async (v: 'private'|'workspace'|'public') => {
    if (!board) return;
    try {
      await kanbanService.updateBoard(board.id, { visibility: v } as any);
      setBoardVisibility(v);
      toast.success(t('kanbanBoardPage.toasts.visibilityUpdated'));
    } catch { toast.error(t('kanbanBoardPage.toasts.visibilityError')); }
  };

  // ── POWER-UPS (#44) ───────────────────────────────────────────────────────

  const handleAddPowerUp = async () => {
    if (!board) return;
    try {
      // For Jira, if a temp power-up was created for status fetching, update it
      if (puType === 'jira' && puConfig.__tempPuId) {
        const tempId = puConfig.__tempPuId;
        const { __tempPuId, ...config } = puConfig;
        const updated = await kanbanService.updatePowerUp(tempId, { config });
        setPowerUps((p) => [...p.filter(pu => pu.id !== tempId), updated]);
      } else {
        const pu = await kanbanService.createPowerUp(board.id, { type: puType, config: puConfig });
        setPowerUps((p) => [...p, pu]);
      }
      setShowAddPowerUp(false);
      setPuConfig({});
      setJiraStatuses([]);
      toast.success(t('kanbanBoardPage.toasts.powerUpAdded'));
    } catch { toast.error(t('kanbanBoardPage.toasts.addPowerUpError')); }
  };

  const handleDeletePowerUp = async (id: string) => {
    try {
      await kanbanService.deletePowerUp(id);
      setPowerUps((p) => p.filter((pu) => pu.id !== id));
      toast.success(t('kanbanBoardPage.toasts.powerUpRemoved'));
    } catch { toast.error(t('kanbanBoardPage.toasts.removePowerUpError')); }
  };

  const handleTogglePowerUp = async (id: string, enabled: boolean) => {
    try {
      const updated = await kanbanService.updatePowerUp(id, { enabled });
      setPowerUps((p) => p.map((pu) => pu.id === id ? updated : pu));
    } catch { toast.error(t('kanbanBoardPage.toasts.togglePowerUpError')); }
  };

  const handleLoadPuLogs = async (installationId: string) => {
    if (puLogsInstallId === installationId) {
      setPuLogsInstallId(null);
      setPuLogs([]);
      return;
    }
    setPuLogsInstallId(installationId);
    setPuLogsLoading(true);
    try {
      const logs = await listInstallationLogs(installationId);
      setPuLogs(logs.slice(0, 20));
    } catch {
      toast.error('Erro ao carregar logs');
    } finally {
      setPuLogsLoading(false);
    }
  };

  const handleRefreshPuLogs = async () => {
    if (!puLogsInstallId) return;
    setPuLogsLoading(true);
    try {
      const logs = await listInstallationLogs(puLogsInstallId);
      setPuLogs(logs.slice(0, 20));
    } catch {
      toast.error('Erro ao atualizar logs');
    } finally {
      setPuLogsLoading(false);
    }
  };

  // ── TEMPLATE (#39) ────────────────────────────────────────────────────────

  const handleSaveAsTemplate = async () => {
    if (!board) return;
    try {
      await kanbanService.saveAsTemplate(board.id);
      toast.success(t('kanbanBoardPage.toasts.templateSaved'));
    } catch { toast.error(t('kanbanBoardPage.toasts.saveTemplateError')); }
  };

  // ── CARD PREVIEW FIELDS (A8) ──────────────────────────────────────────────

  const toggleCardPreviewField = (field: string) => {
    setCardPreviewFields(prev => {
      const next = prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field];
      try { localStorage.setItem(`kanban-preview-fields-${boardId}`, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  };

  // ── RENDER ─────────────────────────────────────────────────────────────────
  const bgColor = board?.color ?? '#155eef';
  const bgPageColor = board?.backgroundColor;
  const bgPageImage = board?.backgroundImage;
  // Memoized derivations — prevents downstream re-renders on unrelated state changes
  const boardMembers = useMemo(() => board?.members || [], [board?.members]);
  const boardLabels = useMemo(() => board?.boardLabels || [], [board?.boardLabels]);
  const automationRules = useMemo(() => board?.automationRules || [], [board?.automationRules]);
  const isReadOnly = useMemo(
    () => board?.visibility === 'public' && !boardMembers.some(m => m.email === currentUserEmail),
    [board?.visibility, boardMembers, currentUserEmail]
  );
  const otherOnlineUsers = useMemo(
    () => onlineUsers.filter((u) => u.userId !== currentUserId),
    [onlineUsers, currentUserId]
  );
  const editingUsers = useMemo(() => Array.from(
    cardEditors.reduce((acc, editor) => {
      if (editor.userId === currentUserId || acc.has(editor.userId)) return acc;
      const member = boardMembers.find((bm) => bm.id === editor.userId);
      acc.set(editor.userId, {
        userId: editor.userId,
        name: member?.name || t('kanbanBoardPage.collaborator'),
        color: member?.avatarColor || '#579dff',
      });
      return acc;
    }, new Map<string, { userId: string; name: string; color: string }>()),
  ), [cardEditors, currentUserId, boardMembers]);
  const editingCardsCount = useMemo(
    () => new Set(cardEditors.map((editor) => editor.cardId)).size,
    [cardEditors]
  );

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col bg-[#f3f4f6] dark:bg-[#161b22] overflow-hidden">
        {/* Fake header bar */}
        <div className="h-[52px] bg-white dark:bg-[#0d1117] border-b border-slate-200 dark:border-[#30363d] flex items-center px-6 gap-3 flex-shrink-0">
          <div className="w-24 h-3 rounded-full bg-slate-200 dark:bg-[#30363d] animate-pulse" />
          <div className="w-16 h-3 rounded-full bg-slate-200 dark:bg-[#30363d] animate-pulse" />
          <div className="w-20 h-3 rounded-full bg-slate-200 dark:bg-[#30363d] animate-pulse" />
        </div>

        {/* Fake board toolbar */}
        <div className="h-12 bg-white/60 dark:bg-[#0d1117]/60 border-b border-slate-200/60 dark:border-[#30363d]/60 flex items-center px-6 gap-4 flex-shrink-0">
          <div className="w-32 h-2.5 rounded-full bg-slate-200 dark:bg-[#30363d] animate-pulse" />
          <div className="ml-auto flex gap-3">
            <div className="w-20 h-2.5 rounded-full bg-slate-200 dark:bg-[#30363d] animate-pulse" />
            <div className="w-16 h-2.5 rounded-full bg-slate-200 dark:bg-[#30363d] animate-pulse" />
          </div>
        </div>

        {/* Center logo + message */}
        <div className="flex flex-1 flex-col items-center justify-center gap-8">
          {/* Animated logo */}
          <div className="relative flex items-center justify-center">
            {/* Outer glow ring */}
            <div
              className="absolute rounded-full bg-violet-400/20 dark:bg-violet-500/20"
              style={{
                width: 100, height: 100,
                animation: 'ping 1.6s cubic-bezier(0,0,0.2,1) infinite',
              }}
            />
            {/* Mid ring */}
            <div
              className="absolute rounded-full bg-violet-400/10 dark:bg-violet-500/10"
              style={{
                width: 80, height: 80,
                animation: 'ping 1.6s cubic-bezier(0,0,0.2,1) 0.3s infinite',
              }}
            />
            {/* Logo icon */}
            <img
              src={makestudioIcon}
              alt="MakeStudio"
              className="relative z-10 select-none drop-shadow-xl"
              style={{
                width: 56, height: 56,
                animation: 'ks-float 2.4s ease-in-out infinite',
              }}
            />
          </div>

          <div className="flex flex-col items-center gap-2">
            <p className="text-sm font-semibold text-slate-500 dark:text-slate-400 tracking-wide">
              {t('kanbanBoardPage.loading.board')}<LoadingDots />
            </p>
          </div>
        </div>

        {/* Skeleton columns peeking at bottom */}
        <div className="flex gap-4 px-6 pb-6 overflow-hidden pointer-events-none" style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.15) 100%)' }}>
          {[3, 5, 2, 4, 1].map((count, col) => (
            <div key={col} className="flex-shrink-0 w-[272px] bg-white/70 dark:bg-[#1c2128]/70 rounded-2xl p-3 flex flex-col gap-2">
              <div className="h-3 w-24 rounded-full bg-slate-200 dark:bg-[#30363d] animate-pulse mb-1" />
              {Array.from({ length: count }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl bg-slate-100 dark:bg-[#161b22] p-3 flex flex-col gap-2"
                  style={{ animationDelay: `${(col * 3 + i) * 80}ms` }}
                >
                  <div className="h-2.5 rounded-full bg-slate-200 dark:bg-[#30363d] animate-pulse" style={{ width: `${60 + (i * 17 + col * 11) % 35}%` }} />
                  <div className="h-2 rounded-full bg-slate-100 dark:bg-[#1c2128] animate-pulse" style={{ width: `${40 + (i * 23 + col * 7) % 30}%` }} />
                </div>
              ))}
            </div>
          ))}
        </div>

        <style>{`
          @keyframes ks-float {
            0%, 100% { transform: translateY(0px) scale(1); }
            50% { transform: translateY(-8px) scale(1.04); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col bg-[#f3f4f6] dark:bg-gray-900 ${
        viewMode === 'table' ? 'h-full overflow-y-auto' : 'h-full overflow-hidden'
      }`}
      style={bgPageImage ? { backgroundImage: `url(${bgPageImage})`, backgroundSize: 'cover', backgroundPosition: 'center' } : bgPageColor ? { backgroundColor: bgPageColor } : undefined}
    >
      <div className={`relative rounded-[24px] border border-slate-200/90 bg-white shadow-[0_18px_42px_-28px_rgba(15,23,42,0.22)] dark:border-gray-700 dark:bg-gray-800 ${viewMode === 'table' ? 'min-h-max' : ''}`}>
        {!focusMode && <div className="border-b border-slate-200 dark:border-gray-700 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/kanban')}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-700 transition-colors hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              {editingBoardTitle ? (
                <input
                  autoFocus
                  value={boardTitleDraft}
                  onChange={(e) => setBoardTitleDraft(e.target.value)}
                  onBlur={async () => {
                    const t = boardTitleDraft.trim();
                    setEditingBoardTitle(false);
                    if (!board || !t || t === board.title) return;
                    try {
                      const updated = await kanbanService.updateBoard(board.id, { title: t });
                      setBoard(updated);
                      toast.success('Board renomeado');
                    } catch {
                      toast.error('Falha ao renomear board');
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      if (e.key === 'Escape') setBoardTitleDraft(board?.title ?? '');
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="w-full max-w-[420px] rounded-lg border border-[#0c66e4] bg-white px-2 py-1 text-[18px] font-semibold tracking-[-0.02em] text-slate-900 outline-none dark:border-blue-500 dark:bg-gray-700 dark:text-white"
                />
              ) : (
                <h1
                  onClick={() => {
                    setBoardTitleDraft(board?.title ?? '');
                    setEditingBoardTitle(true);
                  }}
                  title="Clique pra renomear"
                  className="truncate cursor-text rounded text-[18px] font-semibold tracking-[-0.02em] text-slate-900 hover:bg-slate-100 dark:text-white dark:hover:bg-gray-700 px-1 -mx-1"
                >
                  {board?.title}
                </h1>
              )}
              <p className="text-[11px] text-slate-500 dark:text-gray-400">{t('kanbanBoardPage.subtitle')}</p>
            </div>

            {/* Search */}
            <div className="ml-2 hidden min-w-[280px] flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm lg:flex dark:border-gray-600 dark:bg-gray-700">
              <Search className="h-4 w-4 flex-shrink-0 text-slate-400" />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t('kanbanBoardPage.search.placeholder')}
                className="flex-1 bg-transparent text-sm text-slate-700 outline-none placeholder-slate-400 dark:text-gray-200 dark:placeholder-gray-500"
              />
              {searchQuery ? (
                <button onClick={() => setSearchQuery('')} className="text-slate-400 hover:text-slate-600 dark:hover:text-gray-300">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                <kbd className="pointer-events-none hidden lg:inline-flex items-center gap-0.5 rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] text-slate-400 dark:border-gray-600 dark:bg-gray-700">
                  ⌘K
                </kbd>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {/* Grupo 1: Online user presence avatars */}
              {otherOnlineUsers.length > 0 && (() => {
                const others = otherOnlineUsers;
                if (others.length === 0) return null;
                return (
                  <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-700/60" title={others.length === 1 ? t('kanbanBoardPage.presence.oneOnline') : t('kanbanBoardPage.presence.manyOnline', { count: others.length })}>
                    <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    {others.slice(0, 4).map(u => {
                      const m = boardMembers.find(bm => bm.id === u.userId);
                      const displayName = m?.name ?? u.name ?? u.email ?? 'Online';
                      const initials = displayName.slice(0, 2).toUpperCase();
                      const color = m?.avatarColor ?? '#579dff';
                      return (
                        <span
                          key={u.userId}
                          className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white ring-2 ring-white dark:ring-gray-800"
                          style={{ background: color }}
                          title={displayName}
                        >
                          {initials}
                        </span>
                      );
                    })}
                    {others.length > 4 && (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600 ring-2 ring-white dark:bg-gray-700 dark:text-gray-300 dark:ring-gray-800">
                        +{others.length - 4}
                      </span>
                    )}
                  </div>
                );
              })()}
              {otherOnlineUsers.length > 0 && <span className="h-5 w-px bg-slate-200 dark:bg-gray-600 mx-0.5" />}
              {/* Grupo 2: Filtrar + Membros */}
              <div className="relative">
                <button
                  onClick={() => setShowFilterPanel(p => !p)}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${hasActiveFilter ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#1c2b41] dark:text-[#85b8ff]' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                >
                  <Filter className="h-4 w-4" />
                  {t('kanbanBoardPage.filter.button')}
                  {hasActiveFilter && <span className="rounded-full bg-[#0055cc] px-1.5 py-0.5 text-[10px] text-white">{t('kanbanBoardPage.filter.active')}</span>}
                </button>
                {showFilterPanel && (
                  <div className="absolute right-0 top-12 z-30 w-80 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-gray-700 dark:bg-gray-800">
                    <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[#44546f] dark:text-gray-400">{t('kanbanBoardPage.filter.byMember')}</p>
                    <div className="mb-3 space-y-1">
                      <button
                        onClick={() => setFilterMemberId('')}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-left ${!filterMemberId ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#579dff]/20 dark:text-[#85b8ff]' : 'text-[#626f86] hover:bg-slate-50 dark:text-gray-400 dark:hover:bg-gray-700/50'}`}
                      >
                        {t('kanbanBoardPage.filter.allMembers')}
                      </button>
                      {boardMembers.map(m => (
                        <button key={m.id} onClick={() => setFilterMemberId(m.id)}
                          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-left ${filterMemberId === m.id ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#579dff]/20 dark:text-[#85b8ff]' : 'text-[#626f86] hover:bg-slate-50 dark:text-gray-400 dark:hover:bg-gray-700/50'}`}
                        >
                          <span className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: m.avatarColor || '#579dff' }}>
                            {m.name.slice(0,2).toUpperCase()}
                          </span>
                          {m.name}
                        </button>
                      ))}
                      {boardMembers.length === 0 && <p className="text-sm text-[#626f86] px-3 py-2 dark:text-gray-400">{t('kanbanBoardPage.filter.noMembersInBoard')}</p>}
                    </div>

                    {boardLabels.length > 0 && (
                      <>
                        <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[#44546f] dark:text-gray-400">{t('kanbanBoardPage.filter.byLabel')}</p>
                        <div className="mb-3 flex flex-wrap gap-1.5">
                          <button
                            onClick={() => setFilterLabelColor('')}
                            className={`rounded-lg px-2 py-1 text-xs ${!filterLabelColor ? 'bg-slate-200 text-slate-700 dark:bg-white/20 dark:text-white' : 'bg-slate-100 text-[#626f86] hover:bg-slate-200 dark:bg-white/8 dark:text-white/60 dark:hover:bg-white/12'}`}
                          >{t('kanbanBoardPage.filter.allLabels')}</button>
                          {boardLabels.map(lbl => (
                            <button key={lbl.id} onClick={() => setFilterLabelColor(lbl.color)}
                              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-white ${filterLabelColor === lbl.color ? 'ring-2 ring-white/50' : ''}`}
                              style={{ background: lbl.color }}
                            >
                              {filterLabelColor === lbl.color && <Check className="h-3 w-3" />}
                              {lbl.text}
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[#44546f] dark:text-gray-400">{t('kanbanBoardPage.filter.byDueDate')}</p>
                    <div className="mb-3 space-y-1">
                      {[
                        { value: '', label: t('kanbanBoardPage.filter.anyDate') },
                        { value: 'overdue', label: t('kanbanBoardPage.filter.overdue') },
                        { value: 'today', label: t('kanbanBoardPage.filter.dueToday') },
                        { value: 'week', label: t('kanbanBoardPage.filter.dueThisWeek') },
                        { value: 'has', label: t('kanbanBoardPage.filter.hasDate') },
                        { value: 'none', label: t('kanbanBoardPage.filter.noDate') },
                      ].map(opt => (
                        <button key={opt.value} onClick={() => setFilterDueDate(opt.value)}
                          className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-left ${filterDueDate === opt.value ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#579dff]/20 dark:text-[#85b8ff]' : 'text-[#626f86] hover:bg-slate-50 dark:text-gray-400 dark:hover:bg-gray-700/50'}`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[#44546f] dark:text-gray-400">{t('kanbanBoardPage.filter.extras')}</p>
                    <div className="mb-3 space-y-1">
                      <button onClick={() => setFilterNoMembers(p => !p)}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-left ${filterNoMembers ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#579dff]/20 dark:text-[#85b8ff]' : 'text-[#626f86] hover:bg-slate-50 dark:text-gray-400 dark:hover:bg-gray-700/50'}`}
                      >
                        {filterNoMembers && <Check className="h-3.5 w-3.5" />} {t('kanbanBoardPage.filter.noMembers')}
                      </button>
                      <button onClick={() => setFilterHasAttachment(p => !p)}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-left ${filterHasAttachment ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#579dff]/20 dark:text-[#85b8ff]' : 'text-[#626f86] hover:bg-slate-50 dark:text-gray-400 dark:hover:bg-gray-700/50'}`}
                      >
                        {filterHasAttachment && <Check className="h-3.5 w-3.5" />} {t('kanbanBoardPage.filter.hasAttachment')}
                      </button>
                    </div>

                    {hasActiveFilter && (
                      <button onClick={clearFilters} className="mt-2 w-full rounded-xl bg-slate-100 py-2 text-sm text-[#626f86] hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
                        {t('kanbanBoardPage.filter.clearFilters')}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Members editor */}
              <div className="relative">
                <button
                  onClick={() => { setShowMembersEditor((prev) => !prev); setInviteEmailInput(''); }}
                  className="flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                >
                  <Users className="h-4 w-4" />
                  {t('kanbanBoardPage.members.button')}
                  {boardMembers.length ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-gray-600 dark:text-gray-200">{boardMembers.length}</span> : null}
                </button>
                {showMembersEditor && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setShowMembersEditor(false)} />
                    <div className="absolute right-0 top-12 z-30 w-80 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-gray-700 dark:bg-gray-800">
                      <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-[#44546f] dark:text-gray-400">{t('kanbanBoardPage.members.title')}</p>
                      <div className="mb-3 flex flex-col gap-1.5">
                        <div className="flex gap-2">
                          <input
                            value={newMemberName}
                            onChange={(e) => setNewMemberName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && void addBoardMember()}
                            placeholder={t('kanbanBoardPage.members.namePlaceholder')}
                            className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-[#172b4d] outline-none placeholder:text-[#626f86] focus:border-[#579dff] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400"
                          />
                          <button
                            onClick={() => void addBoardMember()}
                            className="rounded-xl bg-[#579dff] px-3 py-2 text-sm font-medium text-white hover:bg-[#4c8fe8]"
                          >
                            {t('kanbanBoardPage.members.addButton')}
                          </button>
                        </div>
                        <input
                          value={newMemberEmail}
                          onChange={(e) => setNewMemberEmail(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void addBoardMember()}
                          placeholder={t('kanbanBoardPage.members.emailPlaceholder')}
                          type="email"
                          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-[#172b4d] outline-none placeholder:text-[#626f86] focus:border-[#579dff] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400"
                        />
                      </div>
                      <div className="space-y-2">
                        {boardMembers.map((member) => (
                          <div key={member.id} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 dark:bg-gray-700/50">
                            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: member.avatarColor || '#579dff' }}>
                              {member.name.slice(0, 2).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-[#172b4d] dark:text-gray-100">{member.name}</p>
                            </div>
                            <select
                              value={member.role ?? 'member'}
                              onChange={e => void updateMemberRole(member.id, e.target.value as 'member' | 'manager')}
                              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-[#44546f] outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
                            >
                              <option value="member">{t('kanbanBoardPage.members.roleOptions.member')}</option>
                              <option value="manager">{t('kanbanBoardPage.members.roleOptions.manager')}</option>
                            </select>
                            <button
                              onClick={() => void removeBoardMember(member.id)}
                              className="rounded-lg px-2 py-1 text-xs text-red-500 hover:bg-red-50 hover:text-red-600 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                            >
                              {t('kanbanBoardPage.members.removeButton')}
                            </button>
                          </div>
                        ))}
                        {boardMembers.length === 0 && (
                          <p className="rounded-xl bg-slate-50 px-3 py-4 text-sm text-[#626f86] dark:bg-gray-700/50 dark:text-gray-400">{t('kanbanBoardPage.members.noMembers')}</p>
                        )}
                      </div>
                      {/* Invite by email */}
                      <div className="mt-3 border-t border-slate-100 pt-3 dark:border-gray-700">
                        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-400">{t('kanbanBoardPage.members.inviteByEmail')}</p>
                        <div className="flex gap-2">
                          <input
                            type="email"
                            value={inviteEmailInput}
                            onChange={e => setInviteEmailInput(e.target.value)}
                            onKeyDown={async e => {
                              if (e.key === 'Enter' && inviteEmailInput.trim() && board) {
                                setSendingInviteEmail(true);
                                try { await kanbanService.inviteByEmail(board.id, inviteEmailInput.trim()); toast.success(t('kanbanBoardPage.toasts.inviteSent')); setInviteEmailInput(''); }
                                catch { toast.error(t('kanbanBoardPage.toasts.inviteError')); }
                                finally { setSendingInviteEmail(false); }
                              }
                            }}
                            placeholder="email@exemplo.com"
                            className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-[#172b4d] outline-none placeholder:text-[#626f86] focus:border-[#579dff] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-400"
                          />
                          <button
                            disabled={!inviteEmailInput.trim() || sendingInviteEmail}
                            onClick={async () => {
                              if (!inviteEmailInput.trim() || !board) return;
                              setSendingInviteEmail(true);
                              try { await kanbanService.inviteByEmail(board.id, inviteEmailInput.trim()); toast.success(t('kanbanBoardPage.toasts.inviteSent')); setInviteEmailInput(''); }
                              catch { toast.error(t('kanbanBoardPage.toasts.inviteError')); }
                              finally { setSendingInviteEmail(false); }
                            }}
                            className="rounded-xl bg-[#579dff] px-3 py-2 text-sm font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-50"
                          >
                            {sendingInviteEmail ? t('kanbanBoardPage.members.sending') : t('kanbanBoardPage.members.sendInvite')}
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <span className="h-5 w-px bg-slate-200 dark:bg-gray-600 mx-0.5" />

              {/* Grupo 3: Global search + Bell + Watch */}
              <button
                onClick={() => setShowSearch(true)}
                title={t('kanbanBoardPage.toolbar.globalSearch')}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              >
                <Globe className="h-4 w-4" />
              </button>

              {/* Notifications bell */}
              <div className="relative">
                <button
                  onClick={() => setShowNotifications(p => !p)}
                  className={`relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${showNotifications ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#1c2b41] dark:text-[#85b8ff]' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                >
                  <Bell className="h-4 w-4" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">{unreadCount > 9 ? '9+' : unreadCount}</span>
                  )}
                </button>
                {showNotifications && (
                  <div className="absolute right-0 top-12 z-30 w-96 rounded-2xl border border-white/15 bg-[#1f2428] shadow-2xl overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                      <span className="text-sm font-semibold text-white">{t('kanbanBoardPage.notifications.title')}</span>
                      {unreadCount > 0 && (
                        <button onClick={() => void markAllRead()} className="text-xs text-[#579dff] hover:underline">{t('kanbanBoardPage.notifications.markAllRead')}</button>
                      )}
                    </div>
                    {/* Type filter tabs */}
                    <div className="flex gap-1 px-3 py-2 border-b border-white/5 overflow-x-auto">
                      {[
                        { key: 'all', label: t('kanbanBoardPage.notifications.tabs.all') },
                        { key: 'mention', label: t('kanbanBoardPage.notifications.tabs.mention') },
                        { key: 'due_soon', label: t('kanbanBoardPage.notifications.tabs.dueSoon') },
                        { key: 'overdue', label: t('kanbanBoardPage.notifications.tabs.overdue') },
                        { key: 'watch', label: t('kanbanBoardPage.notifications.tabs.watch') },
                      ].map(f => (
                        <button
                          key={f.key}
                          onClick={() => setNotifFilter(f.key)}
                          className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${notifFilter === f.key ? 'bg-[#579dff]/20 text-[#85b8ff]' : 'text-white/50 hover:bg-white/8 hover:text-white/70'}`}
                        >
                          {f.label}
                          {f.key !== 'all' && (() => { const c = notifications.filter(n => n.type === f.key && !n.isRead).length; return c > 0 ? <span className="ml-1 rounded-full bg-red-500/80 px-1.5 text-[9px] text-white">{c}</span> : null; })()}
                        </button>
                      ))}
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                      {filteredNotifications.length === 0 ? (
                        <p className="px-4 py-6 text-sm text-white/40 text-center">{t('kanbanBoardPage.notifications.empty')}</p>
                      ) : filteredNotifications.map(n => {
                        const icon = n.type === 'mention' ? '💬' : n.type === 'due_soon' ? '⏰' : n.type === 'overdue' ? '🔴' : n.type === 'watch' ? '👁' : '🔔';
                        return (
                          <button
                            key={n.id}
                            onClick={async () => {
                              if (!n.isRead) {
                                await kanbanService.markNotificationRead(n.id);
                                setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, isRead: true } : x));
                              }
                              if (n.cardId) {
                                const c = lists.flatMap(l => l.cards).find(c => c.id === n.cardId);
                                if (c) { setSelectedCard(c); }
                              }
                              setShowNotifications(false);
                            }}
                            className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-white/6 transition-colors border-b border-white/5 last:border-0 ${!n.isRead ? 'bg-[#579dff]/5' : ''}`}
                          >
                            <span className="mt-0.5 text-sm flex-shrink-0">{icon}</span>
                            <div className="min-w-0 flex-1">
                              <p className={`text-[13px] leading-tight ${!n.isRead ? 'text-white font-medium' : 'text-white/70'}`}>{n.text}</p>
                              <div className="mt-1 flex items-center gap-2">
                                <span className="text-[11px] text-white/40">
                                  {new Date(n.createdAt).toLocaleString('pt-BR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}
                                </span>
                                {!n.isRead && <span className="h-1.5 w-1.5 rounded-full bg-[#579dff]" />}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Watch button (#37) */}
              <button
                onClick={handleToggleWatch}
                title={isWatching ? t('kanbanBoardPage.toolbar.stopWatching') : t('kanbanBoardPage.toolbar.startWatching')}
                className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${isWatching ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300'}`}
              >
                {isWatching ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>

              <span className="h-5 w-px bg-slate-200 dark:bg-gray-600 mx-0.5" />

              {/* Grupo 4: Board panel */}
              <button
                onClick={() => setShowBoardPanel(p => !p)}
                className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${showBoardPanel ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#1c2b41] dark:text-[#85b8ff]' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>}

        {!focusMode && <div className="flex items-center gap-2 border-b border-slate-200/90 dark:border-gray-700 px-4 py-2">
          {/* View mode tabs */}
          <div className="flex rounded-xl border border-slate-200/80 bg-slate-50 p-0.5 dark:border-gray-600/80 dark:bg-gray-700/60">
            <button onClick={() => setViewMode('board')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === 'board' ? 'bg-white text-slate-900 shadow-sm dark:bg-gray-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-gray-400'}`}>
              <KanbanIcon className="h-3.5 w-3.5" /> {t('kanbanBoardPage.viewTabs.board')}
            </button>
            <button onClick={() => setViewMode('calendar')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === 'calendar' ? 'bg-white text-slate-900 shadow-sm dark:bg-gray-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-gray-400'}`}>
              <Calendar className="h-3.5 w-3.5" /> {t('kanbanBoardPage.viewTabs.calendar')}
            </button>
            <button onClick={() => setViewMode('table')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === 'table' ? 'bg-white text-slate-900 shadow-sm dark:bg-gray-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-gray-400'}`}>
              <Table2 className="h-3.5 w-3.5" /> {t('kanbanBoardPage.viewTabs.table')}
            </button>
            <button onClick={() => setViewMode('dashboard')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === 'dashboard' ? 'bg-white text-slate-900 shadow-sm dark:bg-gray-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-gray-400'}`}>
              <Gauge className="h-3.5 w-3.5" /> {t('kanbanBoardPage.viewTabs.dashboard')}
            </button>
            <button onClick={() => setViewMode('timeline')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === 'timeline' ? 'bg-white text-slate-900 shadow-sm dark:bg-gray-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-gray-400'}`}>
              <BarChart2 className="h-3.5 w-3.5" /> {t('kanbanBoardPage.viewTabs.timeline')}
            </button>
            <button onClick={() => setViewMode('map')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === 'map' ? 'bg-white text-slate-900 shadow-sm dark:bg-gray-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-gray-400'}`}>
              <MapPin className="h-3.5 w-3.5" /> {t('kanbanBoardPage.viewTabs.map')}
            </button>
            <button onClick={() => setViewMode('burndown')} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${viewMode === 'burndown' ? 'bg-white text-slate-900 shadow-sm dark:bg-gray-600 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-gray-400'}`}>
              <TrendingDown className="h-3.5 w-3.5" /> {t('kanbanBoardPage.viewTabs.burndown')}
            </button>
          </div>

          <div className="hidden items-center gap-2 text-[11px] font-medium text-slate-500 lg:flex dark:text-gray-400">
            <span>{t('kanbanBoardPage.toolbar.listsCount', { count: lists.length })}</span>
            <span className="text-slate-300 dark:text-gray-600">•</span>
            <span>{t('kanbanBoardPage.toolbar.membersCount', { count: boardMembers.length })}</span>
          </div>
          {editingUsers.length > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              <Pencil className="h-3.5 w-3.5" />
              {t('kanbanBoardPage.toolbar.editingCount', { count: editingUsers.length })}
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                {t('kanbanBoardPage.toolbar.cardsCount', { count: editingCardsCount })}
              </span>
            </div>
          )}
          {automationRules.filter(r => r.enabled).length > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-xl bg-purple-50 px-2.5 py-1.5 text-[11px] font-medium text-purple-600 dark:bg-purple-900/20 dark:text-purple-400">
              <Zap className="h-3.5 w-3.5" />
              {t('kanbanBoardPage.toolbar.automationsCount', { count: automationRules.filter(r => r.enabled).length })}
            </div>
          )}
          {/* Spacer + action buttons */}
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl bg-slate-100/80 p-0.5 dark:bg-gray-700/60">
              <button onClick={handleDuplicateBoard} title={t('kanbanBoardPage.toolbar.duplicateBoard')} className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200 dark:text-gray-400 dark:hover:bg-gray-600">
                <Copy className="h-4 w-4" />
              </button>
              <div className="relative group">
                <button title={t('kanbanBoardPage.toolbar.export')} className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200 dark:text-gray-400 dark:hover:bg-gray-600">
                  <Download className="h-4 w-4" />
                </button>
                <div className="absolute right-0 top-9 z-20 hidden group-hover:block w-36 rounded-xl border border-slate-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
                  <button onClick={handleExportJSON} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-700">
                    {t('kanbanBoardPage.toolbar.exportJson')}
                  </button>
                  <button onClick={handleExportCSV} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-700">
                    {t('kanbanBoardPage.toolbar.exportCsv')}
                  </button>
                  <button onClick={handlePrint} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-700">
                    {t('kanbanBoardPage.toolbar.print')}
                  </button>
                </div>
              </div>
              <button onClick={() => setShowShortcuts(p => !p)} title={t('kanbanBoardPage.toolbar.keyboardShortcuts')} className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200 dark:text-gray-400 dark:hover:bg-gray-600">
                <Keyboard className="h-4 w-4" />
              </button>
              <button
                onClick={() => setFocusMode(true)}
                title={t('kanbanBoardPage.toolbar.focusMode')}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200 dark:text-gray-400 dark:hover:bg-gray-600"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>}

        {/* Active filters bar */}
        {!focusMode && hasActiveFilter && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-6 py-2 dark:border-gray-700 dark:bg-gray-800/50">
            <span className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-[#626f86] shadow-sm dark:bg-gray-700 dark:text-gray-300">
              <Filter className="h-3 w-3" />
              {[
                !!searchQuery,
                !!filterMemberId,
                !!filterLabelColor,
                !!filterDueDate,
                filterNoMembers,
                filterHasAttachment,
              ].filter(Boolean).length} {t('kanbanBoardPage.filter.active')}
            </span>
            {searchQuery && (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-[#44546f] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                <Search className="h-3 w-3" />
                &ldquo;{searchQuery}&rdquo;
                <button onClick={() => setSearchQuery('')} aria-label={t('kanbanBoardPage.filter.removeSearch')} className="ml-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200"><X className="h-3 w-3" /></button>
              </span>
            )}
            {filterMemberId && (() => {
              const m = boardMembers.find(x => x.id === filterMemberId);
              return m ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-[#44546f] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] font-bold text-white" style={{ background: (m as any).avatarColor || '#579dff' }}>{m.name[0]}</span>
                  {m.name}
                  <button onClick={() => setFilterMemberId('')} aria-label={t('kanbanBoardPage.filter.removeMemberFilter')} className="ml-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200"><X className="h-3 w-3" /></button>
                </span>
              ) : null;
            })()}
            {filterLabelColor && (() => {
              const lbl = boardLabels.find(x => x.color === filterLabelColor);
              return (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-[#44546f] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  <span className="h-3 w-3 rounded-full" style={{ background: filterLabelColor }} />
                  {lbl?.text || t('kanbanBoardPage.filter.labelFallback')}
                  <button onClick={() => setFilterLabelColor('')} aria-label={t('kanbanBoardPage.filter.removeLabelFilter')} className="ml-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200"><X className="h-3 w-3" /></button>
                </span>
              );
            })()}
            {filterDueDate && (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-[#44546f] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                <Calendar className="h-3 w-3" />
                {filterDueDate === 'overdue' ? t('kanbanBoardPage.filter.chipOverdue') : filterDueDate === 'today' ? t('kanbanBoardPage.filter.chipToday') : filterDueDate === 'week' ? t('kanbanBoardPage.filter.chipThisWeek') : filterDueDate === 'has' ? t('kanbanBoardPage.filter.chipHasDate') : t('kanbanBoardPage.filter.chipNoDate')}
                <button onClick={() => setFilterDueDate('')} aria-label={t('kanbanBoardPage.filter.removeDateFilter')} className="ml-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200"><X className="h-3 w-3" /></button>
              </span>
            )}
            {filterNoMembers && (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-[#44546f] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {t('kanbanBoardPage.filter.chipNoMembers')}
                <button onClick={() => setFilterNoMembers(false)} aria-label={t('kanbanBoardPage.filter.removeNoMembersFilter')} className="ml-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200"><X className="h-3 w-3" /></button>
              </span>
            )}
            {filterHasAttachment && (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-[#44546f] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {t('kanbanBoardPage.filter.chipHasAttachment')}
                <button onClick={() => setFilterHasAttachment(false)} aria-label={t('kanbanBoardPage.filter.removeAttachmentFilter')} className="ml-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-gray-200"><X className="h-3 w-3" /></button>
              </span>
            )}
            <button onClick={clearFilters} className="ml-1 text-[11px] text-[#0c66e4] hover:underline dark:text-[#85b8ff]">
              {t('kanbanBoardPage.filter.clearAll')}
            </button>
            <div className="ml-auto flex items-center gap-2">
              {/* Saved views dropdown */}
              {savedViews.length > 0 && (
                <div className="relative" ref={savedViewsDropdownRef}>
                  <button
                    onClick={() => setShowSavedViewsDropdown(p => !p)}
                    className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  >
                    <Star className="h-3 w-3 text-amber-400" />
                    {t('kanbanBoardPage.savedViews.button')}
                    <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-500 dark:bg-gray-600 dark:text-gray-400">{savedViews.length}</span>
                  </button>
                  {showSavedViewsDropdown && (
                    <div className="absolute right-0 top-8 z-30 min-w-[220px] rounded-xl border border-slate-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
                      <p className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 dark:text-gray-500">{t('kanbanBoardPage.savedViews.dropdownTitle')}</p>
                      {savedViews.map(view => (
                        <button
                          key={view.id}
                          onClick={() => handleLoadView(view)}
                          className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] text-slate-700 hover:bg-slate-50 dark:text-gray-200 dark:hover:bg-gray-700"
                        >
                          <span className="flex items-center gap-1.5 min-w-0">
                            <Star className="h-3 w-3 flex-shrink-0 text-amber-400" />
                            <span className="truncate">{view.name}</span>
                          </span>
                          <button
                            onClick={(e) => handleDeleteView(view.id, e)}
                            className="flex-shrink-0 rounded p-0.5 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity dark:text-gray-600 dark:hover:text-red-400"
                            title={t('kanbanBoardPage.savedViews.deleteTitle')}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* Save current view button */}
              <button
                onClick={() => { setSaveViewName(''); setShowSaveViewModal(true); }}
                className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-[#0c66e4] hover:bg-[#e9efff] dark:border-gray-600 dark:bg-gray-700 dark:text-[#85b8ff] dark:hover:bg-[#1c2b41]"
              >
                <Star className="h-3 w-3" />
                {t('kanbanBoardPage.savedViews.saveButton')}
              </button>
            </div>
          </div>
        )}

        {/* Save view modal */}
        {showSaveViewModal && (
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.4)' }}
            onClick={(e) => { if (e.target === e.currentTarget) setShowSaveViewModal(false); }}
          >
            <div className="w-80 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-gray-700 dark:bg-gray-800">
              <h3 className="mb-3 text-sm font-bold text-slate-900 dark:text-white">{t('kanbanBoardPage.savedViews.modal.title')}</h3>
              <p className="mb-3 text-[12px] text-slate-500 dark:text-gray-400">
                {t('kanbanBoardPage.savedViews.modal.description')}
              </p>
              <input
                autoFocus
                value={saveViewName}
                onChange={e => setSaveViewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveView(); if (e.key === 'Escape') setShowSaveViewModal(false); }}
                placeholder={t('kanbanBoardPage.savedViews.modal.namePlaceholder')}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-[#579dff] focus:ring-2 focus:ring-[#579dff]/20 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleSaveView}
                  disabled={!saveViewName.trim()}
                  className="flex-1 rounded-xl bg-[#0c66e4] py-2 text-sm font-medium text-white hover:bg-[#0055cc] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('kanbanBoardPage.savedViews.modal.saveButton')}
                </button>
                <button
                  onClick={() => setShowSaveViewModal(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-gray-600 dark:text-gray-300"
                >
                  {t('kanbanBoardPage.savedViews.modal.cancelButton')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Public read-only banner (A9) */}
        {isReadOnly && (
          <div className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-5 py-2 dark:border-blue-900/30 dark:bg-blue-900/10">
            <Globe className="h-4 w-4 flex-shrink-0 text-blue-500" />
            <p className="flex-1 text-sm text-blue-700 dark:text-blue-300">
              {t('kanbanBoardPage.banners.publicReadOnly')} <button onClick={() => navigate('/auth/login')} className="underline hover:no-underline">{t('kanbanBoardPage.banners.publicLogin')}</button> {t('kanbanBoardPage.banners.publicLoginSuffix')}
            </p>
          </div>
        )}

        {/* Overdue banner */}
        {overdueCards.length > 0 && !overdueDismissed && (
          <div className="flex items-center gap-3 border-b border-orange-200 bg-orange-50 px-5 py-3 dark:border-orange-900/30 dark:bg-orange-900/10">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 text-orange-600 dark:text-orange-400" />
            <p className="flex-1 text-sm text-orange-800 dark:text-orange-300">
              <strong>{overdueCards.length}</strong> {t('kanbanBoardPage.banners.overdueCards', { count: overdueCards.length })}
              <button
                onClick={() => {
                  // Aplica o filtro overdue de verdade — antes esse botão
                  // só limpava filtros sem mostrar nada útil. Agora ele
                  // mostra exatamente os cards atrasados pra resolver.
                  setFilterLabelColor('');
                  setSearchQuery('');
                  setFilterMemberId('');
                  setFilterDueDate('overdue');
                }}
                className="ml-2 underline hover:no-underline"
              >
                {t('kanbanBoardPage.banners.viewOverdue')}
              </button>
            </p>
            <button onClick={() => setOverdueDismissed(true)} className="text-orange-500 hover:text-orange-700 dark:text-orange-400">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Focus mode exit button */}
        {focusMode && (
          <button
            onClick={() => setFocusMode(false)}
            title={t('kanbanBoardPage.toolbar.exitFocusTitle')}
            className="absolute top-2 right-2 z-50 flex items-center gap-1.5 rounded-lg bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur-sm hover:bg-slate-700/80 transition-colors"
          >
            <Minimize2 className="h-3.5 w-3.5" /> {t('kanbanBoardPage.toolbar.exitFocusButton')}
          </button>
        )}

        {/* Main area: board + optional right panel */}
        <div className={`${viewMode === 'table' ? 'block overflow-visible' : 'flex flex-1 overflow-hidden'}`}>
          <div className={`${viewMode === 'table' ? 'border-t border-slate-100 p-3.5 overflow-visible' : 'flex-1 border-t border-slate-100 dark:border-gray-700 p-3.5 overflow-hidden'} dark:border-gray-700`}>
            {viewMode === 'calendar' ? (
              <div className="h-full rounded-[20px] border border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
                <CalendarView lists={filteredLists} onCardClick={setSelectedCard} />
              </div>
            ) : viewMode === 'table' ? (
              <div className="min-h-max overflow-visible rounded-[20px] border border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                <TableView lists={filteredLists} boardMembers={boardMembers} onCardClick={setSelectedCard} />
              </div>
            ) : viewMode === 'dashboard' ? (
              <div className="h-full rounded-[20px] border border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
                <DashboardView lists={filteredLists} boardMembers={boardMembers} onCardClick={setSelectedCard} />
              </div>
            ) : viewMode === 'timeline' ? (
              <div className="h-full rounded-[20px] border border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
                <TimelineView lists={filteredLists} onCardClick={setSelectedCard} />
              </div>
            ) : viewMode === 'map' ? (
              <div className="h-full rounded-[20px] border border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
                <MapView lists={filteredLists} onCardClick={setSelectedCard} />
              </div>
            ) : viewMode === 'burndown' ? (
              <div className="h-full rounded-[20px] border border-slate-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
                <BurndownView boardId={board?.id ?? ''} />
              </div>
            ) : (
            <div className="h-full overflow-x-auto overflow-y-hidden rounded-[20px] border border-slate-200 bg-[linear-gradient(180deg,#f8fafc_0%,#eef3f8_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] dark:border-gray-700 dark:bg-gray-900 dark:[background-image:none]">
              <div className="h-1 w-full" style={{ background: `linear-gradient(90deg, ${bgColor} 0%, ${bgColor}cc 100%)` }} />
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
              >
                <div className="flex h-full min-w-max items-start gap-3.5 px-3.5 py-3.5">
                  {lists.length === 0 && !isReadOnly && (
                    <div className="flex w-full items-center justify-center py-20">
                      <div className="flex flex-col items-center gap-5 text-center max-w-sm">
                        <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-gray-700 dark:to-gray-800 shadow-sm">
                          <KanbanIcon className="h-9 w-9 text-slate-400 dark:text-gray-500" />
                        </div>
                        <div>
                          <p className="text-base font-semibold text-slate-700 dark:text-gray-200">{t('kanbanBoardPage.emptyBoard.title')}</p>
                          <p className="mt-1.5 text-sm text-slate-400 dark:text-gray-500 leading-relaxed">{t('kanbanBoardPage.emptyBoard.description')}</p>
                        </div>
                        <button
                          onClick={() => setAddingList(true)}
                          className="flex items-center gap-2 rounded-xl bg-[#0c66e4] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#0055cc] transition-colors shadow-sm"
                        >
                          <Plus className="h-4 w-4" /> {t('kanbanBoardPage.emptyBoard.createButton')}
                        </button>
                      </div>
                    </div>
                  )}
                  <SortableContext
                    items={filteredLists.map((l) => l.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    {filteredLists.map((list) => {
                      // Only pass focusedCardId to the column that actually contains it —
                      // avoids re-rendering every column on J/K keyboard navigation.
                      const listHasFocused = focusedCardId != null && list.cards.some(c => c.id === focusedCardId);
                      return (
                        <KanbanColumn
                          key={list.id}
                          list={list}
                          boardMembers={boardMembers}
                          onCardAdded={handleCardAdded}
                          onCardUpdated={handleCardUpdated}
                          onCardClick={setSelectedCard}
                          onListDeleted={handleListDeleted}
                          onListUpdated={handleListUpdated}
                          onListCopied={handleListCopied}
                          visibleFields={cardPreviewFields.length > 0 ? cardPreviewFields : undefined}
                          cardEditors={cardEditors}
                          matchingCardIds={matchingCardIds}
                          readOnly={!canEditCards}
                          focusedCardId={listHasFocused ? focusedCardId : null}
                        />
                      );
                    })}
                  </SortableContext>

                  {hasActiveFilter && filteredLists.every(l => l.cards.length === 0) && filteredLists.length > 0 && (
                    <div className="flex w-full items-center justify-center py-24">
                      <div className="flex flex-col items-center gap-3 text-center">
                        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-2xl dark:bg-gray-700">
                          🔍
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-600 dark:text-gray-300">{t('kanbanBoardPage.emptyFilter.title')}</p>
                          <p className="mt-1 text-xs text-slate-400 dark:text-gray-500">{t('kanbanBoardPage.emptyFilter.description')}</p>
                        </div>
                        <button
                          onClick={clearFilters}
                          className="mt-1 rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                        >
                          {t('kanbanBoardPage.emptyFilter.clearButton')}
                        </button>
                      </div>
                    </div>
                  )}

                  {!isReadOnly && <div className="w-[282px] flex-shrink-0">
                    {addingList ? (
                      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_10px_24px_-18px_rgba(15,23,42,0.28)] dark:border-gray-600 dark:bg-gray-800">
                        <input
                          autoFocus
                          value={newListTitle}
                          onChange={(e) => setNewListTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleAddList();
                            if (e.key === 'Escape') { setAddingList(false); setNewListTitle(''); setNewListColor(''); }
                          }}
                          placeholder={t('kanbanBoardPage.addList.placeholder')}
                          className="mb-2 w-full rounded-xl border border-[#0c66e4] bg-[#f8fafc] px-3 py-2.5 text-sm text-[#172b4d] outline-none shadow-sm dark:border-blue-500 dark:bg-gray-700 dark:text-gray-100"
                        />
                        {/* Color picker */}
                        <div className="mb-3">
                          <p className="mb-1.5 text-[11px] font-medium text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.addList.colorLabel')}</p>
                          <div className="flex flex-wrap gap-1.5">
                            {[
                              { label: t('kanbanBoardPage.addList.colors.none'), value: '' },
                              { label: t('kanbanBoardPage.addList.colors.blue'), value: '#579dff' },
                              { label: t('kanbanBoardPage.addList.colors.purple'), value: '#9f8fef' },
                              { label: t('kanbanBoardPage.addList.colors.red'), value: '#f87168' },
                              { label: t('kanbanBoardPage.addList.colors.green'), value: '#4bce97' },
                              { label: t('kanbanBoardPage.addList.colors.yellow'), value: '#f5cd47' },
                              { label: t('kanbanBoardPage.addList.colors.orange'), value: '#fea362' },
                              { label: t('kanbanBoardPage.addList.colors.cyan'), value: '#06b6d4' },
                              { label: t('kanbanBoardPage.addList.colors.gray'), value: '#6b7280' },
                              { label: t('kanbanBoardPage.addList.colors.dark'), value: '#1e293b' },
                            ].map(c => (
                              <button
                                key={c.value || "__none__"}
                                type="button"
                                title={c.label}
                                onClick={() => setNewListColor(c.value)}
                                className={`h-5 w-5 rounded border-2 transition-transform hover:scale-110 flex-shrink-0 ${newListColor === c.value ? 'border-[#0c66e4] dark:border-blue-400' : 'border-transparent'} ${!c.value ? 'bg-slate-200 dark:bg-gray-600' : ''}`}
                                style={c.value ? { background: c.value } : undefined}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleAddList()}
                            className="rounded-xl bg-[#0c66e4] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0055cc]"
                          >
                            {t('kanbanBoardPage.addList.addButton')}
                          </button>
                          <button
                            onClick={() => { setAddingList(false); setNewListTitle(''); setNewListColor(''); }}
                            className="flex h-9 w-9 items-center justify-center rounded-xl text-[#44546f] transition-colors hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-700"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setAddingList(true)}
                        className="flex w-full items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-600 transition-colors hover:border-slate-400 hover:bg-slate-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-500 dark:hover:bg-gray-700"
                      >
                        <Plus className="h-4 w-4" /> {t('kanbanBoardPage.addList.addButton')}
                      </button>
                    )}
                  </div>}
                </div>

                <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
                  {activeCard && (
                    <div className="rotate-1 scale-[1.02] shadow-[0_24px_48px_-12px_rgba(15,23,42,0.42)] opacity-95 cursor-grabbing">
                      <KanbanCardItem card={activeCard} onClick={() => {}} boardMembers={boardMembers} />
                    </div>
                  )}
                  {activeColumnId && (() => {
                    const dragged = lists.find((l) => l.id === activeColumnId);
                    if (!dragged) return null;
                    return (
                      <div
                        className="w-[282px] flex-shrink-0 rotate-1 scale-[1.02] cursor-grabbing rounded-[22px] border border-slate-200/90 bg-[#f8fafc] shadow-[0_24px_48px_-12px_rgba(15,23,42,0.42)] dark:border-gray-700 dark:bg-gray-800"
                      >
                        <div
                          className="flex items-center justify-between rounded-t-[22px] px-3.5 pb-2 pt-3"
                          style={dragged.color ? { background: dragged.color } : undefined}
                        >
                          <span className="truncate text-sm font-semibold text-slate-700 dark:text-gray-100">
                            {dragged.title}
                          </span>
                          <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-xs text-slate-600 dark:bg-gray-700 dark:text-gray-300">
                            {dragged.cards.length}
                          </span>
                        </div>
                        <div className="h-24 opacity-40" />
                      </div>
                    );
                  })()}
                </DragOverlay>
              </DndContext>
            </div>
            )}
          </div>

          {/* ── BOARD PANEL (modal) ── moved below, outside flex container */}
        </div>
      </div>

      {/* ── BOARD PANEL MODAL ─────────────────────────────────────────────── */}
      {showBoardPanel && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) setShowBoardPanel(false); }}>
          <div className="flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800" style={{ maxHeight: '90vh' }}>
            <div className="flex items-center gap-2 border-b border-slate-200 dark:border-gray-700 px-4 py-3">
              <div className="flex flex-1 flex-wrap gap-1">
                  {([
                    { id: 'activity', icon: <Activity className="h-3.5 w-3.5" />, label: t('kanbanBoardPage.boardPanel.tabs.activity') },
                    { id: 'labels', icon: <Tag className="h-3.5 w-3.5" />, label: t('kanbanBoardPage.boardPanel.tabs.labels') },
                    { id: 'automation', icon: <Zap className="h-3.5 w-3.5" />, label: t('kanbanBoardPage.boardPanel.tabs.automation') },
                    { id: 'archive', icon: <Archive className="h-3.5 w-3.5" />, label: t('kanbanBoardPage.boardPanel.tabs.archive') },
                    { id: 'powerups', icon: <Plug className="h-3.5 w-3.5" />, label: t('kanbanBoardPage.boardPanel.tabs.powerups') },
                    { id: 'settings', icon: <Globe className="h-3.5 w-3.5" />, label: t('kanbanBoardPage.boardPanel.tabs.settings') },
                    { id: 'repos', icon: <GitBranch className="h-3.5 w-3.5" />, label: t('kanbanBoardPage.boardPanel.tabs.repos') },
                  ] as { id: BoardPanelTab; icon: React.ReactNode; label: string }[]).map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setBoardPanelTab(tab.id)}
                      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${boardPanelTab === tab.id ? 'bg-[#e9efff] text-[#0055cc] dark:bg-[#1c2b41] dark:text-[#85b8ff]' : 'text-[#44546f] hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-700'}`}
                    >
                      {tab.icon} {tab.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => setShowBoardPanel(false)} className="flex-shrink-0 rounded-lg p-1 text-[#44546f] hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-700">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4" style={{ maxHeight: 'calc(90vh - 56px)' }}>
                {/* Activity tab */}
                {boardPanelTab === 'activity' && (
                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">{t('kanbanBoardPage.boardPanel.activity.title')}</h3>
                      <button onClick={() => void loadBoardActivities()} className="text-xs text-[#579dff] hover:underline">{t('kanbanBoardPage.boardPanel.activity.refresh')}</button>
                    </div>
                    {loadingActivities ? (
                      <p className="text-sm text-[#626f86]">{t('kanbanBoardPage.boardPanel.activity.loading')}</p>
                    ) : boardActivities.length === 0 ? (
                      <p className="rounded-xl bg-slate-50 p-4 text-sm text-[#626f86] dark:bg-gray-700 dark:text-gray-400">{t('kanbanBoardPage.boardPanel.activity.empty')}</p>
                    ) : (
                      <div className="space-y-2">
                        {boardActivities.map(act => {
                          const cardTitle = lists.flatMap(l => l.cards).find(c => c.id === act.cardId)?.title;
                          return (
                            <div key={act.id} className={`flex items-start gap-2.5 rounded-xl p-2.5 ${act.type === 'comment' ? 'bg-[#f6f8fb] dark:bg-gray-700' : 'bg-[#f0f4f8] dark:bg-gray-700/50'}`}>
                              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: act.type === 'comment' ? '#579dff' : '#8590a2' }}>
                                {act.type === 'comment' ? (act.userName?.slice(0,1).toUpperCase() ?? '?') : <Clock3 className="h-3.5 w-3.5" />}
                              </div>
                              <div className="min-w-0 flex-1">
                                {act.userName && <span className="mr-1 text-[11px] font-semibold text-[#172b4d] dark:text-gray-200">{act.userName}</span>}
                                <span className={`text-[11px] ${act.type === 'event' ? 'italic text-[#626f86] dark:text-gray-400' : 'text-[#172b4d] dark:text-gray-200'}`}>{act.text}</span>
                                {cardTitle && <p className="text-[10px] text-[#579dff] mt-0.5">{t('kanbanBoardPage.boardPanel.activity.cardPrefix')}{cardTitle}</p>}
                                <p className="mt-0.5 text-[10px] text-[#8590a2]">
                                  {new Date(act.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Labels tab */}
                {boardPanelTab === 'labels' && (
                  <div>
                    <h3 className="mb-3 text-sm font-semibold text-[#172b4d] dark:text-gray-100">{t('kanbanBoardPage.boardPanel.labels.title')}</h3>
                    <p className="mb-3 text-xs text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.labels.description')}</p>

                    {/* Existing labels */}
                    {boardLabels.length > 0 && (
                      <div className="mb-4 space-y-2">
                        {boardLabels.map(lbl => (
                          <div key={lbl.id} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 dark:bg-gray-700">
                            <div className="h-6 w-6 rounded-md flex-shrink-0" style={{ background: lbl.color }} />
                            <span className="flex-1 text-sm font-medium text-[#172b4d] dark:text-gray-200">{lbl.text}</span>
                            <button onClick={() => void removeBoardLabel(lbl.id)} className="text-[#626f86] hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add label form */}
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-gray-600 dark:bg-gray-700">
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.labels.newLabel')}</p>
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {LABEL_PALETTE.map(c => (
                          <button key={c} onClick={() => setNewLabelColor(c)}
                            className="h-7 w-7 rounded-md flex-shrink-0 transition-all hover:scale-105"
                            style={{ background: c, outline: newLabelColor === c ? '3px solid #579dff' : 'none', outlineOffset: '2px' }}
                          />
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={newLabelText}
                          onChange={e => setNewLabelText(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && void addBoardLabel()}
                          placeholder={t('kanbanBoardPage.boardPanel.labels.namePlaceholder')}
                          className="flex-1 rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#282e33] dark:text-gray-200"
                        />
                        <button onClick={() => void addBoardLabel()} className="rounded-lg bg-[#579dff] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#4c8fe8]">
                          {t('kanbanBoardPage.boardPanel.labels.addButton')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Automation tab */}
                {boardPanelTab === 'automation' && board && (
                  <div>
                    <KanbanAutomationPanel
                      board={board}
                      lists={lists}
                      boardMembers={boardMembers}
                      automationActivities={automationActivities}
                      butlerInput={butlerInput}
                      butlerParsing={butlerParsing}
                      onButlerInputChange={setButlerInput}
                      onParseButlerRule={() => void parseButlerRule()}
                      onToggleRule={(id) => void toggleRule(id)}
                      onDeleteRule={(id) => void deleteRule(id)}
                      onAddRule={async (rule) => {
                        if (!board) return;
                        const updated = await kanbanService.updateBoard(board.id, {
                          automationRules: [...(board.automationRules || []), rule],
                        });
                        setBoard(updated);
                        toast.success(t('kanbanBoardPage.toasts.automationRuleCreated'));
                      }}
                    />

                  </div>
                )}

                {/* Archive tab */}
                {boardPanelTab === 'archive' && (
                  <div>
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Archive className="h-4 w-4 text-[#626f86] dark:text-gray-400" />
                        <h3 className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">
                          {t('kanbanBoardPage.boardPanel.archive.title')}
                          {(archivedCards.length + archivedLists.length) > 0 && (
                            <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-[#626f86] dark:bg-gray-700 dark:text-gray-400">
                              {archivedCards.length + archivedLists.length}
                            </span>
                          )}
                        </h3>
                      </div>
                      <button onClick={() => void loadArchivedItems()} className="text-xs text-[#579dff] hover:underline">{t('kanbanBoardPage.boardPanel.archive.refresh')}</button>
                    </div>
                    {loadingArchived ? (
                      <div className="flex items-center justify-center py-8 text-sm text-[#626f86] dark:text-gray-400">
                        <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-[#0c66e4] border-t-transparent" />
                        {t('kanbanBoardPage.boardPanel.archive.loading')}
                      </div>
                    ) : (
                      <>
                        {archivedCards.length === 0 && archivedLists.length === 0 && (
                          <div className="flex flex-col items-center py-10 text-[#8590a2] dark:text-gray-500">
                            <Archive className="mb-2 h-8 w-8 opacity-40" />
                            <p className="text-sm font-medium">{t('kanbanBoardPage.boardPanel.archive.empty')}</p>
                            <p className="mt-1 text-center text-xs max-w-[200px]">{t('kanbanBoardPage.boardPanel.archive.emptyDesc')}</p>
                          </div>
                        )}
                        {archivedLists.length > 0 && (
                          <div className="mb-4">
                            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.archive.listsSection', { count: archivedLists.length })}</p>
                            {archivedLists.map(list => (
                              <div key={list.id} className="mb-2 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 dark:bg-gray-700">
                                <span className="text-sm text-[#172b4d] dark:text-gray-200 truncate flex-1 mr-2">{list.title}</span>
                                <button onClick={() => restoreList(list.id)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[#579dff] hover:bg-[#e9efff] dark:hover:bg-[#1c2b41] flex-shrink-0">
                                  <RotateCcw className="h-3 w-3" /> {t('kanbanBoardPage.boardPanel.archive.restore')}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        {archivedLists.length > 0 && archivedCards.length > 0 && (
                          <div className="my-3 border-t border-slate-200 dark:border-gray-700" />
                        )}
                        {archivedCards.length > 0 && (
                          <div>
                            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.archive.cardsSection', { count: archivedCards.length })}</p>
                            {archivedCards.map(card => (
                              <div key={card.id} className="mb-2 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 dark:bg-gray-700">
                                <div className="min-w-0 flex-1 mr-2">
                                  <p className="text-sm text-[#172b4d] dark:text-gray-200 truncate">{card.title}</p>
                                  <p className="text-[11px] text-[#626f86] dark:text-gray-500">
                                    {lists.find(l => l.id === card.listId)?.title ?? t('kanbanBoardPage.boardPanel.archive.removedList')}
                                    {card.updatedAt && (
                                      <span className="ml-1.5 opacity-70">· {t('kanbanBoardPage.boardPanel.archive.archivedAt', { date: new Date(card.updatedAt).toLocaleDateString(i18n.language) })}</span>
                                    )}
                                  </p>
                                </div>
                                <button onClick={() => restoreCard(card.id)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[#579dff] hover:bg-[#e9efff] dark:hover:bg-[#1c2b41] flex-shrink-0">
                                  <RotateCcw className="h-3 w-3" /> {t('kanbanBoardPage.boardPanel.archive.restore')}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Power-Ups tab (#44) */}
                {boardPanelTab === 'powerups' && (
                  <div className="space-y-3">
                    {/* Criar provider customizado */}
                    <button
                      onClick={() => { setEditingPuTemplate(null); setShowPuWizard(true); }}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#0c66e4] px-3 py-2.5 text-sm font-medium text-[#0c66e4] hover:bg-[#e9efff] transition-colors"
                    >
                      {t('kanbanBoardPage.boardPanel.powerups.createCustom')}
                    </button>

                    {/* Meus providers */}
                    {myTemplates.length > 0 && (
                      <div className="mt-2">
                        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.powerups.myProviders')}</p>
                        <div className="space-y-2">
                          {myTemplates.map(tpl => (
                            <div key={tpl.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 dark:border-gray-600">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-lg">{tpl.icon}</span>
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-[#172b4d] dark:text-white">{tpl.name}</p>
                                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                                    tpl.status === 'draft' ? 'bg-slate-100 text-[#626f86]' :
                                    tpl.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                                    tpl.status === 'rejected' ? 'bg-red-100 text-red-700' :
                                    'bg-green-100 text-green-700'
                                  }`}>{STATUS_LABELS[tpl.status]}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {['draft', 'rejected'].includes(tpl.status) && (
                                  <>
                                    <button onClick={() => { setEditingPuTemplate(tpl); setShowPuWizard(true); }}
                                      className="rounded-lg px-2 py-1 text-xs text-[#626f86] hover:bg-slate-100 dark:hover:bg-gray-700">{t('kanbanBoardPage.boardPanel.powerups.editButton')}</button>
                                    {tpl.status === 'draft' && (
                                      <button onClick={async () => {
                                        try { const updated = await submitPuTemplate(tpl.id); setMyTemplates(p => p.map(t => t.id === tpl.id ? updated : t)); toast.success(t('kanbanBoardPage.toasts.templateSaved')); }
                                        catch { toast.error(t('kanbanBoardPage.toasts.saveTemplateError')); }
                                      }} className="rounded-lg px-2 py-1 text-xs text-[#0c66e4] hover:bg-[#e9efff]">{t('kanbanBoardPage.boardPanel.powerups.submitButton')}</button>
                                    )}
                                    <button onClick={async () => {
                                      try { await deletePuTemplate(tpl.id); setMyTemplates(p => p.filter(t => t.id !== tpl.id)); toast.success(t('kanbanBoardPage.toasts.powerUpRemoved')); }
                                      catch { toast.error(t('kanbanBoardPage.toasts.removePowerUpError')); }
                                    }} className="rounded-lg px-2 py-1 text-xs text-red-500 hover:bg-red-50">{t('kanbanBoardPage.boardPanel.powerups.deleteButton')}</button>
                                  </>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Disponíveis para instalar */}
                    {availableTemplates.length > 0 && (
                      <div className="mt-2">
                        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.powerups.available')}</p>
                        <div className="space-y-2">
                          {availableTemplates.map(tpl => (
                            <div key={tpl.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 dark:border-gray-600">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-lg">{tpl.icon}</span>
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-[#172b4d] dark:text-white">{tpl.name}</p>
                                  {tpl.description && <p className="truncate text-xs text-[#626f86]">{tpl.description}</p>}
                                </div>
                              </div>
                              <button onClick={() => setInstallingTemplate(tpl)}
                                className="flex-shrink-0 rounded-xl bg-[#0c66e4] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0055cc]">
                                {t('kanbanBoardPage.boardPanel.powerups.installButton')}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.powerups.installed')}</p>
                    {powerUps.length === 0 && (
                      <p className="rounded-xl bg-slate-50 p-4 text-sm text-[#626f86] dark:bg-gray-700 dark:text-gray-400">{t('kanbanBoardPage.boardPanel.powerups.noInstalled')}</p>
                    )}
                    {powerUps.map((pu) => (
                      <div key={pu.id} className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-gray-700">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">
                              {pu.type === 'slack' ? '💬' : pu.type === 'github' ? '🐙' : pu.type === 'jira' ? '🎯' : pu.type === 'google_drive' ? '📁' : pu.type === 'confluence' ? '📄' : pu.type === 'giphy' ? '🎞️' : pu.type === 'email_to_card' ? '📧' : pu.type === 'burndown' ? '📉' : '🔌'}
                            </span>
                            <div>
                              <p className="text-sm font-medium text-[#172b4d] dark:text-gray-200 capitalize">{pu.type}</p>
                              <p className="text-xs text-[#626f86] dark:text-gray-400">{pu.enabled ? t('kanbanBoardPage.boardPanel.powerups.enabled') : t('kanbanBoardPage.boardPanel.powerups.disabled')}</p>
                            </div>
                          </div>
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleLoadPuLogs(pu.id)}
                              className={`rounded-lg px-2 py-1 text-xs ${puLogsInstallId === pu.id ? 'text-[#0c66e4] bg-[#e9efff]' : 'text-[#626f86] hover:bg-slate-100 dark:hover:bg-gray-600'}`}
                              title="Ver logs de execução"
                            >
                              <List className="h-3 w-3" />
                            </button>
                            <button onClick={() => handleTogglePowerUp(pu.id, !pu.enabled)} className={`rounded-lg px-2 py-1 text-xs ${pu.enabled ? 'text-yellow-600 hover:bg-yellow-50' : 'text-green-600 hover:bg-green-50'}`}>
                              {pu.enabled ? t('kanbanBoardPage.boardPanel.powerups.disableButton') : t('kanbanBoardPage.boardPanel.powerups.enableButton')}
                            </button>
                            <button onClick={() => handleDeletePowerUp(pu.id)} className="rounded-lg px-2 py-1 text-xs text-red-400 hover:bg-red-50">{t('kanbanBoardPage.boardPanel.powerups.removeButton')}</button>
                          </div>
                        </div>
                        {pu.type === 'jira' && pu.config?.domain && (
                          <div className="mt-2 space-y-1 border-t border-slate-200 dark:border-gray-600 pt-2">
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.powerups.jira.projectPrefix')}<span className="font-medium">{pu.config.projectKey}</span> · {pu.config.domain}.atlassian.net</p>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {pu.config.syncOnCreate ? '✓ Criar' : '✗ Criar'} · {pu.config.syncOnMove ? '✓ Mover' : '✗ Mover'} · {pu.config.syncOnComment ? '✓ Comentários' : '✗ Comentários'}
                            </p>
                            {pu.config.statusMapping?.length > 0 && (
                              <p className="text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.powerups.jira.statusMappingCount', { count: pu.config.statusMapping.length })}</p>
                            )}
                            <div className="mt-1 rounded-lg bg-slate-100 dark:bg-gray-800 p-2">
                              <p className="text-[9px] font-bold uppercase tracking-wider text-[#44546f] dark:text-gray-500 mb-0.5">{t('kanbanBoardPage.boardPanel.powerups.jira.webhookLabel')}</p>
                              <p className="text-[10px] text-[#0c66e4] dark:text-[#85b8ff] break-all select-all font-mono">{`${window.location.origin}/api/v1/kanban/boards/${pu.boardId}/jira-webhook`}</p>
                            </div>
                          </div>
                        )}
                        {pu.type === 'github' && pu.config?.repoOwner && (
                          <div className="mt-2 space-y-1 border-t border-slate-200 dark:border-gray-600 pt-2">
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.github.repoPrefix')}<span className="font-medium">{pu.config.repoOwner}/{pu.config.repoName}</span>
                            </p>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {pu.config.syncOnCreate ? '✓ Issues' : '✗ Issues'} · {pu.config.syncOnComment ? '✓ Comentários' : '✗ Comentários'} · {pu.config.createBranchOnCard ? '✓ Branches' : '✗ Branches'}
                            </p>
                            {pu.config.targetListId && (
                              <p className="text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.powerups.github.prMergeList')}<span className="font-medium">{lists.find(l => l.id === pu.config.targetListId)?.title || 'N/A'}</span></p>
                            )}
                            <div className="mt-1 rounded-lg bg-slate-100 dark:bg-gray-800 p-2">
                              <p className="text-[9px] font-bold uppercase tracking-wider text-[#44546f] dark:text-gray-500 mb-0.5">{t('kanbanBoardPage.boardPanel.powerups.github.webhookLabel')}</p>
                              <p className="text-[10px] text-[#0c66e4] dark:text-[#85b8ff] break-all select-all font-mono">{`${window.location.origin}/api/v1/kanban/boards/${pu.boardId}/github-webhook`}</p>
                            </div>
                          </div>
                        )}
                        {pu.type === 'slack' && pu.config?.webhookUrl && (
                          <div className="mt-2 space-y-1 border-t border-slate-200 dark:border-gray-600 pt-2">
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              Canal: <span className="font-medium">{pu.config.channel || '#geral'}</span>
                            </p>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {pu.config.notifyOnCreate ? '✓ Criação' : '✗ Criação'} · {pu.config.notifyOnMove ? '✓ Mover' : '✗ Mover'} · {pu.config.notifyOnComment ? '✓ Comentários' : '✗ Comentários'} · {pu.config.notifyOnArchive ? '✓ Arquivar' : '✗ Arquivar'}
                            </p>
                          </div>
                        )}
                        {pu.type === 'google_drive' && (
                          <div className="mt-2 border-t border-slate-200 dark:border-gray-600 pt-2">
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.powerups.googleDrive.connectedDesc')}</p>
                          </div>
                        )}
                        {pu.type === 'confluence' && pu.config?.domain && (
                          <div className="mt-2 border-t border-slate-200 dark:border-gray-600 pt-2">
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              Confluence: <span className="font-medium">{pu.config.domain}.atlassian.net</span>
                              {pu.config.spaceKey && <> · {t('kanbanBoardPage.boardPanel.powerups.confluence.spacePrefix')}<span className="font-medium">{pu.config.spaceKey}</span></>}
                            </p>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.powerups.confluence.linkedPagesDesc')}</p>
                          </div>
                        )}
                        {pu.type === 'email_to_card' && (
                          <div className="mt-2 border-t border-slate-200 dark:border-gray-600 pt-2">
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.emailToCard.targetListPrefix')}<span className="font-medium">{lists.find(l => l.id === pu.config?.targetListId)?.title || 'N/A'}</span>
                            </p>
                            <div className="mt-1 rounded-lg bg-slate-100 dark:bg-gray-800 p-2">
                              <p className="text-[9px] font-bold uppercase tracking-wider text-[#44546f] dark:text-gray-500 mb-0.5">{t('kanbanBoardPage.boardPanel.powerups.emailToCard.webhookLabel')}</p>
                              <p className="text-[10px] text-[#0c66e4] dark:text-[#85b8ff] break-all select-all font-mono">{`${window.location.origin}/api/v1/kanban/boards/${pu.boardId}/email-to-card/incoming`}</p>
                            </div>
                            {pu.config?.allowedSenders?.length > 0 && (
                              <p className="text-[10px] text-[#626f86] dark:text-gray-400 mt-1">{t('kanbanBoardPage.boardPanel.powerups.emailToCard.allowedSendersPrefix')}{pu.config.allowedSenders.join(', ')}</p>
                            )}
                          </div>
                        )}
                        {pu.type === 'burndown' && (
                          <div className="mt-2 border-t border-slate-200 dark:border-gray-600 pt-2">
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.burndown.sprintLabel', { days: pu.config?.sprintDurationDays || 14 })}
                              {pu.config?.sprintStartDate && <> {t('nodes.kanbanBoardPage.tsx.inicio')}<span className="font-medium">{pu.config.sprintStartDate}</span></>}
                            </p>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.burndown.trackingLabel')}<span className="font-medium">{pu.config?.trackingField === 'points' ? t('kanbanBoardPage.boardPanel.powerups.burndown.storyPoints') : t('kanbanBoardPage.boardPanel.powerups.burndown.cards')}</span>
                              · {t('kanbanBoardPage.boardPanel.powerups.burndown.doneListsCount', { count: pu.config?.doneListIds?.length || 0 })}
                            </p>
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Execution Logs section */}
                    {puLogsInstallId && (
                      <div className="mt-3 rounded-xl border border-slate-200 dark:border-gray-600 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-gray-750 border-b border-slate-200 dark:border-gray-600">
                          <div className="flex items-center gap-1.5">
                            <List className="h-3.5 w-3.5 text-[#44546f] dark:text-gray-400" />
                            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-400">Logs de Execução</span>
                            <span className="text-[10px] text-[#626f86] dark:text-gray-500">(últimas 20)</span>
                          </div>
                          <button
                            onClick={handleRefreshPuLogs}
                            disabled={puLogsLoading}
                            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[#626f86] hover:bg-slate-100 dark:hover:bg-gray-600 disabled:opacity-50"
                          >
                            <RefreshCw className={`h-3 w-3 ${puLogsLoading ? 'animate-spin' : ''}`} />
                            Atualizar
                          </button>
                        </div>
                        <div className="divide-y divide-slate-100 dark:divide-gray-700 max-h-64 overflow-y-auto">
                          {puLogsLoading && puLogs.length === 0 ? (
                            <div className="flex items-center justify-center py-6">
                              <Loader2 className="h-4 w-4 animate-spin text-[#626f86]" />
                            </div>
                          ) : puLogs.length === 0 ? (
                            <p className="px-3 py-4 text-center text-xs text-[#626f86] dark:text-gray-400">Nenhuma execução registrada</p>
                          ) : (
                            puLogs.map((log) => (
                              <div key={log.id} className="px-3 py-2">
                                <div className="flex items-start gap-2">
                                  {log.error ? (
                                    <XCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-red-500" />
                                  ) : (
                                    <CheckCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-green-500" />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-[10px] font-medium text-[#172b4d] dark:text-gray-200">{log.eventType}</span>
                                      {log.statusCode != null && (
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${log.statusCode >= 200 && log.statusCode < 300 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                                          {log.statusCode}
                                        </span>
                                      )}
                                      <span className="text-[10px] text-[#626f86] dark:text-gray-500">
                                        {new Date(log.executedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                      </span>
                                    </div>
                                    {log.error && (
                                      <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400 truncate">{log.error}</p>
                                    )}
                                    {!log.error && log.responseSnippet && (
                                      <p className="mt-0.5 text-[10px] text-[#626f86] dark:text-gray-500 truncate font-mono">{log.responseSnippet}</p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}

                    {!showAddPowerUp ? (
                      <button onClick={() => setShowAddPowerUp(true)} className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-[#0c66e4] hover:bg-[#e9efff] dark:text-[#85b8ff] dark:hover:bg-[#1c2b41]">
                        <Plus className="h-3 w-3" /> {t('kanbanBoardPage.boardPanel.powerups.addButton')}
                      </button>
                    ) : (
                      <div className="space-y-2 pt-2">
                        <select value={puType} onChange={(e) => { setPuType(e.target.value as typeof puType); setPuConfig({}); setJiraStatuses([]); }}
                          className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          <option value="slack">Slack</option>
                          <option value="github">GitHub</option>
                          <option value="jira">Jira</option>
                          <option value="google_drive">Google Drive</option>
                          <option value="confluence">Confluence</option>
                          <option value="giphy">Giphy</option>
                          <option value="email_to_card">Email-to-Card</option>
                          <option value="burndown">Burndown Chart</option>
                        </select>
                        {puType === 'slack' && (
                          <div className="space-y-2">
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.slack.webhookPlaceholder')} value={puConfig.webhookUrl ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, webhookUrl: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.slack.channelPlaceholder')} value={puConfig.channel ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, channel: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <p className="text-[10px] font-bold uppercase tracking-wider text-[#44546f] dark:text-gray-500 pt-1">{t('kanbanBoardPage.boardPanel.powerups.slack.notificationsTitle')}</p>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={puConfig.notifyOnCreate !== false} onChange={(e) => setPuConfig((c) => ({ ...c, notifyOnCreate: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.slack.notifyCreate')}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={puConfig.notifyOnMove !== false} onChange={(e) => setPuConfig((c) => ({ ...c, notifyOnMove: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.slack.notifyMove')}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={puConfig.notifyOnComment !== false} onChange={(e) => setPuConfig((c) => ({ ...c, notifyOnComment: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.slack.notifyComment')}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={puConfig.notifyOnArchive !== false} onChange={(e) => setPuConfig((c) => ({ ...c, notifyOnArchive: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.slack.notifyArchive')}
                            </label>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.slack.helpText')}
                            </p>
                          </div>
                        )}
                        {puType === 'github' && (
                          <div className="space-y-2">
                            <input type="password" placeholder={t('kanbanBoardPage.boardPanel.powerups.github.tokenPlaceholder')} value={puConfig.token ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, token: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.github.repoOwnerPlaceholder')} value={puConfig.repoOwner ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, repoOwner: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.github.repoNamePlaceholder')} value={puConfig.repoName ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, repoName: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <select value={puConfig.targetListId ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, targetListId: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                              <option value="">{t('kanbanBoardPage.boardPanel.powerups.github.targetListPlaceholder')}</option>
                              {lists.filter(l => !l.isArchived).map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                            </select>
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.github.webhookSecretPlaceholder')} value={puConfig.webhookSecret ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, webhookSecret: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <p className="text-[10px] font-bold uppercase tracking-wider text-[#44546f] dark:text-gray-500 pt-1">{t('kanbanBoardPage.boardPanel.powerups.github.syncTitle')}</p>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={!!puConfig.syncOnCreate} onChange={(e) => setPuConfig((c) => ({ ...c, syncOnCreate: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.github.syncOnCreate')}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={!!puConfig.syncOnComment} onChange={(e) => setPuConfig((c) => ({ ...c, syncOnComment: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.github.syncOnComment')}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={!!puConfig.createBranchOnCard} onChange={(e) => setPuConfig((c) => ({ ...c, createBranchOnCard: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.github.createBranch')}
                            </label>
                            {puConfig.createBranchOnCard && (
                              <input placeholder={t('kanbanBoardPage.boardPanel.powerups.github.branchPrefixPlaceholder')} value={puConfig.branchPrefix ?? 'feature/'} onChange={(e) => setPuConfig((c) => ({ ...c, branchPrefix: e.target.value }))}
                                className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            )}
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.github.helpText')} <code className="bg-slate-100 dark:bg-gray-800 px-1 rounded">repo</code>. Configure o webhook no repo apontando para a URL abaixo.
                            </p>
                          </div>
                        )}
                        {puType === 'jira' && (
                          <div className="space-y-2">
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.jira.domainPlaceholder')} value={puConfig.domain ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, domain: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.jira.emailPlaceholder')} value={puConfig.email ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, email: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input type="password" placeholder={t('kanbanBoardPage.boardPanel.powerups.jira.apiTokenPlaceholder')} value={puConfig.apiToken ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, apiToken: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.jira.projectKeyPlaceholder')} value={puConfig.projectKey ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, projectKey: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.jira.issueTypePlaceholder')} value={puConfig.issueType ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, issueType: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <p className="text-[10px] font-bold uppercase tracking-wider text-[#44546f] dark:text-gray-500 pt-1">{t('kanbanBoardPage.boardPanel.powerups.jira.syncTitle')}</p>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={!!puConfig.syncOnCreate} onChange={(e) => setPuConfig((c) => ({ ...c, syncOnCreate: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.jira.syncOnCreate')}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={!!puConfig.syncOnMove} onChange={(e) => setPuConfig((c) => ({ ...c, syncOnMove: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.jira.syncOnMove')}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={!!puConfig.syncOnComment} onChange={(e) => setPuConfig((c) => ({ ...c, syncOnComment: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.jira.syncOnComment')}
                            </label>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-[#44546f] dark:text-gray-500 pt-1">{t('kanbanBoardPage.boardPanel.powerups.jira.statusMappingTitle')}</p>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.powerups.jira.statusMappingDesc')}</p>
                            {!jiraStatuses.length && puConfig.domain && puConfig.email && puConfig.apiToken && puConfig.projectKey && (
                              <button
                                onClick={async () => {
                                  if (!board) return;
                                  setLoadingJiraStatuses(true);
                                  try {
                                    // First save the power-up to fetch statuses, or use a temp approach
                                    // We'll create a temp power-up, fetch statuses, then let the user configure
                                    const tempPu = await kanbanService.createPowerUp(board.id, { type: 'jira', config: { domain: puConfig.domain, email: puConfig.email, apiToken: puConfig.apiToken, projectKey: puConfig.projectKey, statusMapping: [] } });
                                    const statuses = await kanbanService.getJiraStatuses(board.id);
                                    setJiraStatuses(statuses);
                                    // Store the temp power-up id for cleanup / update later
                                    setPuConfig((c) => ({ ...c, __tempPuId: tempPu.id }));
                                    toast.success(t('kanbanBoardPage.toasts.jiraStatusFound', { count: statuses.length }));
                                  } catch {
                                    toast.error(t('kanbanBoardPage.toasts.jiraStatusError'));
                                  } finally {
                                    setLoadingJiraStatuses(false);
                                  }
                                }}
                                disabled={loadingJiraStatuses}
                                className="w-full rounded-lg border border-[#0c66e4] px-2 py-1.5 text-xs text-[#0c66e4] hover:bg-[#e9efff] disabled:opacity-50 dark:border-[#85b8ff] dark:text-[#85b8ff]"
                              >
                                {loadingJiraStatuses ? t('kanbanBoardPage.boardPanel.powerups.jira.fetchStatuses') + '...' : t('kanbanBoardPage.boardPanel.powerups.jira.fetchStatuses')}
                              </button>
                            )}
                            {jiraStatuses.length > 0 && (
                              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                {lists.filter(l => !l.isArchived).map((list) => {
                                  const currentMapping = (puConfig.statusMapping as any[] || []).find((m: any) => m.listId === list.id);
                                  return (
                                    <div key={list.id} className="flex items-center gap-2">
                                      <span className="text-xs text-[#172b4d] dark:text-gray-300 min-w-[100px] truncate">{list.title}</span>
                                      <span className="text-[10px] text-[#626f86]">→</span>
                                      <select
                                        value={currentMapping?.jiraStatusId ?? ''}
                                        onChange={(e) => {
                                          const jiraStatus = jiraStatuses.find(s => s.id === e.target.value);
                                          const mappings = (puConfig.statusMapping as any[] || []).filter((m: any) => m.listId !== list.id);
                                          if (jiraStatus) {
                                            mappings.push({ listId: list.id, listTitle: list.title, jiraStatusId: jiraStatus.id, jiraStatusName: jiraStatus.name });
                                          }
                                          setPuConfig((c) => ({ ...c, statusMapping: mappings }));
                                        }}
                                        className="flex-1 rounded-lg border border-[#cfd3d8] bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
                                      >
                                        <option value="">{t('kanbanBoardPage.boardPanel.powerups.jira.noMap')}</option>
                                        {jiraStatuses.map(s => (
                                          <option key={s.id} value={s.id}>{s.name} ({s.category})</option>
                                        ))}
                                      </select>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        {puType === 'google_drive' && (
                          <div className="space-y-2">
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.googleDrive.clientIdPlaceholder')} value={puConfig.clientId ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, clientId: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input type="password" placeholder={t('kanbanBoardPage.boardPanel.powerups.googleDrive.clientSecretPlaceholder')} value={puConfig.clientSecret ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, clientSecret: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.googleDrive.accessTokenPlaceholder')} value={puConfig.accessToken ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, accessToken: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.googleDrive.refreshTokenPlaceholder')} value={puConfig.refreshToken ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, refreshToken: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.googleDrive.helpText')} <code className="bg-slate-100 dark:bg-gray-800 px-1 rounded">drive.readonly</code>.
                            </p>
                          </div>
                        )}
                        {puType === 'confluence' && (
                          <div className="space-y-2">
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.confluence.domainPlaceholder')} value={puConfig.domain ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, domain: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.confluence.emailPlaceholder')} value={puConfig.email ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, email: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input type="password" placeholder={t('kanbanBoardPage.boardPanel.powerups.confluence.apiTokenPlaceholder')} value={puConfig.apiToken ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, apiToken: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.confluence.spaceKeyPlaceholder')} value={puConfig.spaceKey ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, spaceKey: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.confluence.helpText')}
                            </p>
                          </div>
                        )}
                        {puType === 'giphy' && (
                          <div className="space-y-2">
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.giphy.apiKeyPlaceholder')} value={puConfig.apiKey ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, apiKey: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <select value={puConfig.rating ?? 'pg'} onChange={(e) => setPuConfig((c) => ({ ...c, rating: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                              <option value="g">{t('kanbanBoardPage.boardPanel.powerups.giphy.ratingG')}</option>
                              <option value="pg">{t('kanbanBoardPage.boardPanel.powerups.giphy.ratingPG')}</option>
                              <option value="pg-13">{t('kanbanBoardPage.boardPanel.powerups.giphy.ratingPG13')}</option>
                              <option value="r">{t('kanbanBoardPage.boardPanel.powerups.giphy.ratingR')}</option>
                            </select>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.giphy.helpText')}
                            </p>
                          </div>
                        )}
                        {puType === 'email_to_card' && (
                          <div className="space-y-2">
                            <select value={puConfig.targetListId ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, targetListId: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                              <option value="">{t('kanbanBoardPage.boardPanel.powerups.emailToCard.targetListPlaceholder')}</option>
                              {lists.filter(l => !l.isArchived).map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                            </select>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={puConfig.subjectAsTitle !== false} onChange={(e) => setPuConfig((c) => ({ ...c, subjectAsTitle: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.emailToCard.subjectAsTitle')}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                              <input type="checkbox" checked={puConfig.bodyAsDescription !== false} onChange={(e) => setPuConfig((c) => ({ ...c, bodyAsDescription: e.target.checked }))} className="rounded" />
                              {t('kanbanBoardPage.boardPanel.powerups.emailToCard.bodyAsDescription')}
                            </label>
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.emailToCard.labelsPlaceholder')} value={(puConfig.addLabels || []).join(', ')} onChange={(e) => setPuConfig((c) => ({ ...c, addLabels: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input placeholder={t('kanbanBoardPage.boardPanel.powerups.emailToCard.sendersPlaceholder')} value={(puConfig.allowedSenders || []).join(', ')} onChange={(e) => setPuConfig((c) => ({ ...c, allowedSenders: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.emailToCard.helpText')}
                            </p>
                          </div>
                        )}
                        {puType === 'burndown' && (
                          <div className="space-y-2">
                            <input type="number" min="1" max="90" placeholder={t('kanbanBoardPage.boardPanel.powerups.burndown.sprintDurationPlaceholder')} value={puConfig.sprintDurationDays ?? 14} onChange={(e) => setPuConfig((c) => ({ ...c, sprintDurationDays: parseInt(e.target.value) || 14 }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <input type="date" value={puConfig.sprintStartDate ?? new Date().toISOString().slice(0, 10)} onChange={(e) => setPuConfig((c) => ({ ...c, sprintStartDate: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <p className="text-[10px] font-bold uppercase tracking-wider text-[#44546f] dark:text-gray-500 pt-1">{t('kanbanBoardPage.boardPanel.powerups.burndown.doneListsTitle')}</p>
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.powerups.burndown.doneListsDesc')}</p>
                            <div className="space-y-1 max-h-32 overflow-y-auto">
                              {lists.filter(l => !l.isArchived).map((l) => (
                                <label key={l.id} className="flex items-center gap-2 text-xs text-[#172b4d] dark:text-gray-300">
                                  <input type="checkbox" checked={(puConfig.doneListIds || []).includes(l.id)} onChange={(e) => {
                                    const ids = puConfig.doneListIds || [];
                                    setPuConfig((c) => ({ ...c, doneListIds: e.target.checked ? [...ids, l.id] : ids.filter((id: string) => id !== l.id) }));
                                  }} className="rounded" />
                                  {l.title}
                                </label>
                              ))}
                            </div>
                            <select value={puConfig.trackingField ?? 'cards'} onChange={(e) => setPuConfig((c) => ({ ...c, trackingField: e.target.value }))}
                              className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                              <option value="cards">{t('kanbanBoardPage.boardPanel.powerups.burndown.trackCards')}</option>
                              <option value="points">{t('kanbanBoardPage.boardPanel.powerups.burndown.trackPoints')}</option>
                            </select>
                            {puConfig.trackingField === 'points' && board?.customFieldDefs?.length ? (
                              <select value={puConfig.pointsFieldId ?? ''} onChange={(e) => setPuConfig((c) => ({ ...c, pointsFieldId: e.target.value }))}
                                className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
                                <option value="">{t('kanbanBoardPage.boardPanel.powerups.burndown.pointsFieldPlaceholder')}</option>
                                {board.customFieldDefs.filter(cf => cf.type === 'number').map(cf => (
                                  <option key={cf.id} value={cf.id}>{cf.name}</option>
                                ))}
                              </select>
                            ) : null}
                            <p className="text-[10px] text-[#626f86] dark:text-gray-400">
                              {t('kanbanBoardPage.boardPanel.powerups.burndown.helpText')}
                            </p>
                          </div>
                        )}
                        <div className="flex gap-1.5">
                          <button onClick={handleAddPowerUp} className="flex-1 rounded-lg bg-[#0c66e4] py-1.5 text-xs font-medium text-white hover:bg-[#0055cc]">{t('kanbanBoardPage.boardPanel.powerups.installButton')}</button>
                          <button onClick={() => setShowAddPowerUp(false)} className="rounded-lg border border-[#cfd3d8] px-3 py-1.5 text-xs text-[#626f86] hover:bg-slate-100 dark:border-gray-600">{t('kanbanBoardPage.boardPanel.powerups.cancelButton')}</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Repos tab */}
                {boardPanelTab === 'repos' && board && (
                  <BoardReposPanel boardId={board.id} />
                )}

                {/* Settings tab (#35 + #36 + #39) */}
                {boardPanelTab === 'settings' && (
                  <div className="space-y-5">
                    {/* Visibility */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.visibilityTitle')}</p>
                      <div className="flex gap-1.5">
                        {([
                          { val: 'private', icon: <Lock className="h-3 w-3" />, label: t('kanbanBoardPage.boardPanel.settings.visibilityPrivate') },
                          { val: 'workspace', icon: <Users className="h-3 w-3" />, label: t('kanbanBoardPage.boardPanel.settings.visibilityWorkspace') },
                          { val: 'public', icon: <Globe className="h-3 w-3" />, label: t('kanbanBoardPage.boardPanel.settings.visibilityPublic') },
                        ] as const).map(({ val, icon, label }) => (
                          <button key={val} onClick={() => handleVisibilityChange(val)}
                            className={`flex-1 flex flex-col items-center gap-1 rounded-lg py-2 px-1 text-xs border transition-colors ${boardVisibility === val ? 'bg-[#e9efff] border-[#579dff] text-[#0055cc] dark:bg-[#1c2b41] dark:border-blue-500 dark:text-[#85b8ff]' : 'border-[#cfd3d8] text-[#44546f] hover:bg-slate-50 dark:border-gray-600 dark:text-gray-400'}`}
                          >{icon} {label}</button>
                        ))}
                      </div>
                    </div>

                    {/* Invite link */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.inviteLinkTitle')}</p>
                      {inviteToken ? (
                        <div className="space-y-2">
                          <div className="flex gap-1.5">
                            <input readOnly value={`${window.location.origin}/kanban/join/${inviteToken}`}
                              className="flex-1 min-w-0 rounded-lg border border-[#cfd3d8] bg-slate-50 px-2.5 py-1.5 text-xs text-[#44546f] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none" />
                            <button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/kanban/join/${inviteToken}`).then(() => toast.success(t('kanbanBoardPage.toasts.linkCopied')))}
                              className="rounded-lg border border-[#cfd3d8] px-2 py-1.5 text-xs text-[#0c66e4] hover:bg-[#e9efff] dark:border-gray-600">
                              <Link2 className="h-3 w-3" />
                            </button>
                          </div>
                          <button onClick={handleRevokeInviteToken} className="text-xs text-red-400 hover:text-red-600">{t('kanbanBoardPage.boardPanel.settings.revokeLink')}</button>
                        </div>
                      ) : (
                        <button onClick={handleGenerateInviteToken} disabled={generatingToken}
                          className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-[#0c66e4] hover:bg-[#e9efff] dark:text-[#85b8ff] dark:hover:bg-[#1c2b41] disabled:opacity-50">
                          <Link2 className="h-3 w-3" /> {generatingToken ? t('kanbanBoardPage.boardPanel.settings.generating') : t('kanbanBoardPage.boardPanel.settings.generateLink')}
                        </button>
                      )}
                    </div>

                    {/* Save as template */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.templatesTitle')}</p>
                      <button onClick={handleSaveAsTemplate}
                        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-[#0c66e4] hover:bg-[#e9efff] dark:text-[#85b8ff] dark:hover:bg-[#1c2b41]">
                        <LayoutTemplate className="h-3 w-3" /> {t('kanbanBoardPage.boardPanel.settings.saveAsTemplate')}
                      </button>
                    </div>

                    {/* Workspace (A6) */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.workspaceTitle')}</p>
                      <select
                        value={board?.workspaceId ?? ''}
                        onChange={async (e) => {
                          if (!board) return;
                          try {
                            const updated = await kanbanService.updateBoard(board.id, { workspaceId: e.target.value || null } as any);
                            setBoard(updated);
                            toast.success(t('kanbanBoardPage.toasts.workspaceUpdated'));
                          } catch { toast.error(t('kanbanBoardPage.toasts.moveBoardError')); }
                        }}
                        className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs text-[#172b4d] outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                      >
                        <option value="">{t('kanbanBoardPage.boardPanel.settings.noWorkspace')}</option>
                        {workspaces.map(ws => (
                          <option key={ws.id} value={ws.id}>{ws.name}</option>
                        ))}
                      </select>
                    </div>

                    {/* Card preview fields (A8) */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.cardFieldsTitle')}</p>
                      <p className="mb-2 text-[10px] text-[#626f86] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.cardFieldsDesc')}</p>
                      <div className="space-y-1">
                        {[
                          { id: 'datas', label: t('kanbanBoardPage.boardPanel.settings.cardFields.datas') },
                          { id: 'descricao', label: t('kanbanBoardPage.boardPanel.settings.cardFields.descricao') },
                          { id: 'comentarios', label: t('kanbanBoardPage.boardPanel.settings.cardFields.comentarios') },
                          { id: 'anexos', label: t('kanbanBoardPage.boardPanel.settings.cardFields.anexos') },
                          { id: 'checklist', label: t('kanbanBoardPage.boardPanel.settings.cardFields.checklist') },
                          { id: 'votos', label: t('kanbanBoardPage.boardPanel.settings.cardFields.votos') },
                          { id: 'membros', label: t('kanbanBoardPage.boardPanel.settings.cardFields.membros') },
                          { id: 'stickers', label: t('kanbanBoardPage.boardPanel.settings.cardFields.stickers') },
                        ].map(field => {
                          const hidden = cardPreviewFields.includes(field.id);
                          return (
                            <button key={field.id} onClick={() => toggleCardPreviewField(field.id)}
                              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors ${hidden ? 'bg-slate-100 text-[#626f86] dark:bg-gray-600 dark:text-gray-400' : 'text-[#172b4d] hover:bg-slate-50 dark:text-gray-200 dark:hover:bg-gray-700'}`}
                            >
                              <span>{field.label}</span>
                              <span className={`text-[10px] font-medium ${hidden ? 'text-amber-600' : 'text-emerald-600'}`}>{hidden ? t('kanbanBoardPage.boardPanel.settings.hidden') : t('kanbanBoardPage.boardPanel.settings.visible')}</span>
                            </button>
                          );
                        })}
                      </div>
                      {cardPreviewFields.length > 0 && (
                        <button onClick={() => { setCardPreviewFields([]); try { localStorage.removeItem(`kanban-preview-fields-${boardId}`); } catch { /**/ } }}
                          className="mt-2 text-xs text-[#579dff] hover:underline">
                          {t('kanbanBoardPage.boardPanel.settings.showAll')}
                        </button>
                      )}
                    </div>

                    {/* Custom fields manager */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.customFieldsTitle')}</p>
                      {(board?.customFieldDefs ?? []).map((def, idx) => (
                        <div key={def.id} className="mb-2 flex items-center gap-2 rounded-lg bg-[#f6f8fb] px-2 py-1.5 dark:bg-[#ffffff0a]">
                          <span className="flex-1 text-xs font-medium text-[#44546f] dark:text-gray-300">{def.name}</span>
                          <span className="rounded bg-[#e9efff] px-1.5 py-0.5 text-[10px] text-[#0c66e4] dark:bg-[#1c2b41] dark:text-[#85b8ff]">{def.type}</span>
                          <button
                            onClick={async () => {
                              if (!board) return;
                              const next = board.customFieldDefs.filter((_, i) => i !== idx);
                              const updated = await kanbanService.updateBoard(board.id, { customFieldDefs: next });
                              setBoard(updated);
                            }}
                            className="text-[#626f86] hover:text-red-500 dark:text-gray-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                      <AddCustomFieldInline board={board} setBoard={setBoard} />
                    </div>

                    {/* C5 – Granular permissions */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.permissionsTitle')}</p>
                      <div className="space-y-1">
                        {([
                          { key: 'membersCanComment' as const, label: t('kanbanBoardPage.boardPanel.settings.permissions.membersCanComment') },
                          { key: 'membersCanEditCards' as const, label: t('kanbanBoardPage.boardPanel.settings.permissions.membersCanEditCards') },
                          { key: 'observersCanView' as const, label: t('kanbanBoardPage.boardPanel.settings.permissions.observersCanView') },
                        ]).map(({ key, label }) => {
                          const enabled = board?.permissions?.[key] ?? true;
                          return (
                            <button key={key} onClick={() => void updateBoardPermission(key, !enabled)}
                              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors ${enabled ? 'text-[#172b4d] hover:bg-slate-50 dark:text-gray-200 dark:hover:bg-gray-700' : 'bg-slate-100 text-[#626f86] dark:bg-gray-600 dark:text-gray-400'}`}
                            >
                              <span>{label}</span>
                              <span className={`text-[10px] font-medium ${enabled ? 'text-emerald-600' : 'text-amber-600'}`}>{enabled ? t('kanbanBoardPage.boardPanel.settings.permissionActive') : t('kanbanBoardPage.boardPanel.settings.permissionInactive')}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Voting limit */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.votingLimitTitle')}</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          value={board?.permissions?.votingLimit ?? 0}
                          onChange={async (e) => {
                            const v = parseInt(e.target.value) || 0;
                            if (!board) return;
                            try {
                              const updated = await kanbanService.updateBoard(board.id, {
                                permissions: { ...(board.permissions ?? {}), votingLimit: v },
                              });
                              setBoard(updated);
                            } catch { toast.error(t('kanbanBoardPage.toasts.updateVotingLimitError')); }
                          }}
                          className="w-16 rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-center text-xs text-[#172b4d] outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                        />
                        <span className="text-xs text-[#626f86] dark:text-gray-400">{t('kanbanBoardPage.boardPanel.settings.votingLimitZero')}</span>
                      </div>
                    </div>

                    {/* Board background */}
                    <div>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.backgroundTitle')}</p>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        <button onClick={() => setBoardBackground('')} className={`h-7 w-7 rounded-lg border-2 bg-[#f3f4f6] ${!board?.backgroundColor && !board?.backgroundImage ? 'border-[#579dff]' : 'border-transparent hover:border-slate-300'}`} title={t('kanbanBoardPage.boardPanel.settings.backgroundDefault')} />
                        {BG_PALETTE.map(c => (
                          <button key={c} onClick={() => setBoardBackground(c)}
                            className="h-7 w-7 rounded-lg transition-all hover:scale-110"
                            style={{ background: c, outline: board?.backgroundColor === c ? '3px solid #579dff' : 'none', outlineOffset: '2px' }}
                          />
                        ))}
                      </div>
                      <p className="mb-1 text-[11px] font-medium text-[#626f86] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.gradientsLabel')}</p>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {GRADIENT_PALETTE.map(g => (
                          <button key={g} onClick={() => setBoardBackground(g)}
                            className="h-7 w-14 rounded-lg transition-all hover:scale-105"
                            style={{ background: g, outline: board?.backgroundColor === g ? '3px solid #579dff' : 'none', outlineOffset: '2px' }}
                          />
                        ))}
                      </div>
                      <p className="mb-1 text-[11px] font-medium text-[#626f86] dark:text-gray-500">{t('kanbanBoardPage.boardPanel.settings.bgImageLabel')}</p>
                      <div className="flex gap-2">
                        <input
                          type="url"
                          placeholder={t('kanbanBoardPage.boardPanel.settings.bgImagePlaceholder')}
                          defaultValue={board?.backgroundImage ?? ''}
                          onBlur={e => { if (e.target.value !== (board?.backgroundImage ?? '')) void setBoardBackgroundImage(e.target.value); }}
                          onKeyDown={e => { if (e.key === 'Enter') { void setBoardBackgroundImage((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); } }}
                          className="flex-1 rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-xs text-[#172b4d] outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                        />
                        {board?.backgroundImage && (
                          <button onClick={() => void setBoardBackgroundImage('')} className="rounded-lg border border-[#cfd3d8] px-2 text-xs text-[#626f86] hover:bg-slate-100 dark:border-gray-600 dark:text-gray-400">{t('kanbanBoardPage.boardPanel.settings.bgImageClear')}</button>
                        )}
                      </div>
                    </div>

                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      {selectedCard && (
        <CardDetailModal
          card={selectedCard}
          boardId={boardId!}
          boardMembers={boardMembers}
          customFieldDefs={board?.customFieldDefs ?? []}
          listTitle={lists.find((l) => l.id === selectedCard.listId)?.title ?? ''}
          onClose={() => setSelectedCard(null)}
          onUpdated={handleCardUpdated}
          onDeleted={handleCardDeleted}
          onCardAdded={handleCardAdded}
          onOpenCard={(cardId) => {
            const found = lists.flatMap(l => l.cards ?? []).find(c => c.id === cardId);
            if (found) setSelectedCard(found);
          }}
          onOpenFullPage={() => navigate(`/kanban/${boardId}/cards/${selectedCard.id}`)}
          onEditingStart={(field) => handleCardEditingStart(selectedCard.id, selectedCard.boardId, field)}
          onEditingStop={(field) => handleCardEditingStop(selectedCard.id, selectedCard.boardId, field)}
          editorsInfo={cardEditors.filter(e => e.cardId === selectedCard.id)}
          currentUserId={currentUserId}
          canEdit={canEditCards}
          canComment={canComment}
          votingLimit={board?.permissions?.votingLimit ?? 0}
        />
      )}

      {/* Move blocked dialog */}
      {moveBlockDialog && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setMoveBlockDialog(null)}
        >
          <div
            className="relative mx-4 w-full max-w-md rounded-2xl bg-white p-6 shadow-[0_32px_80px_-20px_rgba(15,23,42,0.5)] dark:bg-[#22272b]"
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 dark:bg-amber-900/30">
              <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <h3 className="mb-2 text-base font-bold text-[#172b4d] dark:text-[#b6c2cf]">
              {moveBlockDialog.title}
            </h3>
            <p className="mb-5 whitespace-pre-line text-sm leading-relaxed text-[#44546f] dark:text-[#8c9bab]">
              {moveBlockDialog.message}
            </p>
            <button
              onClick={() => setMoveBlockDialog(null)}
              className="w-full rounded-xl bg-[#172b4d] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#091e42] dark:bg-[#579dff] dark:hover:bg-[#4c8fe8]"
            >
              {t('kanbanBoardPage.moveBlock.understood')}
            </button>
          </div>
        </div>
      )}

      {/* App dialog (triggered by open_app automation) */}
      {appDialogUrl && (
        <div
          className={`fixed inset-0 z-[250] flex ${appDialogMode === 'sidebar' ? 'justify-end' : 'items-center justify-center'} bg-black/50 backdrop-blur-sm`}
          onClick={() => setAppDialogUrl('')}
        >
          <div
            className={`relative bg-white dark:bg-[#1d2125] shadow-2xl ${
              appDialogMode === 'sidebar'
                ? 'h-full w-full max-w-lg animate-slide-in-right'
                : 'mx-4 w-full max-w-4xl rounded-2xl max-h-[85vh]'
            }`}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-gray-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">{appDialogTitle}</h3>
              <button onClick={() => setAppDialogUrl('')} className="rounded-lg p-1 hover:bg-slate-100 dark:hover:bg-gray-700">
                <X className="h-4 w-4 text-[#626f86]" />
              </button>
            </div>
            <iframe
              src={appDialogUrl}
              className={`w-full border-0 ${appDialogMode === 'sidebar' ? 'h-[calc(100%-52px)]' : 'h-[75vh] rounded-b-2xl'}`}
              title={appDialogTitle}
            />
          </div>
        </div>
      )}

      {showSearch && (
        <KanbanSearchModal
          onClose={() => setShowSearch(false)}
          boardId={boardId}
          boardMembers={boardMembers}
          onCardClick={(card) => {
            if (card.boardId === boardId) {
              setSelectedCard(card as KanbanCard);
            } else {
              toast.success(t('kanbanBoardPage.toasts.cardOnOtherBoard', { title: card.boardTitle }));
            }
          }}
        />
      )}

      {showPuWizard && board && (
        <PowerUpTemplateWizard
          boardId={board.id}
          editingTemplate={editingPuTemplate}
          onClose={() => { setShowPuWizard(false); setEditingPuTemplate(null); }}
          onSaved={tpl => {
            setMyTemplates(prev => {
              const idx = prev.findIndex(t => t.id === tpl.id);
              return idx >= 0 ? prev.map(t => t.id === tpl.id ? tpl : t) : [tpl, ...prev];
            });
            setShowPuWizard(false);
            setEditingPuTemplate(null);
          }}
        />
      )}

      {installingTemplate && board && (
        <PowerUpInstallModal
          boardId={board.id}
          template={installingTemplate}
          onClose={() => setInstallingTemplate(null)}
          onInstalled={() => {
            setInstallingTemplate(null);
            kanbanService.listPowerUps(board.id).then(setPowerUps).catch(() => {});
          }}
        />
      )}

      {showShortcuts && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setShowShortcuts(false)}
        >
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-gray-800 w-80" onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{t('kanbanBoardPage.shortcuts.title')}</h2>
              <button onClick={() => setShowShortcuts(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-2 text-sm">
              {[
                { key: 'Ctrl+K', label: t('kanbanBoardPage.shortcuts.keys.globalSearch') },
                { key: '?', label: t('kanbanBoardPage.shortcuts.keys.showShortcuts') },
                { key: 'F', label: t('kanbanBoardPage.shortcuts.keys.openFilters') },
                { key: 'J', label: t('kanbanBoardPage.shortcuts.keys.nextCard') },
                { key: 'K', label: t('kanbanBoardPage.shortcuts.keys.prevCard') },
                { key: 'Enter', label: t('kanbanBoardPage.shortcuts.keys.openCard') },
                { key: 'Esc', label: t('kanbanBoardPage.shortcuts.keys.closeModal') },
              ].map(s => (
                <div key={s.key} className="flex items-center justify-between">
                  <span className="text-slate-600 dark:text-gray-400">{s.label}</span>
                  <kbd className="rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">{s.key}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
