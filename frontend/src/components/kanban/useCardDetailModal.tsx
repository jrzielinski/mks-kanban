// useCardDetailModal.ts — extracted hook from CardDetailModal
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import kanbanAgentService, {
  KanbanAgentExecution, AgentStatus, subscribeToExecution, subscribeToAgentStatus,
} from '@/services/kanbanAgent.service';
import {LABEL_PRESETS, groupActivitiesByDate } from './detail';
import kanbanService, {
  KanbanAttachment, KanbanBoardMember, KanbanCard, KanbanLabel, KanbanChecklistGroup, KanbanActivity, KanbanTimeLog, KanbanCustomFieldDef, KanbanBoard, KanbanList, KanbanRecurrence, KanbanCardLocation, KanbanHourRequest,
} from '@/services/kanban.service';
import { useConfirm } from '@/hooks/useConfirm';
import { DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';



type Panel = 'labels'|'checklist'|'duedate'|'startdate'|'cover'|'members'|'stickers'|'customfields'|'recurrence'|'location'|null;

interface Props {
  card: KanbanCard;
  listTitle: string;
  boardId: string;
  boardMembers: KanbanBoardMember[];
  customFieldDefs: KanbanCustomFieldDef[];
  currentUserId: string;
  onClose: () => void;
  onUpdated: (c: KanbanCard) => void;
  onDeleted: (id: string) => void;
  onCardAdded?: (c: KanbanCard) => void;
  onOpenCard?: (id: string) => void;
  fullPage?: boolean;
  onOpenFullPage?: () => void;
  onEditingStart?: (field: string) => void;
  onEditingStop?: (field: string) => void;
  editorsInfo?: any[];
  canEdit?: boolean;
  canComment?: boolean;
  votingLimit?: number;
}

function initChecklists(card: KanbanCard): KanbanChecklistGroup[] {
  if (card.checklists && card.checklists.length > 0) return card.checklists;
  if (card.checklist && card.checklist.length > 0) {
    return [{
      id: 'cl_legacy',
      title: 'Checklist',
      items: card.checklist.map((item, i) => ({ ...item, id: `item_legacy_${i}` })),
    }];
  }
  return [];
}

function newItemId(): string {
  return `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function useCardDetailModal(props: Props) {
  const { card, boardId, boardMembers, currentUserId, onClose, onUpdated, onDeleted, onCardAdded, onEditingStart, onEditingStop, votingLimit = 0 } = props;
  const { t, i18n } = useTranslation('common');
  const { confirm } = useConfirm();
  const [title, setTitle]             = useState(card.title);
  const [desc, setDesc]               = useState(card.description ?? '');
  const [editDesc, setEditDesc]       = useState(false);
  const [descCollapsed, setDescCollapsed] = useState(false);
  const [dueDate, setDueDate]         = useState(card.dueDate?.slice(0,10) ?? '');
  const [startDate, setStartDate]     = useState(card.startDate?.slice(0,10) ?? '');
  const [votes, setVotes]             = useState<string[]>(card.votes || []);
  const [stickers, setStickers]       = useState<string[]>(card.stickers || []);
  const [customFields, setCustomFields] = useState<Record<string, string | number | boolean | null>>(card.customFields || {});
  const [recurrence, setRecurrence] = useState<KanbanRecurrence | null>(card.recurrence ?? null);
  const [labels, setLabels]           = useState<KanbanLabel[]>(card.labels);
  const [checklists, setChecklists]   = useState<KanbanChecklistGroup[]>(initChecklists(card));
  const [cover, setCover]             = useState(card.coverColor);
  const [panel, setPanel]             = useState<Panel>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [newGroupTitle, setNewGroupTitle] = useState(() => t('kanbanCardDetailModal.placeholders.checklistTitle'));
  const [newItemTexts, setNewItemTexts]   = useState<Record<string, string>>({});
  const [lblText, setLblText]         = useState('');
  const [lblColor, setLblColor]       = useState(LABEL_PRESETS[0].color);
  const [attachments, setAttachments] = useState<KanbanAttachment[]>(card.attachments || []);
  const [activityComment, setActivityComment] = useState('');
  const [commentFocused, setCommentFocused] = useState(false);
  const [showOnlyComments, setShowOnlyComments] = useState(false);
  const [activities, setActivities]   = useState<KanbanActivity[]>([]);
  const groupedActivities = useMemo(() => {
    const filtered = showOnlyComments ? activities.filter(a => a.type === 'comment') : activities;
    return groupActivitiesByDate(filtered, t('kanbanCardDetailModal.activity.today'), t('kanbanCardDetailModal.activity.yesterday'), i18n.language);
  }, [activities, showOnlyComments, i18n.language]);
  const [loadingActivities, setLoadingActivities] = useState(false);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [timeLogs, setTimeLogs]               = useState<KanbanTimeLog[]>([]);
  const [showTimeLogForm, setShowTimeLogForm] = useState(false);
  const [timeLogHours, setTimeLogHours]       = useState('1');
  const [timeLogDesc, setTimeLogDesc]         = useState('');
  const [timeLogDate, setTimeLogDate]         = useState(() => new Date().toISOString().slice(0, 10));
  const [submittingTimeLog, setSubmittingTimeLog] = useState(false);
  const [maxHours, setMaxHours]               = useState<string>(card.maxHours != null ? String(card.maxHours) : '');
  const [savingMaxHours, setSavingMaxHours]   = useState(false);
  const [hourRequests, setHourRequests]       = useState<KanbanHourRequest[]>([]);
  const [submittingHourRequest, setSubmittingHourRequest] = useState(false);
  const [timeDisplayMode, setTimeDisplayMode] = useState<'formatted' | 'decimal'>('formatted');
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [descSaved, setDescSaved] = useState(false);
  const [descConflict, setDescConflict] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string|null>(null);
  const [editCommentText, setEditCommentText] = useState('');
  const [isWatching, setIsWatching] = useState(() => (card.watchedBy ?? []).includes(currentUserId ?? ''));
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // @ts-ignore
  const [stickerSearch, setStickerSearch] = useState('');
  const [locationLat, setLocationLat] = useState(card.location?.lat?.toString() ?? '');
  const [locationLng, setLocationLng] = useState(card.location?.lng?.toString() ?? '');
  const [locationAddress, setLocationAddress] = useState(card.location?.address ?? '');
  // Move to board state
  const [showMoveToBoard, setShowMoveToBoard] = useState(false);
  const [otherBoards, setOtherBoards] = useState<KanbanBoard[]>([]);
  const [moveToBoardId, setMoveToBoardId] = useState('');
  const [moveToBoardLists, setMoveToBoardLists] = useState<KanbanList[]>([]);
  const [moveToListId, setMoveToListId] = useState('');
  const [showExecuteModal, setShowExecuteModal] = useState(false);
  const [executionsCollapsed, setExecutionsCollapsed] = useState(false);
  const [activeExecId, setActiveExecId] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  // @ts-ignore
  const [liveLogDone, setLiveLogDone] = useState(false);
  // C3 – Linked cards
  const [linkedCards, setLinkedCards] = useState<Array<{ id: string; title: string; listTitle: string; boardTitle: string }>>([]);
  const [linkSearch, setLinkSearch] = useState('');
  const [linkSearchResults, setLinkSearchResults] = useState<Array<{ id: string; title: string; listTitle: string; boardTitle: string }>>([]);
  const [linkSearchLoading, setLinkSearchLoading] = useState(false);
  const [linkingCard, setLinkingCard] = useState(false);
  // C4 – Blocking dependencies
  const [blockerCards, setBlockerCards] = useState<Array<{ id: string; title: string; }>>([]);
  const [blockerSearch, setBlockerSearch] = useState('');
  const [blockerSearchResults, setBlockerSearchResults] = useState<Array<{ id: string; title: string; }>>([]);
  const [blockerSearchLoading, setBlockerSearchLoading] = useState(false);
  const [addingBlocker, setAddingBlocker] = useState(false);
  const [isLinkRecording, setIsLinkRecording] = useState(false);
  const linkRecognitionRef = useRef<any>(null);
  const activitiesTopRef = useRef<HTMLDivElement>(null);
  // Snooze
  const [showSnooze, setShowSnooze] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState('');
  const isSnoozed = !!(card.customFields?.['__snoozedUntil']);
  // Google Drive
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [driveFiles, setDriveFiles] = useState<Array<{ id: string; name: string; mimeType: string; webViewLink: string; iconLink: string; thumbnailLink?: string }>>([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveFolderStack, setDriveFolderStack] = useState<Array<{ id: string; name: string }>>([]);
  const [driveSearch, setDriveSearch] = useState('');
  // Giphy
  const [showGiphy, setShowGiphy] = useState(false);
  const [giphySearch, setGiphySearch] = useState('');
  const [giphyGifs, setGiphyGifs] = useState<Array<{ id: string; title: string; previewUrl: string; originalUrl: string }>>([]);
  const [giphyLoading, setGiphyLoading] = useState(false);
  // Voice-to-comment
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [voiceReady, setVoiceReady] = useState(false);
  const [formattingVoice, setFormattingVoice] = useState(false);
  const recognitionRef = useRef<any>(null);
  const finalTextRef = useRef('');

  // Voice-to-description
  const [descVoiceTranscript, setDescVoiceTranscript] = useState('');
  const [isDescRecording, setIsDescRecording] = useState(false);
  const [descVoiceReady, setDescVoiceReady] = useState(false);
  const [formattingDescVoice, setFormattingDescVoice] = useState(false);
  const [aiFormattingDesc, setAiFormattingDesc] = useState(false);
  const descRecognitionRef = useRef<any>(null);
  const descFinalTextRef = useRef('');
  // Decompose
  const [decomposing, setDecomposing] = useState(false);
  // GitHub
  const [showGithub, setShowGithub] = useState(false);
  const [githubIssues, setGithubIssues] = useState<Array<{ number: number; title: string; state: string; html_url: string }>>([]);
  const [githubPRs, setGithubPRs] = useState<Array<{ number: number; title: string; state: string; html_url: string; head?: { ref: string } }>>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubCreatingIssue, setGithubCreatingIssue] = useState(false);
  const [githubTab, setGithubTab] = useState<'issues' | 'prs'>('issues');
  const [githubPowerUp, setGithubPowerUp] = useState<{ id: string; enabled: boolean; config: Record<string, any> } | null | undefined>(undefined); // undefined=not checked, null=not configured
  const [githubSetupOpen, setGithubSetupOpen] = useState(false);
  const [githubSetup, setGithubSetup] = useState({ token: '', repoOwner: '', repoName: '' });
  const [githubSetupSaving, setGithubSetupSaving] = useState(false);
  // Confluence
  const [showConfluence, setShowConfluence] = useState(false);
  const [showConfluenceModal, setShowConfluenceModal] = useState(false);
  const [confluenceSearch, setConfluenceSearch] = useState('');
  const [confluencePages, setConfluencePages] = useState<Array<{ id: string; title: string; spaceKey: string; webUrl: string; excerpt?: string; lastModified?: string; lastModifiedBy?: string }>>([]);
  const [confluenceLoading, setConfluenceLoading] = useState(false);
  const linkedConfluencePages: Array<{ id: string; title: string; webUrl: string; spaceKey: string; linkedAt: string }> = (() => {
    try { return JSON.parse((card.customFields?.['__confluencePages'] as string) || '[]'); } catch { return []; }
  })();
  const liveLogRef = useRef<HTMLDivElement>(null);
  const fileRef  = useRef<HTMLInputElement>(null);
  const descRef  = useRef<HTMLTextAreaElement>(null);
  const descTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedMembers = boardMembers.filter((member) => (card.memberIds || []).includes(member.id));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Sync labels from external updates (WebSocket card:updated)
  useEffect(() => {
    setLabels(card.labels ?? []);
  }, [card.labels]);

  // Sync due dates from external updates
  useEffect(() => {
    setDueDate(card.dueDate?.slice(0, 10) ?? '');
    setStartDate(card.startDate?.slice(0, 10) ?? '');
  }, [card.dueDate, card.startDate]);

  // Sync attachments from external updates
  useEffect(() => {
    setAttachments(card.attachments ?? []);
  }, [card.attachments]);

  // Sync custom fields from external updates (WebSocket card:updated)
  useEffect(() => {
    setCustomFields(card.customFields ?? {});
  }, [card.customFields]);

  // Sync checklists from external updates (only when not actively editing)
  useEffect(() => {
    setChecklists(initChecklists(card));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  // @ts-ignore
  }, [(card.checklists ?? []).map(g => g.id + g.items.map(i => i.id + i.done).join('')).join(',')]);

  // Detect external description conflict
  useEffect(() => {
    if (editDesc && card.description !== undefined && card.description !== desc) {
      setDescConflict(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.description]);

  // Load activities on mount (and when _activityPing changes via WebSocket)
  useEffect(() => {
    setLoadingActivities(true);
    kanbanService.listActivities(card.id)
      .then(setActivities)
      .catch(() => {})
      .finally(() => setLoadingActivities(false));
  }, [card.id, card._activityPing]);

  // Load time logs and hour requests on mount
  useEffect(() => {
    kanbanService.listTimeLogs(card.id)
      .then(setTimeLogs)
      .catch(() => {});
    kanbanService.listHourRequests(card.id)
      .then(setHourRequests)
      .catch(() => {});
  }, [card.id]);

  // C3 – Load linked cards on mount
  useEffect(() => {
    const ids = card.linkedCardIds ?? [];
    if (ids.length === 0) return;
    kanbanService.getBatchCards(ids)
      .then(setLinkedCards)
      .catch(() => {});
  }, [card.id, card.linkedCardIds]);

  // C4 – Load blocker cards on mount
  useEffect(() => {
    const ids = card.blockedBy ?? [];
    if (ids.length === 0) { setBlockerCards([]); return; }
    kanbanService.getBatchCards(ids)
      .then(setBlockerCards)
      .catch(() => {});
  }, [card.id, card.blockedBy]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  // Clear member search when panel changes away from members
  useEffect(() => {
    if (panel !== 'members') setMemberSearch('');
  }, [panel]);

  // Agent status (poll every 30s)
  const { data: agentStatus } = useQuery<AgentStatus>({
    queryKey: ['kanban-agent-status'],
    queryFn: () => kanbanAgentService.getAgentStatus(),
    refetchInterval: 10_000,
  });

  // Board repos (needed by ExecuteAgentModal)
  const { data: boardRepos = [] } = useQuery({
    queryKey: ['kanban-board-repos', boardId],
    queryFn: () => kanbanAgentService.listBoardRepos(boardId),
    enabled: !!boardId,
  });

  // Card executions list
  const queryClient = useQueryClient();
  const { data: executions = [] } = useQuery<KanbanAgentExecution[]>({
    queryKey: ['kanban-executions', card.id],
    queryFn: () => kanbanAgentService.listCardExecutions(card.id),
    refetchInterval: activeExecId ? 5000 : false,
  });

  // List agent config (for pre-filling ExecuteAgentModal)
  const { data: listConfig } = useQuery({
    queryKey: ['kanban-list-agent-config', card.listId],
    queryFn: () => kanbanAgentService.getListAgentConfig(card.listId),
    enabled: !!card.listId,
  });

  // Live log subscription
  useEffect(() => {
    if (!activeExecId) return;

    setLiveLog([]);
    setLiveLogDone(false);

    const token = localStorage.getItem('token') || '';

    const unsub = subscribeToExecution(activeExecId, token, (evt) => {
      if (evt.type === 'progress') {
        setLiveLog(prev => [...prev, evt.content]);
        setTimeout(() => {
          liveLogRef.current?.scrollTo({ top: liveLogRef.current.scrollHeight, behavior: 'smooth' });
        }, 50);
      } else {
        setLiveLog(prev => [...prev, evt.content || '']);
        setLiveLogDone(true);
        setActiveExecId(null);
        void queryClient.invalidateQueries({ queryKey: ['kanban-executions', card.id] });
      }
    });

    return unsub;
  }, [activeExecId]);

  // Real-time agent status — invalidate immediately on connect/disconnect
  useEffect(() => {
    const token = localStorage.getItem('token') || '';
    const unsub = subscribeToAgentStatus(token, () => {
      void queryClient.invalidateQueries({ queryKey: ['kanban-agent-status'] });
    });
    return unsub;
  }, []);

  const handleExecuted = (execId: string) => {
    setActiveExecId(execId);
    setExecutionsCollapsed(false);
    void queryClient.invalidateQueries({ queryKey: ['kanban-executions', card.id] });
  };

  const save = async (patch: Partial<KanbanCard>) => {
    try { const u = await kanbanService.updateCard(card.id, patch); onUpdated(u); }
    catch { toast.error(t('kanbanCardDetailModal.toasts.saveError')); }
  };

  const saveTitle  = () => { if (title.trim() && title.trim() !== card.title) save({ title: title.trim() }); };
  const saveDesc   = () => { onEditingStop?.('description'); setEditDesc(false); setDescConflict(false); if (descTimerRef.current) clearTimeout(descTimerRef.current); if (desc !== (card.description ?? '')) save({ description: desc }); };

  const handleToggleWatch = async () => {
    try {
      const result = await kanbanService.toggleWatchCard(card.id);
      setIsWatching(result.watching);
      toast.success(result.watching ? t('kanbanCardDetailModal.toasts.watchEnabled') : t('kanbanCardDetailModal.toasts.watchDisabled'));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.watchError')); }
  };

  const saveLocation = () => {
    const lat = parseFloat(locationLat);
    const lng = parseFloat(locationLng);
    if (!locationLat && !locationLng) {
      save({ location: null });
      setPanel(null);
      return;
    }
    if (isNaN(lat) || isNaN(lng)) { toast.error(t('kanbanCardDetailModal.toasts.invalidCoordinates')); return; }
    const loc: KanbanCardLocation = { lat, lng, address: locationAddress.trim() || undefined };
    save({ location: loc });
    setPanel(null);
    toast.success(t('kanbanCardDetailModal.toasts.locationSaved'));
  };

  // Autosave description after 1.5s of inactivity
  const handleDescChange = (value: string) => {
    setDesc(value);
    setDescSaved(false);
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    if (value !== (card.description ?? '')) {
      descTimerRef.current = setTimeout(async () => {
        try { await kanbanService.updateCard(card.id, { description: value }); setDescSaved(true); }
        catch { /* silent */ }
      }, 1500);
    }
  };
  const saveDue    = (v: string) => { setDueDate(v); setPanel(null); save({ dueDate: v || null }); };
  const saveCover  = (c: string) => { setCover(c); setPanel(null); save({ coverColor: c, coverImageUrl: null, coverAttachmentId: null }); };
  const removeCover = () => { setCover('#ffffff'); save({ coverColor: '#ffffff', coverImageUrl: null, coverAttachmentId: null }); };

  const toggleLabel = (lp: typeof LABEL_PRESETS[0]) => {
    const i = labels.findIndex(l => l.color === lp.color);
    const next = i >= 0 ? labels.filter((_,idx)=>idx!==i) : [...labels, { text: lp.name, color: lp.color }];
    setLabels(next); save({ labels: next });
  };
  const addCustomLabel = () => {
    if (!lblText.trim()) return;
    const next = [...labels, { text: lblText.trim(), color: lblColor }];
    setLabels(next); setLblText(''); save({ labels: next });
  };
  const removeLabel = (i: number) => {
    const next = labels.filter((_,idx)=>idx!==i); setLabels(next); save({ labels: next });
  };

  // ── CHECKLISTS ─────────────────────────────────────────────────────────────

  const saveChecklists = (next: KanbanChecklistGroup[]) => {
    setChecklists(next);
    save({ checklists: next });
  };

  const addChecklistGroup = () => {
    const title = newGroupTitle.trim() || 'Checklist';
    const next = [...checklists, { id: `cl_${Date.now()}`, title, items: [] }];
    setNewGroupTitle('Checklist');
    setPanel(null);
    saveChecklists(next);
  };

  const deleteGroup = (gId: string) => {
    saveChecklists(checklists.filter(g => g.id !== gId));
  };

  const addItemToGroup = (gId: string) => {
    const text = (newItemTexts[gId] ?? '').trim();
    if (!text) return;
    const next = checklists.map(g => g.id !== gId ? g : {
      ...g,
      items: [...g.items, { id: newItemId(), text, done: false }],
    });
    setNewItemTexts(prev => ({ ...prev, [gId]: '' }));
    saveChecklists(next);
  };

  const toggleItem = (gId: string, itemId: string) => {
    const next = checklists.map(g => g.id !== gId ? g : {
      ...g,
      items: g.items.map(i => (!i.id ? i.text === itemId : i.id === itemId) ? { ...i, done: !i.done } : i),
    });
    saveChecklists(next);
  };

  const removeItem = (gId: string, itemId: string) => {
    const next = checklists.map(g => g.id !== gId ? g : {
      ...g,
      items: g.items.filter(i => (i.id ?? i.text) !== itemId),
    });
    saveChecklists(next);
  };

  const convertItemToCard = async (gId: string, itemId: string) => {
    try {
      await kanbanService.convertChecklistItemToCard(card.id, gId, itemId);
      const next = checklists.map(g => g.id !== gId ? g : {
        ...g,
        items: g.items.filter(i => (i.id ?? i.text) !== itemId),
      });
      saveChecklists(next);
      toast.success(t('kanbanCardDetailModal.toasts.itemConverted'));
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.convertItemError'));
    }
  };

  // C3 handlers
  const searchCardsToLink = async (query: string) => {
    setLinkSearch(query);
    if (query.trim().length < 2) { setLinkSearchResults([]); return; }
    setLinkSearchLoading(true);
    try {
      const results = await kanbanService.advancedSearch({ q: query.trim() });
      setLinkSearchResults(
        results
          .filter(r => r.id !== card.id && !linkedCards.some(l => l.id === r.id))
          .slice(0, 8)
          .map(r => ({ id: r.id, title: r.title, listTitle: r.listTitle ?? '', boardTitle: r.boardTitle ?? '' }))
      );
    } catch {
      setLinkSearchResults([]);
    } finally {
      setLinkSearchLoading(false);
    }
  };

  const linkCard = async (targetId: string, targetTitle: string, targetListTitle: string, targetBoardTitle: string) => {
    setLinkingCard(true);
    try {
      await kanbanService.linkCards(card.id, targetId);
      setLinkedCards(prev => [...prev, { id: targetId, title: targetTitle, listTitle: targetListTitle, boardTitle: targetBoardTitle }]);
      setLinkSearch('');
      setLinkSearchResults([]);
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.linkCardError'));
    } finally {
      setLinkingCard(false);
    }
  };

  const unlinkCard = async (targetId: string) => {
    try {
      await kanbanService.unlinkCard(card.id, targetId);
      setLinkedCards(prev => prev.filter(l => l.id !== targetId));
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.unlinkCardError'));
    }
  };

  // C4: Blocker handlers
  const searchBlockerCandidates = async (query: string) => {
    setBlockerSearch(query);
    if (query.trim().length < 2) { setBlockerSearchResults([]); return; }
    setBlockerSearchLoading(true);
    try {
      const results = await kanbanService.advancedSearch({ q: query.trim() });
      setBlockerSearchResults(
        results
          .filter(r => r.id !== card.id && !blockerCards.some(b => b.id === r.id))
          .slice(0, 8)
          .map(r => ({ id: r.id, title: r.title, boardTitle: r.boardTitle ?? '' }))
      );
    } finally {
      setBlockerSearchLoading(false);
    }
  };

  const addBlocker = async (blockerId: string, blockerTitle: string, blockerBoardTitle: string) => {
    setAddingBlocker(true);
    try {
      await kanbanService.addBlocker(card.id, blockerId);
      setBlockerCards(prev => [...prev, { id: blockerId, title: blockerTitle, boardTitle: blockerBoardTitle }]);
      setBlockerSearch('');
      setBlockerSearchResults([]);
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.addBlockerError'));
    } finally {
      setAddingBlocker(false);
    }
  };

  const removeBlocker = async (blockerId: string) => {
    try {
      await kanbanService.removeBlocker(card.id, blockerId);
      setBlockerCards(prev => prev.filter(b => b.id !== blockerId));
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.removeBlockerError'));
    }
  };

  const hideCompleted = (gId: string) => {
    const next = checklists.map(g => g.id !== gId ? g : {
      ...g,
      items: g.items.filter(i => !i.done),
    });
    saveChecklists(next);
  };

  const updateItemMeta = (gId: string, itemId: string, meta: { dueDate?: string | null; assignedTo?: string | null }) => {
    const next = checklists.map(g => g.id !== gId ? g : {
      ...g,
      items: g.items.map(i => (i.id ?? i.text) === itemId ? { ...i, ...meta } : i),
    });
    saveChecklists(next);
  };

  const handleChecklistDragEnd = (gId: string, event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const group = checklists.find(g => g.id === gId);
    if (!group) return;
    const ids = group.items.map(i => i.id ?? i.text);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(group.items, oldIndex, newIndex);
    saveChecklists(checklists.map(g => g.id === gId ? { ...g, items: reordered } : g));
  };

  // ── ATTACHMENTS ────────────────────────────────────────────────────────────

  const persistAttachments = async (nextAttachments: KanbanAttachment[], extraPatch: Partial<KanbanCard> = {}) => {
    try {
      const updated = await kanbanService.updateCard(card.id, { attachments: nextAttachments, ...extraPatch });
      setAttachments(updated.attachments || []);
      if (updated.coverColor !== undefined) setCover(updated.coverColor);
      onUpdated(updated);
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.updateAttachmentsError'));
    }
  };

  const toggleMemberAssignment = async (memberId: string) => {
    const currentIds = card.memberIds || [];
    const nextMemberIds = currentIds.includes(memberId)
      ? currentIds.filter((id) => id !== memberId)
      : [...currentIds, memberId];
    try {
      const updated = await kanbanService.updateCard(card.id, { memberIds: nextMemberIds });
      onUpdated(updated);
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.updateMembersError'));
    }
  };

  const setImageAsCover = async (attachment: KanbanAttachment) => {
    if (!attachment.isImage) return;
    try {
      const updated = await kanbanService.updateCard(card.id, {
        coverImageUrl: attachment.url,
        coverAttachmentId: attachment.id,
      });
      onUpdated(updated);
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.setCoverError'));
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    const nextAttachments = attachments.filter((attachment) => attachment.id !== attachmentId);
    const isCoverAttachment = card.coverAttachmentId === attachmentId;
    await persistAttachments(nextAttachments, isCoverAttachment ? { coverImageUrl: null, coverAttachmentId: null } : {});
  };

  // Upload utility comum — sobe N arquivos em paralelo e retorna metadados.
  const uploadMany = useCallback(async (files: File[]): Promise<Array<{ attachment: KanbanAttachment; file: File; isImage: boolean }>> => {
    if (files.length === 0) return [];
    const MAX_WARN = 5 * 1024 * 1024;
    const MAX_HARD = 10 * 1024 * 1024;
    const accepted: File[] = [];
    for (const f of files) {
      if (f.size > MAX_HARD) {
        toast.error(t('kanbanCardDetailModal.toasts.fileTooLarge', { size: (f.size / 1024 / 1024).toFixed(1) }));
        continue;
      }
      if (f.size > MAX_WARN) {
        toast(t('kanbanCardDetailModal.toasts.largeFile', { size: (f.size / 1024 / 1024).toFixed(1) }), { icon: '⚠️' });
      }
      accepted.push(f);
    }
    if (accepted.length === 0) return [];
    setIsUploading(true);
    try {
      const uploads = await Promise.all(accepted.map(async (file, idx) => {
        try {
          const url = await kanbanService.uploadAttachment(file);
          const isImage = file.type.startsWith('image/');
          const attachment: KanbanAttachment = {
            id: `attachment_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            url,
            isImage,
            addedAt: new Date().toISOString(),
          };
          return { attachment, file, isImage };
        } catch {
          toast.error(t('kanbanCardDetailModal.toasts.uploadFileError'));
          return null;
        }
      }));
      return uploads.filter((u): u is { attachment: KanbanAttachment; file: File; isImage: boolean } => u !== null);
    } finally {
      setIsUploading(false);
    }
  }, [setIsUploading]);

  // Anexo explícito (botão "+ Adicionar" + drag-drop). NÃO auto-set capa.
  const addFiles = useCallback(async (files: File[]) => {
    const successful = await uploadMany(files);
    if (successful.length === 0) return;
    const nextAttachments = [...attachments, ...successful.map((s) => s.attachment)];
    await persistAttachments(nextAttachments, {});
  }, [attachments, uploadMany]);

  // Paste de imagem → vai INLINE na descrição como `![nome](url)`.
  // Arquivo não-imagem do clipboard cai como anexo (markdown não suporta inline).
  const pasteFilesAsInline = useCallback(async (files: File[]) => {
    const successful = await uploadMany(files);
    if (successful.length === 0) return;
    const images = successful.filter((s) => s.isImage);
    const nonImages = successful.filter((s) => !s.isImage);
    if (images.length > 0) {
      const refs = images.map((s) => `\n![${s.file.name}](${s.attachment.url})`).join('');
      setDesc(prev => {
        const el = descRef.current;
        if (el) { const s = el.selectionStart ?? prev.length; return prev.slice(0, s) + refs + prev.slice(s); }
        return prev + refs;
      });
      onEditingStart?.('description');
      setEditDesc(true);
    }
    if (nonImages.length > 0) {
      const nextAttachments = [...attachments, ...nonImages.map((s) => s.attachment)];
      await persistAttachments(nextAttachments, {});
    }
  }, [attachments, uploadMany, onEditingStart]);

  const addFile = useCallback((file: File) => addFiles([file]), [addFiles]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void addFiles(files);
    if (fileRef.current) fileRef.current.value = '';
  };
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const img = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
    if (!img) return;
    e.preventDefault();
    const f = img.getAsFile();
    if (f) void addFile(f as File);
  }, [addFile]);

  // Paste global → imagens vão INLINE na descrição. Anexos só via botão.
  useEffect(() => {
    const onDocPaste = (e: ClipboardEvent): void => {
      if (!e.clipboardData) return;
      const files: File[] = [];
      for (const it of Array.from(e.clipboardData.items)) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      void pasteFilesAsInline(files);
    };
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, [pasteFilesAsInline]);

  // ── ACTIONS ────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    const ok = await confirm({ title: t('kanbanCardDetailModal.confirm.removeCardTitle'), message: t('kanbanCardDetailModal.confirm.removeCardMessage', { title: card.title }) });
    if (!ok) return;
    try { await kanbanService.deleteCard(card.id); onDeleted(card.id); onClose(); toast.success(t('kanbanCardDetailModal.toasts.cardRemoved')); }
    catch { toast.error(t('kanbanCardDetailModal.toasts.removeCardError')); }
  };

  const handleArchive = async () => {
    const ok = await confirm({ title: t('kanbanCardDetailModal.confirm.archiveCardTitle'), message: t('kanbanCardDetailModal.confirm.archiveCardMessage', { title: card.title }) });
    if (!ok) return;
    try {
      await kanbanService.updateCard(card.id, { isArchived: true });
      onDeleted(card.id);
      onClose();
      toast((toastHandle) => (
        <div className="flex items-center gap-3">
          <span className="text-sm">{t('kanbanCardDetailModal.toasts.cardArchived')}</span>
          <button
            onClick={async () => {
              toast.dismiss(toastHandle.id);
              try {
                const restored = await kanbanService.restoreCard(card.id);
                onUpdated(restored);
                toast.success(t('kanbanCardDetailModal.toasts.cardRestored'));
              } catch { toast.error(t('kanbanCardDetailModal.toasts.restoreCardError')); }
            }}
            className="rounded-lg bg-blue-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-600"
          >
            {t('kanbanCardDetailModal.actions.undo')}
          </button>
        </div>
      ), { duration: 6000 });
    } catch { toast.error(t('kanbanCardDetailModal.toasts.archiveCardError')); }
  };

  const submitTimeLog = async () => {
    const h = parseFloat(timeLogHours);
    if (!h || h <= 0 || submittingTimeLog) return;

    const maxH = maxHours ? parseFloat(maxHours) : null;
    const totalLogged = timeLogs.reduce((s, l) => s + l.hours, 0);
    const memberName = boardMembers.find(m => m.id === currentUserId)?.name ?? undefined;

    // If card has an hour budget and this would exceed it, create an authorization request instead
    if (maxH !== null && totalLogged + h > maxH) {
      if (submittingHourRequest) return;
      setSubmittingHourRequest(true);
      try {
        const req = await kanbanService.createHourRequest(card.id, {
          hours: h,
          description: timeLogDesc.trim() || undefined,
          loggedDate: timeLogDate,
          userName: memberName,
          userId: currentUserId ?? undefined,
        });
        setHourRequests(prev => [req, ...prev]);
        setShowTimeLogForm(false);
        setTimeLogHours('1');
        setTimeLogDesc('');
        setTimeLogDate(new Date().toISOString().slice(0, 10));
        toast(t('kanbanCardDetailModal.toasts.authRequestSent'), { icon: '⏳' });
      } catch { toast.error(t('kanbanCardDetailModal.toasts.createRequestError')); }
      finally { setSubmittingHourRequest(false); }
      return;
    }

    setSubmittingTimeLog(true);
    try {
      const log = await kanbanService.addTimeLog(card.id, {
        hours: h,
        description: timeLogDesc.trim() || undefined,
        loggedDate: timeLogDate,
        userName: memberName,
      });
      setTimeLogs(prev => [log, ...prev]);
      setShowTimeLogForm(false);
      setTimeLogHours('1');
      setTimeLogDesc('');
      setTimeLogDate(new Date().toISOString().slice(0, 10));
      toast.success(t('kanbanCardDetailModal.toasts.hoursRegistered'));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.registerHoursError')); }
    finally { setSubmittingTimeLog(false); }
  };

  const cancelHourRequest = async (requestId: string) => {
    try {
      await kanbanService.cancelHourRequest(requestId);
      setHourRequests(prev => prev.map(r => r.id === requestId ? { ...r, status: 'cancelled' } : r));
      toast.success(t('kanbanCardDetailModal.toasts.requestCancelled'));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.cancelRequestError')); }
  };

  const saveMaxHours = async () => {
    const val = maxHours.trim() === '' ? null : parseFloat(maxHours);
    if (maxHours.trim() !== '' && (isNaN(val!) || val! <= 0)) {
      toast.error(t('kanbanCardDetailModal.toasts.invalidValue'));
      return;
    }
    setSavingMaxHours(true);
    try {
      await kanbanService.updateCard(card.id, { maxHours: val } as any);
      toast.success(val ? t('kanbanCardDetailModal.toasts.limitSet', { value: val }) : t('kanbanCardDetailModal.toasts.limitRemoved'));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.saveLimitError')); }
    finally { setSavingMaxHours(false); }
  };

  const formatTotalTime = (totalHours: number): string => {
    const totalMinutes = Math.round(totalHours * 60);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const mins = totalMinutes % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
    return parts.join(' ');
  };

  const deleteTimeLog = async (logId: string) => {
    try {
      await kanbanService.deleteTimeLog(logId);
      setTimeLogs(prev => prev.filter(l => l.id !== logId));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.removeLogError')); }
  };

  const submitComment = async () => {
    const text = activityComment.trim();
    if (!text || submittingComment) return;
    setSubmittingComment(true);
    try {
      const activity = await kanbanService.addActivity(card.id, text);
      setActivities(prev => [...prev, activity]);
      setActivityComment('');
      setCommentFocused(false);
      setTimeout(() => activitiesTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
      // @mention detection
      const mentions = text.match(/@(\w[\w\s]{0,20})/g);
      if (mentions && boardMembers.length > 0) {
        const mentionedNames = mentions.map(m => m.slice(1).trim().toLowerCase());
        boardMembers
          .filter(m => mentionedNames.some(mn => m.name.toLowerCase().startsWith(mn)))
          .forEach(m => toast(t('kanbanCardDetailModal.toasts.mentionedUser', { name: m.name }), { icon: '👤' }));
      }
    } catch {
      toast.error(t('kanbanCardDetailModal.toasts.saveCommentError'));
    } finally {
      setSubmittingComment(false);
    }
  };

  const startRecording = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { toast.error(t('kanbanCardDetailModal.toasts.voiceNotSupported')); return; }

    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.interimResults = true;

    finalTextRef.current = '';
    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTextRef.current += event.results[i][0].transcript + ' ';
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setVoiceTranscript(finalTextRef.current + interim);
    };

    recognition.onend = () => {
      setVoiceTranscript(finalTextRef.current.trim());
      setIsRecording(false);
      setVoiceReady(true);
    };

    recognitionRef.current = recognition;
    setVoiceTranscript('');
    setVoiceReady(false);
    setIsRecording(true);
    setCommentFocused(true);
    recognition.start();
  };

  const stopRecording = () => {
    recognitionRef.current?.stop();
    setIsRecording(false);
  };

  const formatWithAI = async () => {
    setFormattingVoice(true);
    try {
      const { api } = await import('@/lib/api');
      const res = await api.post('/kanban/voice-format', { text: voiceTranscript });
      setActivityComment(prev => prev + (prev ? '\n' : '') + res.data.markdown);
      setVoiceTranscript('');
      setVoiceReady(false);
    } catch {
      setActivityComment(prev => prev + (prev ? '\n' : '') + voiceTranscript);
      setVoiceTranscript('');
      setVoiceReady(false);
      toast(t('kanbanCardDetailModal.toasts.aiUnavailable'), { icon: 'ℹ️' });
    }
    setFormattingVoice(false);
  };

  const startDescRecording = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { toast.error(t('kanbanCardDetailModal.toasts.voiceNotSupported')); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.interimResults = true;
    descFinalTextRef.current = '';
    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) descFinalTextRef.current += event.results[i][0].transcript + ' ';
        else interim += event.results[i][0].transcript;
      }
      setDescVoiceTranscript(descFinalTextRef.current + interim);
    };
    recognition.onend = () => {
      setDescVoiceTranscript(descFinalTextRef.current.trim());
      setIsDescRecording(false);
      setDescVoiceReady(true);
    };
    descRecognitionRef.current = recognition;
    setDescVoiceTranscript('');
    setDescVoiceReady(false);
    setIsDescRecording(true);
    recognition.start();
  };

  const stopDescRecording = () => {
    descRecognitionRef.current?.stop();
    setIsDescRecording(false);
  };

  const formatDescWithAI = async () => {
    setFormattingDescVoice(true);
    try {
      const { api } = await import('@/lib/api');
      const res = await api.post('/kanban/voice-format', { text: descVoiceTranscript });
      handleDescChange(desc + (desc ? '\n\n' : '') + res.data.markdown);
      setDescVoiceTranscript('');
      setDescVoiceReady(false);
    } catch {
      handleDescChange(desc + (desc ? '\n\n' : '') + descVoiceTranscript);
      setDescVoiceTranscript('');
      setDescVoiceReady(false);
      toast(t('kanbanCardDetailModal.toasts.aiUnavailable'), { icon: 'ℹ️' });
    }
    setFormattingDescVoice(false);
  };

  const formatDescriptionWithAI = async () => {
    if (!desc.trim()) return;
    setAiFormattingDesc(true);
    try {
      const { api } = await import('@/lib/api');
      const res = await api.post('/kanban/voice-format', { text: desc });
      handleDescChange(res.data.markdown);
      toast.success('Descrição formatada com IA');
    } catch {
      toast('IA indisponível no momento', { icon: 'ℹ️' });
    }
    setAiFormattingDesc(false);
  };

  const startLinkRecording = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { toast.error(t('kanbanCardDetailModal.toasts.voiceNotSupported')); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript.trim();
      setLinkSearch(transcript);
      void searchCardsToLink(transcript);
    };
    recognition.onend = () => setIsLinkRecording(false);
    linkRecognitionRef.current = recognition;
    setIsLinkRecording(true);
    recognition.start();
  };

  const saveStartDate = (v: string) => {
    setStartDate(v);
    setPanel(null);
    save({ startDate: v || null });
  };

  const handleVote = async () => {
    if (!currentUserId) { toast.error(t('kanbanCardDetailModal.toasts.loginToVote')); return; }
    const hasVoted = votes.includes(currentUserId);
    if (!hasVoted && votingLimit > 0 && votes.length >= votingLimit) {
      toast.error(t('kanbanCardDetailModal.toasts.voteLimitReached', { count: votingLimit }));
      return;
    }
    const nextVotes = hasVoted ? votes.filter(id => id !== currentUserId) : [...votes, currentUserId];
    setVotes(nextVotes);
    try { await kanbanService.updateCard(card.id, { votes: nextVotes }); }
    catch { setVotes(votes); toast.error(t('kanbanCardDetailModal.toasts.registerVoteError')); }
  };

  const saveRecurrence = async (rec: KanbanRecurrence | null) => {
    setRecurrence(rec);
    try { await kanbanService.updateCard(card.id, { recurrence: rec }); }
    catch { setRecurrence(recurrence); toast.error(t('kanbanCardDetailModal.toasts.saveRecurrenceError')); }
  };

  const saveCustomField = async (fieldId: string, value: string | number | boolean | null) => {
    const next = { ...customFields, [fieldId]: value };
    setCustomFields(next);
    try { await kanbanService.updateCard(card.id, { customFields: next }); }
    catch { setCustomFields(customFields); toast.error(t('kanbanCardDetailModal.toasts.saveFieldError')); }
  };

  const toggleSticker = async (emoji: string) => {
    const next = stickers.includes(emoji)
      ? stickers.filter(s => s !== emoji)
      : [...stickers, emoji];
    setStickers(next);
    try { await kanbanService.updateCard(card.id, { stickers: next }); }
    catch { setStickers(stickers); toast.error(t('kanbanCardDetailModal.toasts.saveStickerError')); }
  };

  const handleDuplicate = async () => {
    try {
      const duplicated = await kanbanService.duplicateCard(card.id);
      onCardAdded?.(duplicated);
      toast.success(t('kanbanCardDetailModal.toasts.cardDuplicated'));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.duplicateCardError')); }
  };

  const startEditComment = (act: KanbanActivity) => {
    setEditingCommentId(act.id);
    setEditCommentText(act.text);
  };

  const saveEditComment = async (actId: string) => {
    const text = editCommentText.trim();
    if (!text) return;
    try {
      const updated = await kanbanService.updateActivity(actId, text);
      setActivities(prev => prev.map(a => a.id === actId ? updated : a));
      setEditingCommentId(null);
    } catch { toast.error(t('kanbanCardDetailModal.toasts.editCommentError')); }
  };

  const deleteComment = async (actId: string) => {
    const ok = await confirm({ title: t('kanbanCardDetailModal.confirm.removeCommentTitle'), message: t('kanbanCardDetailModal.confirm.removeCommentMessage') });
    if (!ok) return;
    try {
      await kanbanService.deleteActivity(actId);
      setActivities(prev => prev.filter(a => a.id !== actId));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.removeCommentError')); }
  };

  const openMoveToBoard = async () => {
    setShowMoveToBoard(true);
    try {
      const boards = await kanbanService.listBoards();
      setOtherBoards(boards.filter(b => b.id !== boardId));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.loadBoardsError')); }
  };

  const handleMoveToBoardChange = async (targetBoardId: string) => {
    setMoveToBoardId(targetBoardId);
    setMoveToListId('');
    if (!targetBoardId) { setMoveToBoardLists([]); return; }
    try {
      const boardData = await kanbanService.getBoard(targetBoardId);
      setMoveToBoardLists(boardData.lists ?? []);
    } catch { toast.error(t('kanbanCardDetailModal.toasts.loadListsError')); }
  };

  const handleMoveToBoard = async () => {
    if (!moveToBoardId || !moveToListId) { toast.error(t('kanbanCardDetailModal.toasts.selectBoardAndList')); return; }
    try {
      await kanbanService.moveCardToBoard(card.id, { targetBoardId: moveToBoardId, targetListId: moveToListId, position: 9999 });
      onDeleted(card.id);
      onClose();
      toast.success(t('kanbanCardDetailModal.toasts.cardMovedToOtherBoard'));
    } catch { toast.error(t('kanbanCardDetailModal.toasts.moveCardError')); }
  };

  const tp = (p: Panel) => setPanel(cur => cur === p ? null : p);

  // ── COMPUTED ───────────────────────────────────────────────────────────────

  const hasColorCover = cover !== '#ffffff';
  const hasImageCover = !!card.coverImageUrl;
  const hasCover   = hasImageCover || hasColorCover;
  const totalItems = checklists.reduce((acc, g) => acc + g.items.length, 0);
  const doneItems  = checklists.reduce((acc, g) => acc + g.items.filter(i => i.done).length, 0);
  const pct        = totalItems ? Math.round(doneItems / totalItems * 100) : 0;
  const now        = new Date();
  const due        = dueDate ? new Date(dueDate+'T12:00:00') : null;
  const isOverdue  = due && due < now && due.toDateString() !== now.toDateString();
  const isToday    = due && due.toDateString() === now.toDateString();

  const startD = startDate ? new Date(startDate+'T12:00:00') : null;

  // @ts-ignore
  const activitySummary = [
    selectedMembers.length > 0 ? { title: t('kanbanCardDetailModal.meta.membersTitle'), node: (
      <div className="flex items-center gap-1.5">
        {selectedMembers.slice(0, 4).map((member) => (
          <span key={member.id} className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: member.avatarColor || '#579dff' }}>
            {member.name.slice(0, 2).toUpperCase()}
          </span>
        ))}
        <button onClick={() => tp('members')} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#091e420f] text-[#44546f] transition-colors hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:text-[#8c9bab]">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    ) } : null,
    labels.length > 0 ? { title: t('kanbanCardDetailModal.meta.labelsTitle'), node: (
      <div className="flex flex-wrap gap-1.5">
        {labels.map((lbl, i) => (
          <span key={i} className="inline-flex items-center rounded-md px-3 py-1 text-xs font-bold text-white" style={{ background: lbl.color }}>
            {lbl.text}
          </span>
        ))}
        <button onClick={() => tp('labels')} className="flex h-7 min-w-7 items-center justify-center rounded-md bg-[#091e420f] px-2 text-[#44546f] transition-colors hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:text-[#8c9bab]">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    ) } : null,
    dueDate && due ? { title: t('kanbanCardDetailModal.meta.dueDateTitle'), node: (
      <button
        onClick={() => tp('duedate')}
        className={`inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium ${
          pct===100 && totalItems>0 ? 'bg-[#1f845a] text-white'
          : isOverdue ? 'bg-[#ffeceb] text-[#ae2a19] dark:bg-[#5d1f1a] dark:text-[#ffd2cc]'
          : isToday ? 'bg-[#fff3cd] text-[#7f5f01] dark:bg-[#4a3200] dark:text-[#f5cd47]'
          : 'bg-[#091e420f] text-[#172b4d] dark:bg-[#ffffff1f] dark:text-[#b6c2cf]'
        }`}
      >
        <Calendar className="h-3.5 w-3.5" />
        {due.toLocaleDateString(i18n.language,{day:'2-digit',month:'short',year:'numeric'})}
        {pct===100 && totalItems>0 && <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em]">{t('kanbanCardDetailModal.status.complete')}</span>}
      </button>
    ) } : null,
  ].filter(Boolean) as Array<{ title: string; node: React.ReactNode }>;

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      void addFiles(files);
    }
  };



  return {
    // States
    title, setTitle, desc, setDesc, editDesc, setEditDesc,
    descCollapsed, setDescCollapsed,
    dueDate, setDueDate, startDate, setStartDate,
    votes, setVotes, stickers, setStickers,
    customFields, setCustomFields, recurrence, setRecurrence,
    labels, setLabels, checklists, setChecklists,
    cover, setCover, panel, setPanel,
    memberSearch, setMemberSearch,
    newGroupTitle, setNewGroupTitle,
    newItemTexts, setNewItemTexts,
    lblText, setLblText, lblColor, setLblColor,
    attachments, setAttachments,
    activityComment, setActivityComment,
    commentFocused, setCommentFocused,
    showOnlyComments, setShowOnlyComments,
    activities, setActivities,
    loadingActivities, setLoadingActivities,
    submittingComment, setSubmittingComment,
    timeLogs, setTimeLogs,
    showTimeLogForm, setShowTimeLogForm,
    timeLogHours, setTimeLogHours,
    timeLogDesc, setTimeLogDesc,
    timeLogDate, setTimeLogDate,
    submittingTimeLog, setSubmittingTimeLog,
    maxHours, setMaxHours,
    savingMaxHours, setSavingMaxHours,
    hourRequests, setHourRequests,
    submittingHourRequest, setSubmittingHourRequest,
    timeDisplayMode, setTimeDisplayMode,
    isUploading, setIsUploading,
    previewImage, setPreviewImage,
    descSaved, setDescSaved,
    descConflict, setDescConflict,
    editingCommentId, setEditingCommentId,
    editCommentText, setEditCommentText,
    isWatching, setIsWatching,
    summaryOpen, setSummaryOpen,
    actionsOpen, setActionsOpen,
    locationLat, setLocationLat,
    locationLng, setLocationLng,
    locationAddress, setLocationAddress,
    showMoveToBoard, setShowMoveToBoard,
    otherBoards, setOtherBoards,
    moveToBoardId, setMoveToBoardId,
    moveToBoardLists, setMoveToBoardLists,
    moveToListId, setMoveToListId,
    showExecuteModal, setShowExecuteModal,
    executionsCollapsed, setExecutionsCollapsed,
    activeExecId, setActiveExecId,
    liveLog, setLiveLog,
    liveLogDone, setLiveLogDone,
    linkedCards, setLinkedCards,
    linkSearch, setLinkSearch,
    linkSearchResults, setLinkSearchResults,
    linkSearchLoading, setLinkSearchLoading,
    linkingCard, setLinkingCard,
    blockerCards, setBlockerCards,
    blockerSearch, setBlockerSearch,
    blockerSearchResults, setBlockerSearchResults,
    blockerSearchLoading, setBlockerSearchLoading,
    addingBlocker, setAddingBlocker,
    isLinkRecording, setIsLinkRecording,
    showSnooze, setShowSnooze,
    snoozeDate, setSnoozeDate,
    showDrivePicker, setShowDrivePicker,
    driveFiles, setDriveFiles,
    driveLoading, setDriveLoading,
    driveFolderStack, setDriveFolderStack,
    driveSearch, setDriveSearch,
    showGiphy, setShowGiphy,
    giphySearch, setGiphySearch,
    giphyGifs, setGiphyGifs,
    giphyLoading, setGiphyLoading,
    voiceTranscript, setVoiceTranscript,
    isRecording, setIsRecording,
    voiceReady, setVoiceReady,
    formattingVoice, setFormattingVoice,
    descVoiceTranscript, setDescVoiceTranscript,
    isDescRecording, setIsDescRecording,
    descVoiceReady, setDescVoiceReady,
    formattingDescVoice, setFormattingDescVoice,
    aiFormattingDesc, setAiFormattingDesc,
    showGithub, setShowGithub,
    githubIssues, setGithubIssues,
    githubPRs, setGithubPRs,
    githubLoading, setGithubLoading,
    githubCreatingIssue, setGithubCreatingIssue,
    githubTab, setGithubTab,
    githubPowerUp, setGithubPowerUp,
    githubSetupOpen, setGithubSetupOpen,
    githubSetup, setGithubSetup,
    githubSetupSaving, setGithubSetupSaving,
    showConfluence, setShowConfluence,
    showConfluenceModal, setShowConfluenceModal,
    confluenceSearch, setConfluenceSearch,
    confluencePages, setConfluencePages,
    confluenceLoading, setConfluenceLoading,
    decomposing, setDecomposing,
    linkedConfluencePages,

    // Refs
    linkRecognitionRef, activitiesTopRef,
    recognitionRef, finalTextRef,
    descRecognitionRef, descFinalTextRef,
    liveLogRef, fileRef, descRef, descTimerRef,

    // Computed values
    groupedActivities, sensors, selectedMembers,
    hasColorCover, hasImageCover, hasCover,
    totalItems, doneItems, pct,
    now, due, isOverdue, isToday, startD,
    activitySummary, isSnoozed,

    // Query data
    agentStatus, boardRepos, executions, listConfig, queryClient,

    // Handlers
    handleDragOver, handleDragLeave, handleDrop,
    handleExecuted, save, saveTitle, saveDesc,
    handleToggleWatch, saveLocation, handleDescChange,
    saveDue, saveCover, removeCover,
    toggleLabel, addCustomLabel, removeLabel,
    saveChecklists, addChecklistGroup, deleteGroup,
    addItemToGroup, toggleItem, removeItem, convertItemToCard,
    searchCardsToLink, linkCard, unlinkCard,
    searchBlockerCandidates, addBlocker, removeBlocker,
    hideCompleted, updateItemMeta, handleChecklistDragEnd,
    persistAttachments, toggleMemberAssignment, setImageAsCover,
    removeAttachment, addFile, handleFileChange, handlePaste,
    handleDelete, handleArchive,
    submitTimeLog, cancelHourRequest, saveMaxHours,
    formatTotalTime, deleteTimeLog,
    submitComment,
    startRecording, stopRecording, formatWithAI,
    startDescRecording, stopDescRecording,
    formatDescWithAI, formatDescriptionWithAI,
    startLinkRecording,
    saveStartDate, handleVote, saveRecurrence, saveCustomField,
    toggleSticker, handleDuplicate,
    startEditComment, saveEditComment, deleteComment,
    openMoveToBoard, handleMoveToBoardChange, handleMoveToBoard,
    tp,

    // Drag state
    isDragOver, setIsDragOver,
  };
}
