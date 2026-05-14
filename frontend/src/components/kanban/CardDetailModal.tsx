// flowbuilder/src/components/kanban/CardDetailModal.tsx
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  X, Calendar, Trash2, Plus, Check, AlignLeft, Tag,
  CheckSquare, Palette, Users, Paperclip, LayoutList, Clock3, Image as ImageIcon,
  // @ts-ignore
  Archive, Save, Copy, ArrowRightCircle, ThumbsUp, Edit3, Eye, EyeOff, MapPin, Maximize2, Timer,
  ChevronUp, ChevronDown, Bot, XCircle, Loader2, MessageSquare, AlertTriangle, AlarmClock, Sparkles, Mic,
  Lock, Unlock,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import kanbanAgentService, {
  KanbanAgentExecution, AgentStatus,
  EXEC_TYPE_LABELS, EXEC_TYPE_EMOJIS, STATUS_LABELS, STATUS_COLORS,
  subscribeToExecution, subscribeToAgentStatus,
} from '@/services/kanbanAgent.service';
import { ExecuteAgentModal } from './ExecuteAgentModal';
import { KanbanMarkdown, Btn, PanelWrap, Pop, LABEL_PRESETS, COVER_COLORS, getActivityIcon, groupActivitiesByDate } from './detail';
import kanbanService, {
  KanbanAttachment, KanbanBoardMember, KanbanCard, KanbanLabel,
  KanbanChecklistGroup, KanbanChecklistItem, KanbanActivity, KanbanTimeLog, KanbanBoard, KanbanList,
  KanbanCustomFieldDef, KanbanRecurrence, KanbanCardLocation, KanbanHourRequest,
} from '@/services/kanban.service';
import { useConfirm } from '@/hooks/useConfirm';
import Picker from '@emoji-mart/react';
import emojiData from '@emoji-mart/data';
import {
  DndContext, DragEndEvent, closestCenter,
  PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// mermaid functions and COVER_COLORS now come from ./detail

type Panel = 'labels'|'checklist'|'duedate'|'startdate'|'cover'|'members'|'stickers'|'customfields'|'recurrence'|'location'|null;

// emoji-mart é importado dinamicamente no picker abaixo

interface Props {
  card: KanbanCard;
  listTitle: string;
  boardId: string;
  boardMembers: KanbanBoardMember[];
  customFieldDefs?: KanbanCustomFieldDef[];
  currentUserId?: string;
  onClose: () => void;
  onUpdated: (c: KanbanCard) => void;
  onDeleted: (id: string) => void;
  onCardAdded?: (c: KanbanCard) => void;
  onOpenCard?: (cardId: string) => void;
  fullPage?: boolean;
  onOpenFullPage?: () => void;
  onEditingStart?: (field: string) => void;
  onEditingStop?: (field: string) => void;
  editorsInfo?: { userId: string; field: string }[];
  canEdit?: boolean;
  canComment?: boolean;
  votingLimit?: number; // 0 = unlimited
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

function ExecutionRow({ exec }: { exec: KanbanAgentExecution }) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div className="rounded-lg border border-[#dcdfe4] bg-[#f8f9fa] dark:border-[#2e3541] dark:bg-[#161b27]">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-base">{EXEC_TYPE_EMOJIS[exec.execType]}</span>
        <span className="flex-1 text-xs font-medium text-[#172b4d] dark:text-gray-200">
          {EXEC_TYPE_LABELS[exec.execType]}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[exec.status]}`}>
          {STATUS_LABELS[exec.status]}
        </span>
        {exec.agentMachine && (
          <span className="text-[10px] text-[#8590a2]">{exec.agentMachine}</span>
        )}
        <span className="text-[10px] text-[#8590a2]">
          {exec.costUsd > 0 ? `$${Number(exec.costUsd).toFixed(4)}` : ''}
        </span>
        {expanded ? <ChevronUp className="h-3.5 w-3.5 text-[#8590a2]" /> : <ChevronDown className="h-3.5 w-3.5 text-[#8590a2]" />}
      </button>
      {expanded && exec.result && (
        <div className="border-t border-[#dcdfe4] px-3 py-2 dark:border-[#2e3541]">
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-[#44546f] dark:text-gray-400">
            {exec.result}
          </pre>
          {exec.branchCreated && (
            <div className="mt-1 text-[11px] text-[#0c66e4] dark:text-blue-400">
              Branch: <code>{exec.branchCreated}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// getActivityIcon and groupActivitiesByDate imported from ./detail

interface SortableChecklistItemProps {
  id: string;
  item: KanbanChecklistItem;
  boardMembers: KanbanBoardMember[];
  onToggle: () => void;
  onRemove: () => void;
  onConvert: () => void;
  onUpdateMeta: (meta: { dueDate?: string | null; assignedTo?: string | null }) => void;
}

function SortableChecklistItem({ id, item, boardMembers, onToggle, onRemove, onConvert, onUpdateMeta }: SortableChecklistItemProps) {
  const { t, i18n } = useTranslation('common');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const assignedMember = boardMembers.find(m => m.id === item.assignedTo);
  return (
    <div ref={setNodeRef} style={style} className="group flex flex-col rounded-xl px-2 py-1.5 hover:bg-[#091e420f] dark:hover:bg-[#ffffff08]">
      <div className="flex items-center gap-2">
        <button {...attributes} {...listeners} className="cursor-grab p-0.5 text-[#c1c7d0] hover:text-[#44546f] flex-shrink-0 opacity-0 group-hover:opacity-100">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <circle cx="4" cy="3" r="1"/><circle cx="8" cy="3" r="1"/>
            <circle cx="4" cy="6" r="1"/><circle cx="8" cy="6" r="1"/>
            <circle cx="4" cy="9" r="1"/><circle cx="8" cy="9" r="1"/>
          </svg>
        </button>
        <input type="checkbox" checked={item.done} onChange={onToggle} className="w-4 h-4 accent-[#579dff] cursor-pointer flex-shrink-0 rounded" />
        <span className={`flex-1 text-sm ${item.done ? 'line-through text-[#8590a2]' : 'text-[#172b4d] dark:text-[#b6c2cf]'}`}>{item.text}</span>
        {assignedMember && (
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: assignedMember.avatarColor || '#579dff' }} title={assignedMember.name}>
            {assignedMember.name.slice(0, 2).toUpperCase()}
          </span>
        )}
        <button onClick={onConvert} title={t('kanbanCardDetailModal.checklist.convertToCard')} className="opacity-0 group-hover:opacity-100 px-1 py-0.5 rounded text-[10px] font-bold text-[#626f86] hover:text-[#0c66e4] hover:bg-[#e9f2ff] flex-shrink-0">→</button>
        <button onClick={onRemove} className="opacity-0 group-hover:opacity-100 p-0.5 text-[#626f86] hover:text-red-500 flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="ml-12 mt-1 flex flex-wrap items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <input
          type="date"
          value={item.dueDate?.slice(0, 10) ?? ''}
          onChange={e => onUpdateMeta({ dueDate: e.target.value || null })}
          className="rounded border border-[#cfd3d8] bg-white px-1.5 py-0.5 text-[10px] text-[#44546f] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#8c9bab]"
          title={t('kanbanCardDetailModal.checklist.itemDueDate')}
        />
        {item.dueDate && (
          <span className="text-[10px] text-[#626f86] dark:text-[#8c9bab]">
            {new Date(item.dueDate).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short' })}
          </span>
        )}
        {boardMembers.length > 0 && (
          <select
            value={item.assignedTo ?? ''}
            onChange={e => onUpdateMeta({ assignedTo: e.target.value || null })}
            className="rounded border border-[#cfd3d8] bg-white px-1 py-0.5 text-[10px] text-[#44546f] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#8c9bab]"
            title={t('kanbanCardDetailModal.checklist.itemAssignee')}
          >
            <option value="">{t('kanbanCardDetailModal.checklist.assignee')}</option>
            {boardMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

export const CardDetailModal: React.FC<Props> = ({ card, listTitle, boardId, boardMembers, customFieldDefs = [], currentUserId, onClose, onUpdated, onDeleted, onCardAdded, onOpenCard, fullPage = false, onOpenFullPage, onEditingStart, onEditingStop, editorsInfo = [], canEdit = true, canComment = true, votingLimit = 0 }) => {
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
  const [blockerCards, setBlockerCards] = useState<Array<{ id: string; title: string; listTitle: string; boardTitle: string }>>([]);
  const [blockerSearch, setBlockerSearch] = useState('');
  const [blockerSearchResults, setBlockerSearchResults] = useState<Array<{ id: string; title: string; listTitle: string; boardTitle: string }>>([]);
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
  const [aiFormattingComment, setAiFormattingComment] = useState(false);
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
          .map(r => ({ id: r.id, title: r.title, listTitle: r.listTitle ?? '', boardTitle: r.boardTitle ?? '' }))
      );
    } finally {
      setBlockerSearchLoading(false);
    }
  };

  const addBlocker = async (blockerId: string, blockerTitle: string, blockerListTitle: string, blockerBoardTitle: string) => {
    setAddingBlocker(true);
    try {
      await kanbanService.addBlocker(card.id, blockerId);
      setBlockerCards(prev => [...prev, { id: blockerId, title: blockerTitle, listTitle: blockerListTitle, boardTitle: blockerBoardTitle }]);
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

  // Upload utility comum — sobe N arquivos em paralelo e retorna
  // metadados. Não toca em attachments nem em description; quem chama
  // decide o destino. Histórico: o antigo addFile lia `attachments` da
  // closure e race conditions sobrescreviam o estado anterior.
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

  // addFiles → fluxo explícito de anexo (botão "+ Adicionar" + drag-drop).
  // SEM auto-set de capa: capa é decisão deliberada do usuário (botão "Definir como capa").
  const addFiles = useCallback(async (files: File[]) => {
    const successful = await uploadMany(files);
    if (successful.length === 0) return;
    const nextAttachments = [...attachments, ...successful.map((s) => s.attachment)];
    await persistAttachments(nextAttachments, {});
  }, [attachments, uploadMany]);

  // pasteFilesAsInline → fluxo de paste/screenshot. Imagens entram inline
  // na descrição como `![nome](url)` (não como anexo, não como capa).
  // Arquivos não-imagem viram anexo já que markdown não suporta inline.
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
    if (f) void addFile(f);
  }, [addFile]);

  // Paste global → imagens vão INLINE na descrição como `![nome](url)`.
  // NÃO criam anexo. NÃO criam capa. Anexos só via botão "+ Adicionar"
  // ou drag-drop explícito; capa só via botão "Definir como capa".
  // Texto puro do clipboard segue normal (não interceptamos).
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

  const formatCommentWithAI = async () => {
    if (!activityComment.trim()) return;
    setAiFormattingComment(true);
    try {
      const { api } = await import('@/lib/api');
      const res = await api.post('/kanban/voice-format', { text: activityComment });
      setActivityComment(res.data.markdown);
      toast.success('Comentário formatado com IA');
    } catch {
      toast('IA indisponível no momento', { icon: 'ℹ️' });
    }
    setAiFormattingComment(false);
  };

  const formatEditCommentWithAI = async () => {
    if (!editCommentText.trim()) return;
    setAiFormattingComment(true);
    try {
      const { api } = await import('@/lib/api');
      const res = await api.post('/kanban/voice-format', { text: editCommentText });
      setEditCommentText(res.data.markdown);
      toast.success('Comentário formatado com IA');
    } catch {
      toast('IA indisponível no momento', { icon: 'ℹ️' });
    }
    setAiFormattingComment(false);
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
  // "Concluído" — fonte única de verdade. Setado via botão no header,
  // grava ISO em customFields.__completedAt (sem mexer no schema do
  // backend). Quando true, suprime "Atrasado" / "Vence hoje" porque
  // não tem sentido um card pronto vencer.
  const completedAt = customFields?.['__completedAt'] as string | undefined;
  const isDone      = Boolean(completedAt);
  const isOverdue  = !isDone && due && due < now && due.toDateString() !== now.toDateString();
  const isToday    = !isDone && due && due.toDateString() === now.toDateString();

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
    if (files.length > 0) void addFiles(files);
  };

  const _inner = (
    <div
      className={fullPage
        ? "relative w-full bg-white dark:bg-[#22272b]"
        : "relative w-full max-w-[1160px] rounded-2xl sm:rounded-[28px] border border-slate-200 bg-white shadow-[0_30px_90px_-40px_rgba(15,23,42,0.7)] dark:border-[#3b4754] dark:bg-[#22272b]"
      }
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag-drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#579dff]/10 backdrop-blur-sm border-2 border-dashed border-[#579dff] rounded-2xl">
          <div className="flex flex-col items-center gap-2 rounded-2xl bg-white/95 px-8 py-6 shadow-lg dark:bg-[#22272b]/95">
            <Paperclip className="h-8 w-8 text-[#579dff]" />
            <p className="text-sm font-semibold text-[#172b4d] dark:text-white">{t('kanbanCardDetailModal.dragDrop.title')}</p>
            <p className="text-xs text-[#626f86] dark:text-gray-400">{t('kanbanCardDetailModal.dragDrop.description')}</p>
          </div>
        </div>
      )}

          {/* Cover */}
          {hasCover && (
            <div
              className={`group relative overflow-hidden ${card.coverImageUrl ? 'h-44' : 'h-10'}`}
              style={{ background: card.coverImageUrl ? undefined : cover }}
            >
              {card.coverImageUrl ? (
                <img src={card.coverImageUrl} alt={card.title} className="h-full w-full object-cover" />
              ) : null}
              <div className="absolute inset-0 flex items-end justify-end gap-1.5 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => tp('cover')}
                  className="flex items-center gap-1 rounded px-2 py-1 bg-black/40 hover:bg-black/60 text-white text-xs font-medium transition-colors"
                >
                  <Palette className="w-3 h-3" /> {t('kanbanCardDetailModal.actions.changeCover')}
                </button>
                <button
                  onClick={removeCover}
                  className="flex items-center gap-1 rounded px-2 py-1 bg-black/40 hover:bg-black/60 text-white text-xs font-medium transition-colors"
                >
                  <X className="w-3 h-3" /> {t('kanbanCardDetailModal.actions.remove')}
                </button>
              </div>
            </div>
          )}

          {/* Close / Expand */}
          <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
            {!fullPage && onOpenFullPage && (
              <button onClick={onOpenFullPage} title={t('kanbanCardDetailModal.actions.openFullScreen')} className="p-1.5 rounded-full bg-[#091e420f] hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:hover:bg-[#ffffff3d] text-[#44546f] dark:text-[#8c9bab] transition-colors">
                <Maximize2 className="w-4 h-4" />
              </button>
            )}
            {!fullPage && (
              <button onClick={onClose} className="p-1.5 rounded-full bg-[#091e420f] hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:hover:bg-[#ffffff3d] text-[#44546f] dark:text-[#8c9bab] transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="flex flex-col md:flex-row gap-0">

            {/* ── LEFT: main content ── */}
            <div className="min-w-0 flex-1 p-4 sm:p-7 sm:pr-5">

              {/* Title */}
              <div className="mb-2 flex items-start gap-3 pr-16">
                <div className="mt-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[#091e420f] text-[#44546f] dark:bg-[#ffffff14] dark:text-[#8c9bab]">
                  <LayoutList className="h-4 w-4" />
                </div>
                <textarea
                  value={title}
                  onChange={e => canEdit && setTitle(e.target.value)}
                  onBlur={saveTitle}
                  readOnly={!canEdit}
                  rows={title.length > 50 ? 2 : 1}
                  className={`w-full resize-none rounded-xl bg-transparent px-2 py-1 text-xl sm:text-[26px] font-bold leading-tight text-[#172b4d] outline-none transition-colors dark:text-[#b6c2cf] ${canEdit ? 'hover:bg-[#f1f2f4] focus:bg-[#f1f2f4] dark:hover:bg-[#282e33] dark:focus:bg-[#282e33]' : 'cursor-default'}`}
                />
              </div>
              {/* Breadcrumb / context row */}
              <div className="mb-4 ml-11 flex flex-wrap items-center gap-1.5 text-xs text-[#626f86] dark:text-[#8c9bab]">
                <span className="inline-flex items-center gap-1 rounded-md bg-[#f1f2f4] px-2 py-0.5 font-medium text-[#44546f] dark:bg-[#282e33] dark:text-[#8c9bab]">
                  <LayoutList className="h-2.5 w-2.5" />
                  {listTitle}
                </span>
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => {
                    const next: Record<string, string | number | boolean | null> = { ...customFields };
                    if (isDone) {
                      delete next['__completedAt'];
                    } else {
                      next['__completedAt'] = new Date().toISOString();
                    }
                    setCustomFields(next);
                    kanbanService
                      .updateCard(card.id, { customFields: next })
                      .catch(() => {
                        setCustomFields(customFields);
                        toast.error(t('kanbanCardDetailModal.toasts.saveFieldError'));
                      });
                  }}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-semibold transition-colors ${
                    isDone
                      ? 'bg-[#1f845a] text-white hover:bg-[#216e4e]'
                      : 'border border-[#1f845a] text-[#1f845a] hover:bg-[#dcfff1] dark:border-[#4bce97] dark:text-[#4bce97] dark:hover:bg-[#1a3828]'
                  } ${canEdit ? '' : 'cursor-not-allowed opacity-60'}`}
                  title={isDone ? 'Reabrir card' : 'Marcar como concluído'}
                >
                  <Check className="h-2.5 w-2.5" />
                  {isDone ? 'Concluído' : 'Concluir'}
                </button>
                {isOverdue && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#ffeceb] px-2 py-0.5 font-semibold text-[#ae2a19] dark:bg-[#5d1f1a] dark:text-[#ffd2cc]">
                    <Calendar className="h-2.5 w-2.5" /> {t('kanbanCardDetailModal.status.overdue')}
                  </span>
                )}
                {isToday && !isOverdue && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#fff3cd] px-2 py-0.5 font-semibold text-[#7f5f01] dark:bg-[#4a3200] dark:text-[#f5cd47]">
                    <Calendar className="h-2.5 w-2.5" /> {t('kanbanCardDetailModal.status.dueToday')}
                  </span>
                )}
                {!isDone && pct === 100 && totalItems > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#dcfff1] px-2 py-0.5 font-semibold text-[#1a6835] dark:bg-[#1a3828] dark:text-[#4bce97]">
                    <Check className="h-2.5 w-2.5" /> {t('kanbanCardDetailModal.status.complete')}
                  </span>
                )}
                {isSnoozed && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 font-semibold text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400">
                    <AlarmClock className="h-2.5 w-2.5" /> {t('kanbanCardDetailModal.labels.snoozed')}
                  </span>
                )}
              </div>
              {/* Integration badges — moved into breadcrumb row above, kept here for compatibility */}
              {(card.customFields?.['__jiraIssueKey'] || card.customFields?.['__githubIssueNumber'] || card.customFields?.['__githubPrNumber'] || card.customFields?.['__githubBranch'] || card.customFields?.['__emailFrom']) && (
                <div className="mb-3 ml-11 flex flex-wrap items-center gap-1.5">
                  {card.customFields?.['__jiraIssueKey'] && (
                    <a href={card.customFields['__jiraIssueUrl'] as string} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md bg-[#0052cc] px-2 py-0.5 text-xs font-medium text-white hover:bg-[#0747a6] transition-colors">
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53Zm-4.67 4.65c-.01 2.4 1.95 4.35 4.35 4.36h1.78v1.7c0 2.4 1.94 4.35 4.34 4.35V7.5a.84.84 0 0 0-.84-.84H6.86Zm-4.67 4.67a4.35 4.35 0 0 0 4.35 4.35h1.78v1.7c0 2.39 1.95 4.34 4.34 4.34v-9.55a.84.84 0 0 0-.84-.84H2.19Z"/></svg>
                      {card.customFields['__jiraIssueKey'] as string}
                    </a>
                  )}
                  {card.customFields?.['__githubIssueNumber'] && (
                    <a href={card.customFields['__githubIssueUrl'] as string} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md bg-[#238636] px-2 py-0.5 text-xs font-medium text-white hover:bg-[#2ea043] transition-colors">
                      <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                      #{card.customFields['__githubIssueNumber'] as string}
                    </a>
                  )}
                  {card.customFields?.['__githubPrNumber'] && (
                    <a href={card.customFields['__githubPrUrl'] as string} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md bg-[#8250df] px-2 py-0.5 text-xs font-medium text-white hover:bg-[#6e40c9] transition-colors">
                      <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>
                      PR #{card.customFields['__githubPrNumber'] as string}
                    </a>
                  )}
                  {card.customFields?.['__githubBranch'] && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[#1f6feb] px-2 py-0.5 text-xs font-medium text-white">
                      <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>
                      {card.customFields['__githubBranch'] as string}
                    </span>
                  )}
                  {card.customFields?.['__emailFrom'] && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[#e774bb] px-2 py-0.5 text-xs font-medium text-white">
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                      {(card.customFields['__emailFrom'] as string).replace(/.*<([^>]+)>.*/, '$1')}
                    </span>
                  )}
                </div>
              )}

              {/* Confluence linked pages */}
              {linkedConfluencePages.length > 0 && (
                <div className="mb-4 ml-12">
                  <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sections.confluence')}</p>
                  <div className="space-y-1">
                    {linkedConfluencePages.map(page => (
                      <div key={page.id} className="flex items-center gap-2 rounded-lg bg-[#deebff] px-3 py-2 dark:bg-[#1c2b41] group">
                        <svg className="w-4 h-4 text-[#0052cc] flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M3.27 14.22c-.2.34-.43.72-.62 1a.58.58 0 0 0 .2.8l3.64 2.22a.57.57 0 0 0 .79-.18c.16-.26.38-.6.63-1 1.68-2.63 3.38-2.3 6.46-.84l3.64 1.72a.58.58 0 0 0 .77-.27l1.63-3.47a.58.58 0 0 0-.28-.76c-.91-.43-2.73-1.29-3.64-1.72-5.5-2.59-9.1-2.59-13.22 2.5zm17.46-4.44c.2-.34.43-.72.62-1a.58.58 0 0 0-.2-.8L17.5 5.76a.57.57 0 0 0-.79.18c-.16.26-.38.6-.63 1-1.68 2.63-3.38 2.3-6.46.84L5.98 6.06a.58.58 0 0 0-.77.27L3.58 9.8a.58.58 0 0 0 .28.76c.91.43 2.73 1.29 3.64 1.72 5.5 2.59 9.1 2.59 13.22-2.5z"/></svg>
                        <a href={page.webUrl} target="_blank" rel="noopener noreferrer" className="flex-1 text-xs font-medium text-[#0052cc] hover:underline dark:text-[#85b8ff] truncate">
                          {page.title}
                        </a>
                        <span className="text-[10px] text-[#626f86] dark:text-gray-500">{page.spaceKey}</span>
                        <button
                          onClick={async () => {
                            try {
                              await kanbanService.unlinkConfluencePage(card.id, page.id);
                              const newPages = linkedConfluencePages.filter(p => p.id !== page.id);
                              const cf = { ...(card.customFields || {}) };
                              if (newPages.length) cf['__confluencePages'] = JSON.stringify(newPages);
                              else delete cf['__confluencePages'];
                              onUpdated({ ...card, customFields: cf });
                              toast.success(t('kanbanCardDetailModal.toasts.confluenceUnlinked'));
                            } catch { toast.error(t('kanbanCardDetailModal.toasts.confluenceUnlinkError')); }
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 text-[#626f86] hover:text-red-500"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Snooze banner */}
              {isSnoozed && (
                <div className="mb-4 ml-12 flex items-center gap-2 rounded-xl bg-indigo-50 px-4 py-2.5 dark:bg-indigo-900/20">
                  <AlarmClock className="h-4 w-4 text-indigo-500" />
                  <span className="text-sm text-indigo-700 dark:text-indigo-300">
                    {t('kanbanCardDetailModal.snooze.banner')} <strong>{new Date(card.customFields['__snoozedUntil'] as string).toLocaleDateString(i18n.language, { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
                  </span>
                  <button
                    onClick={async () => {
                      try {
                        const updated = await kanbanService.unsnoozeCard(card.id);
                        onUpdated(updated);
                        toast.success(t('kanbanCardDetailModal.toasts.unsnoozeSuccess'));
                      } catch { toast.error(t('kanbanCardDetailModal.toasts.unsnoozeError2')); }
                    }}
                    className="ml-auto rounded-lg bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-800 dark:text-indigo-200 dark:hover:bg-indigo-700"
                  >
                    {t('kanbanCardDetailModal.sidebar.wakeUpNow')}
                  </button>
                </div>
              )}

              {/* Votes badge — compact, integrated */}
              {votes.length > 0 && (
                <div className="mb-3 ml-11 flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#e9f2ff] px-2 py-0.5 text-xs font-semibold text-[#0c66e4] dark:bg-[#1c2b41] dark:text-[#85b8ff]">
                    <ThumbsUp className="h-2.5 w-2.5" />
                    {votes.length} voto{votes.length !== 1 ? 's' : ''}
                  </span>
                </div>
              )}

              {/* Inline meta — compact horizontal row */}
              {(selectedMembers.length > 0 || labels.length > 0 || startDate || dueDate || totalItems > 0) && (
                <div className="mb-5 flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-[#edf0f3] pb-5 dark:border-[#2e3541]">
                  {/* Members */}
                  {selectedMembers.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8590a2] dark:text-[#596773]">{t('kanbanCardDetailModal.meta.membersTitle')}</p>
                      <div className="flex items-center gap-1">
                        {selectedMembers.map((member) => (
                          <button key={member.id} title={`${member.name} — ${t('kanbanCardDetailModal.actions.remove')}`} onClick={() => toggleMemberAssignment(member.id)}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white ring-2 ring-white dark:ring-[#22272b] transition-opacity hover:opacity-75"
                            style={{ background: member.avatarColor || '#579dff' }}>
                            {member.name.slice(0,2).toUpperCase()}
                          </button>
                        ))}
                        <button onClick={() => tp('members')} className="flex h-7 w-7 items-center justify-center rounded-full bg-[#f1f2f4] text-[#44546f] transition-colors hover:bg-[#e0e2e5] dark:bg-[#282e33] dark:text-[#8c9bab]">
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  )}
                  {selectedMembers.length === 0 && boardMembers.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8590a2] dark:text-[#596773]">{t('kanbanCardDetailModal.meta.membersTitle')}</p>
                      <button onClick={() => tp('members')} className="inline-flex items-center gap-1.5 rounded-lg bg-[#f1f2f4] px-2.5 py-1 text-xs font-medium text-[#44546f] transition-colors hover:bg-[#e0e2e5] dark:bg-[#282e33] dark:text-[#8c9bab]">
                        <Plus className="h-3 w-3" /> {t('kanbanCardDetailModal.sidebar.assignMember')}
                      </button>
                    </div>
                  )}

                  {/* Labels */}
                  {labels.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8590a2] dark:text-[#596773]">{t('kanbanCardDetailModal.meta.labelsTitle')}</p>
                      <div className="flex flex-wrap items-center gap-1">
                        {labels.map((lbl,i) => (
                          <span key={i} onClick={() => removeLabel(i)} title={t('kanbanCardDetailModal.actions.remove')}
                            className="inline-flex items-center gap-1 rounded pl-2 pr-1.5 py-0.5 text-xs font-bold text-white cursor-pointer hover:brightness-90 transition-all select-none"
                            style={{ background: lbl.color }}>
                            {lbl.text}<X className="w-2 h-2 opacity-80" />
                          </span>
                        ))}
                        <button onClick={() => tp('labels')} className="flex h-5 w-5 items-center justify-center rounded bg-[#f1f2f4] dark:bg-[#282e33] hover:bg-[#e0e2e5] text-[#44546f] dark:text-[#8c9bab]">
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Start date */}
                  {startDate && startD && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8590a2] dark:text-[#596773]">{t('kanbanCardDetailModal.labels.start')}</p>
                      <button onClick={() => tp('startdate')} className="inline-flex items-center gap-1 rounded-lg bg-[#f1f2f4] px-2.5 py-1 text-xs font-medium text-[#172b4d] dark:bg-[#282e33] dark:text-[#b6c2cf] hover:bg-[#e0e2e5] dark:hover:bg-[#363c42] transition-colors">
                        <Calendar className="w-3 h-3 opacity-70" />
                        {startD.toLocaleDateString(i18n.language,{day:'2-digit',month:'short'})}
                      </button>
                    </div>
                  )}

                  {/* Due date */}
                  {dueDate && due && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8590a2] dark:text-[#596773]">{t('kanbanCardDetailModal.meta.dueDateTitle')}</p>
                      <button onClick={() => tp('duedate')} className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        pct===100 && totalItems>0 ? 'bg-[#1f845a] text-white'
                        : isOverdue ? 'bg-[#ffeceb] text-[#ae2a19] dark:bg-[#5d1f1a] dark:text-[#ffd2cc]'
                        : isToday   ? 'bg-[#fff3cd] text-[#7f5f01] dark:bg-[#4a3200] dark:text-[#f5cd47]'
                        : 'bg-[#f1f2f4] text-[#172b4d] dark:bg-[#282e33] dark:text-[#b6c2cf] hover:bg-[#e0e2e5] dark:hover:bg-[#363c42]'
                      }`}>
                        <Calendar className="w-3 h-3 opacity-80" />
                        {due.toLocaleDateString(i18n.language,{day:'2-digit',month:'short',year:'numeric'})}
                        {isOverdue && <span className="ml-0.5 opacity-80">· {t('kanbanCardDetailModal.labels.overdue')}</span>}
                        {isToday && !isOverdue && <span className="ml-0.5 opacity-80">· {t('kanbanCardDetailModal.labels.today')}</span>}
                      </button>
                    </div>
                  )}

                  {/* Checklist progress */}
                  {totalItems > 0 && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8590a2] dark:text-[#596773]">{t('kanbanCardDetailModal.labels.progress')}</p>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[#e2e6ea] dark:bg-[#2c363f]">
                          <div className={`h-full rounded-full transition-all ${pct===100?'bg-[#1f845a]':'bg-[#579dff]'}`} style={{ width:`${pct}%` }} />
                        </div>
                        <span className={`text-xs font-semibold tabular-nums ${pct===100?'text-[#1f845a]':'text-[#44546f] dark:text-[#8c9bab]'}`}>{doneItems}/{totalItems}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Quick actions */}
              <div className="mb-5 flex flex-wrap gap-2">
                {[
                  { icon: <AlignLeft className="h-3.5 w-3.5" />, label: t('kanbanCardDetailModal.quickActions.editDescription'), action: () => { onEditingStart?.('description'); setEditDesc(true); }, show: true },
                  { icon: <CheckSquare className="h-3.5 w-3.5" />, label: t('kanbanCardDetailModal.quickActions.checklist'), action: () => { const el = document.querySelector('[data-section="checklist"]'); el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, show: checklists.length > 0 },
                  { icon: <Calendar className="h-3.5 w-3.5" />, label: t('kanbanCardDetailModal.quickActions.dates'), action: () => { const el = document.querySelector('[data-section="duedate"]'); el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, show: !!(dueDate || startDate) },
                  { icon: <MessageSquare className="h-3.5 w-3.5" />, label: t('kanbanCardDetailModal.quickActions.comment'), action: () => { activitiesTopRef.current?.scrollIntoView({ behavior: 'smooth' }); }, show: true },
                ].filter(qa => qa.show).map(qa => (
                  <button
                    key={qa.label}
                    onClick={qa.action}
                    className="flex items-center gap-1.5 rounded-lg border border-[#dfe1e6] bg-[#f8f9fb] px-3 py-1.5 text-xs font-medium text-[#44546f] shadow-sm hover:border-[#579dff] hover:bg-[#e9f2ff] hover:text-[#0c66e4] hover:shadow-none transition-all dark:border-[#3b4754] dark:bg-[#282e33] dark:text-[#8c9bab] dark:hover:border-blue-500 dark:hover:bg-[#1c2b41] dark:hover:text-blue-400"
                  >
                    {qa.icon} {qa.label}
                  </button>
                ))}
              </div>

              {/* Description */}
              <section className="mb-5 rounded-[22px] border border-[#e2e6ea] bg-white p-4 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">
                    <AlignLeft className="w-4 h-4 text-[#44546f] dark:text-[#8c9bab]" /> {t('kanbanCardDetailModal.sections.description')}
                  </div>
                  {!editDesc && (
                    <button
                      onClick={() => setDescCollapsed(v => !v)}
                      className="rounded-lg p-1 text-[#8590a2] hover:bg-[#091e4224] hover:text-[#44546f] dark:hover:bg-[#ffffff1f] transition-colors"
                      title={descCollapsed ? t('kanbanCardDetailModal.description.expand') : t('kanbanCardDetailModal.description.minimize')}
                    >
                      {descCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                    </button>
                  )}
                </div>
                {!editDesc && editorsInfo.some(e => e.field === 'description') && (() => {
                  const editor = editorsInfo.find(e => e.field === 'description')!;
                  const member = boardMembers?.find(m => m.id === editor.userId);
                  return (
                    <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                      {t('kanbanCardDetailModal.description.userEditing', { name: member?.name ?? t('kanbanCardDetailModal.defaults.someone') })}
                    </div>
                  );
                })()}
                {!descCollapsed && (editDesc ? (
                  <div>
                    {editDesc && descConflict && (
                      <div className="mb-2 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                        {t('kanbanCardDetailModal.description.conflict')}
                        <button onClick={() => { setDesc(card.description ?? ''); setDescConflict(false); }} className="ml-auto underline hover:no-underline">
                          {t('kanbanCardDetailModal.description.useCurrentVersion')}
                        </button>
                      </div>
                    )}
                    <textarea
                      ref={descRef}
                      autoFocus
                      value={desc}
                      onChange={e => handleDescChange(e.target.value)}
                      onPaste={handlePaste}
                      rows={12}
                      placeholder={t('kanbanCardDetailModal.description.placeholder')}
                      className={`w-full resize-y rounded-2xl border p-3.5 font-mono text-sm text-[#172b4d] outline-none placeholder-[#8590a2] dark:text-[#b6c2cf] ${
                        isDescRecording
                          ? 'border-red-400 bg-[#fff5f5] dark:border-red-600 dark:bg-[#2a1a1a]'
                          : 'border-[#579dff] bg-[#f6f8fb] dark:bg-[#282e33]'
                      }`}
                    />
                    {/* Voice transcript live preview */}
                    {(isDescRecording || descVoiceReady) && descVoiceTranscript && (
                      <div className="mt-1 rounded-lg border border-dashed border-[#d8dee6] bg-slate-50 px-3 py-2 text-xs italic text-[#626f86] dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
                        {descVoiceTranscript}
                      </div>
                    )}
                    {/* Post-recording mini toolbar */}
                    {descVoiceReady && descVoiceTranscript && (
                      <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-[#e2e6ea] bg-[#f8fafc] px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                        <span className="mr-1 text-[10px] text-[#626f86] dark:text-gray-400">🎤 {t('kanbanCardDetailModal.voice.ready')}</span>
                        <button
                          onClick={() => { handleDescChange(desc + (desc ? '\n\n' : '') + descVoiceTranscript); setDescVoiceTranscript(''); setDescVoiceReady(false); }}
                          className="rounded-lg bg-[#091e4224] px-2.5 py-1 text-xs font-medium text-[#172b4d] hover:bg-[#091e423d] dark:bg-[#ffffff1f] dark:text-gray-200 dark:hover:bg-[#ffffff2f]"
                        >
                          {t('kanbanCardDetailModal.voice.insertDirectly')}
                        </button>
                        <button
                          onClick={formatDescWithAI}
                          disabled={formattingDescVoice}
                          className="flex items-center gap-1 rounded-lg bg-[#579dff] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-60"
                        >
                          {formattingDescVoice ? <><Loader2 className="h-3 w-3 animate-spin" /> {t('kanbanCardDetailModal.voice.formatting')}</> : t('kanbanCardDetailModal.voice.formatWithAi')}
                        </button>
                        <button
                          onClick={() => { setDescVoiceTranscript(''); setDescVoiceReady(false); }}
                          className="ml-auto rounded-lg px-2 py-1 text-xs text-[#626f86] hover:bg-[#091e4224] dark:text-gray-400 dark:hover:bg-[#ffffff1f]"
                        >
                          {t('kanbanCardDetailModal.actions.discard')}
                        </button>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <button onClick={saveDesc} className="rounded-xl bg-[#579dff] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#4c8fe8]">{t('kanbanCardDetailModal.actions.save')}</button>
                      <button onClick={() => { setDesc(card.description??''); onEditingStop?.('description'); setEditDesc(false); setDescSaved(false); setDescConflict(false); setDescVoiceTranscript(''); setDescVoiceReady(false); if (isDescRecording) stopDescRecording(); }} className="rounded-xl px-3 py-1.5 text-sm text-[#44546f] hover:bg-[#091e4224] dark:text-[#8c9bab] dark:hover:bg-[#ffffff1f]">{t('kanbanCardDetailModal.actions.cancel')}</button>
                      {descSaved ? (
                        <span className="flex items-center gap-1 text-xs text-[#1f845a]"><Save className="w-3 h-3" /> {t('kanbanCardDetailModal.description.autoSaved')}</span>
                      ) : (
                        <span className="text-xs text-[#8590a2]">{t('kanbanCardDetailModal.description.autoSaveHint')}</span>
                      )}
                      <button
                        onClick={isDescRecording ? stopDescRecording : startDescRecording}
                        title={isDescRecording ? t('kanbanCardDetailModal.voice.stopRecording') : t('kanbanCardDetailModal.voice.dictateDescription')}
                        className={`ml-auto flex items-center justify-center rounded-xl p-1.5 transition-colors ${
                          isDescRecording
                            ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                            : 'text-[#44546f] hover:bg-[#091e4224] dark:text-[#8c9bab] dark:hover:bg-[#ffffff1f]'
                        }`}
                      >
                        {isDescRecording
                          ? <span className="relative flex h-4 w-4 items-center justify-center">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                              <Mic className="relative h-3.5 w-3.5" />
                            </span>
                          : <Mic className="h-3.5 w-3.5" />
                        }
                      </button>
                      <button
                        onClick={formatDescriptionWithAI}
                        disabled={aiFormattingDesc}
                        title="Formatar descrição com IA"
                        className="flex items-center justify-center rounded-xl p-1.5 text-[#44546f] hover:bg-[#091e4224] dark:text-[#8c9bab] dark:hover:bg-[#ffffff1f] transition-colors disabled:opacity-50"
                      >
                        {aiFormattingDesc
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Sparkles className="h-3.5 w-3.5" />
                        }
                      </button>
                    </div>
                  </div>
                ) : desc ? (
                  <div onDoubleClick={() => { onEditingStart?.('description'); setEditDesc(true); }} title="Duplo clique para editar" className="prose prose-sm max-w-none min-h-[88px] cursor-pointer rounded-2xl bg-[#f6f8fb] p-3.5 text-sm transition-colors hover:bg-[#eef2f6] dark:prose-invert dark:bg-[#ffffff0f] dark:hover:bg-[#ffffff1a] [&_img]:mt-2 [&_img]:max-w-full [&_img]:rounded-lg prose-code:before:content-none prose-code:after:content-none">
                    <KanbanMarkdown content={desc} />
                  </div>
                ) : (
                  <div onClick={() => { onEditingStart?.('description'); setEditDesc(true); }} className="min-h-[88px] cursor-pointer rounded-2xl bg-[#f6f8fb] p-3.5 text-sm text-[#8590a2] transition-colors hover:bg-[#eef2f6] dark:bg-[#ffffff0f] dark:hover:bg-[#ffffff1a]">
                    {t('kanbanCardDetailModal.description.empty')}
                  </div>
                ))}
              </section>

              {/* Checklists */}
              {checklists.map((group) => {
                const groupTotal = group.items.length;
                const groupDone  = group.items.filter(i => i.done).length;
                const groupPct   = groupTotal ? Math.round(groupDone / groupTotal * 100) : 0;
                return (
                  <section key={group.id} data-section="checklist" className="mb-5 rounded-[22px] border border-[#e2e6ea] bg-white p-4 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">
                        <CheckSquare className="w-4 h-4 text-[#44546f] dark:text-[#8c9bab]" /> {group.title}
                      </div>
                      <div className="flex items-center gap-2">
                        {groupDone > 0 && (
                          <button onClick={() => hideCompleted(group.id)} className="rounded-xl bg-[#091e420f] px-2.5 py-1 text-xs font-medium text-[#44546f] hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:text-[#8c9bab]">
                            {t('kanbanCardDetailModal.checklist.hideCompleted')}
                          </button>
                        )}
                        <button onClick={() => deleteGroup(group.id)} className="rounded-xl bg-[#091e420f] px-2.5 py-1 text-xs font-medium text-[#44546f] hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.actions.delete')}</button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-xs text-[#626f86] w-7 text-right tabular-nums">{groupPct}%</span>
                      <div className="flex-1 h-2 bg-[#091e4224] dark:bg-[#ffffff1f] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${groupPct===100?'bg-[#1f845a]':'bg-[#579dff]'}`} style={{ width:`${groupPct}%` }} />
                      </div>
                    </div>
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={e => handleChecklistDragEnd(group.id, e)}>
                      <SortableContext items={group.items.map(i => i.id ?? i.text)} strategy={verticalListSortingStrategy}>
                        {group.items.map((item) => {
                          const itemKey = item.id ?? item.text;
                          return (
                            <SortableChecklistItem
                              key={itemKey}
                              id={itemKey}
                              item={item}
                              boardMembers={boardMembers}
                              onToggle={() => toggleItem(group.id, itemKey)}
                              onRemove={() => removeItem(group.id, itemKey)}
                              onConvert={() => void convertItemToCard(group.id, itemKey)}
                              onUpdateMeta={meta => updateItemMeta(group.id, itemKey, meta)}
                            />
                          );
                        })}
                      </SortableContext>
                    </DndContext>
                    <div className="flex gap-2 mt-2 ml-6">
                      <input
                        value={newItemTexts[group.id] ?? ''}
                        onChange={e => setNewItemTexts(prev => ({ ...prev, [group.id]: e.target.value }))}
                        onKeyDown={e => e.key==='Enter' && addItemToGroup(group.id)}
                        placeholder={t('kanbanCardDetailModal.checklist.addItem')}
                        className="flex-1 rounded-xl border border-[#cfd3d8] bg-white px-3 py-2 text-sm text-[#172b4d] outline-none transition-colors placeholder-[#8590a2] focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#282e33] dark:text-[#b6c2cf]"
                      />
                      <button onClick={() => addItemToGroup(group.id)} className="rounded-xl bg-[#579dff] px-3 py-2 text-sm font-medium text-white hover:bg-[#4c8fe8]">{t('kanbanCardDetailModal.actions.add')}</button>
                    </div>
                  </section>
                );
              })}

              {/* Attachments */}
              {attachments.length > 0 && (
                <section className="mb-5 rounded-[22px] border border-[#e2e6ea] bg-white p-4 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">
                      <Paperclip className="w-4 h-4 text-[#44546f] dark:text-[#8c9bab]" /> {t('kanbanCardDetailModal.sections.attachments')}
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => !isUploading && fileRef.current?.click()} className="flex items-center gap-1 rounded-xl bg-[#091e420f] px-2.5 py-1 text-xs font-medium text-[#44546f] hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:text-[#8c9bab]">
                        <Plus className="w-3 h-3" /> {t('kanbanCardDetailModal.actions.add')}
                      </button>
                      <button
                        onClick={async () => {
                          setShowDrivePicker(!showDrivePicker);
                          if (!showDrivePicker && driveFiles.length === 0) {
                            setDriveLoading(true);
                            try {
                              const res = await kanbanService.listDriveFiles(boardId);
                              setDriveFiles(res.files);
                            } catch { /* Drive not configured - ignore */ }
                            setDriveLoading(false);
                          }
                        }}
                        className="flex items-center gap-1 rounded-xl bg-[#091e420f] px-2.5 py-1 text-xs font-medium text-[#44546f] hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:text-[#8c9bab]"
                        title={t('kanbanCardDetailModal.attachments.googleDrive')}
                      >
                        <svg className="w-3 h-3" viewBox="0 0 87.3 78" fill="none"><path d="M6.6 66.85l15-26 15 26z" fill="#0066DA"/><path d="M21.6 40.85L6.6 66.85h30z" fill="#00AC47"/><path d="M51.6 40.85l-15 26h30z" fill="#EA4335"/><path d="M36.6 14.85l15 26-15 26z" fill="#00832D"/><path d="M36.6 14.85l15 26h30z" fill="#2684FC"/><path d="M81.6 40.85l-15 26h-15z" fill="#FFBA00"/></svg>
                        {t('kanbanCardDetailModal.attachments.drive')}
                      </button>
                    </div>
                  </div>
                  {attachments.map((att) => (
                    <div key={att.id} className="flex items-center gap-3 mb-2 group">
                      <div
                        className={`flex h-12 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#091e4224] ${att.isImage ? 'cursor-pointer hover:ring-2 hover:ring-[#579dff]' : ''}`}
                        onClick={() => att.isImage && setPreviewImage(att.url)}
                      >
                        {att.isImage ? <img src={att.url} alt={att.name} className="w-full h-full object-cover" /> : <Paperclip className="w-5 h-5 text-[#44546f]" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[#172b4d] dark:text-[#b6c2cf] truncate">{att.name}</p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[#626f86]">
                          <span>{new Date(att.addedAt).toLocaleString(i18n.language)}</span>
                          {card.coverAttachmentId === att.id && (
                            <span className="inline-flex items-center gap-1 rounded bg-[#091e420f] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#44546f] dark:bg-[#ffffff1f] dark:text-[#8c9bab]">
                              <ImageIcon className="h-3 w-3" /> {t('kanbanCardDetailModal.attachments.cover')}
                            </span>
                          )}
                        </div>
                        <a href={att.url} download={att.name} className="text-xs text-[#579dff] hover:underline">{t('kanbanCardDetailModal.attachments.download')}</a>
                      </div>
                      <div className="flex items-center gap-1">
                        {att.isImage && card.coverAttachmentId !== att.id && (
                          <button onClick={() => setImageAsCover(att)} className="rounded-lg px-2 py-1 text-[11px] font-medium text-[#44546f] hover:bg-[#091e420f] dark:text-[#8c9bab] dark:hover:bg-[#ffffff1f]">{t('kanbanCardDetailModal.attachments.cover')}</button>
                        )}
                        <button onClick={() => removeAttachment(att.id)} className="opacity-0 group-hover:opacity-100 p-1 text-[#626f86] hover:text-red-500">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Google Drive Picker */}
                  {showDrivePicker && (
                    <div className="mt-3 rounded-xl border border-[#dcdfe4] bg-[#f8fafc] p-3 dark:border-gray-600 dark:bg-gray-800">
                      <div className="flex items-center gap-2 mb-2">
                        <svg className="w-4 h-4" viewBox="0 0 87.3 78" fill="none"><path d="M6.6 66.85l15-26 15 26z" fill="#0066DA"/><path d="M21.6 40.85L6.6 66.85h30z" fill="#00AC47"/><path d="M51.6 40.85l-15 26h30z" fill="#EA4335"/><path d="M36.6 14.85l15 26-15 26z" fill="#00832D"/><path d="M36.6 14.85l15 26h30z" fill="#2684FC"/><path d="M81.6 40.85l-15 26h-15z" fill="#FFBA00"/></svg>
                        <span className="text-xs font-semibold text-[#172b4d] dark:text-gray-200">{t('kanbanCardDetailModal.attachments.googleDrive')}</span>
                        {driveFolderStack.length > 0 && (
                          <button
                            onClick={async () => {
                              const newStack = driveFolderStack.slice(0, -1);
                              setDriveFolderStack(newStack);
                              setDriveLoading(true);
                              try {
                                const fId = newStack.length > 0 ? newStack[newStack.length - 1].id : undefined;
                                const res = await kanbanService.listDriveFiles(boardId, fId);
                                setDriveFiles(res.files);
                              } catch { setDriveFiles([]); }
                              setDriveLoading(false);
                            }}
                            className="text-[10px] text-[#579dff] hover:underline"
                          >
                            {t('kanbanCardDetailModal.actions.back')}
                          </button>
                        )}
                        <div className="ml-auto flex gap-1">
                          <input
                            placeholder={t('kanbanCardDetailModal.attachments.search')}
                            value={driveSearch}
                            onChange={e => setDriveSearch(e.target.value)}
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter' && driveSearch.trim()) {
                                setDriveLoading(true);
                                try {
                                  const res = await kanbanService.listDriveFiles(boardId, undefined, driveSearch.trim());
                                  setDriveFiles(res.files);
                                } catch { setDriveFiles([]); }
                                setDriveLoading(false);
                              }
                            }}
                            className="w-28 rounded-md border border-[#dcdfe4] bg-white px-2 py-0.5 text-[10px] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none"
                          />
                        </div>
                      </div>

                      {driveLoading ? (
                        <div className="flex items-center justify-center py-4 text-xs text-[#626f86]">
                          <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> {t('kanbanCardDetailModal.loading')}
                        </div>
                      ) : driveFiles.length === 0 ? (
                        <p className="py-3 text-center text-xs text-[#626f86] dark:text-gray-400">
                          {t('kanbanCardDetailModal.attachments.noDriveFiles')}
                        </p>
                      ) : (
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {driveFiles.map(file => {
                            const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                            return (
                              <div
                                key={file.id}
                                className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[#e9efff] dark:hover:bg-[#1c2b41] cursor-pointer group"
                                onClick={async () => {
                                  if (isFolder) {
                                    setDriveFolderStack(s => [...s, { id: file.id, name: file.name }]);
                                    setDriveLoading(true);
                                    try {
                                      const res = await kanbanService.listDriveFiles(boardId, file.id);
                                      setDriveFiles(res.files);
                                    } catch { setDriveFiles([]); }
                                    setDriveLoading(false);
                                  } else {
                                    try {
                                      await kanbanService.attachDriveFile(card.id, file);
                                      const newAtt = {
                                        id: `gdrive_${file.id}`,
                                        name: `📁 ${file.name}`,
                                        url: file.webViewLink,
                                        isImage: file.mimeType.startsWith('image/'),
                                        addedAt: new Date().toISOString(),
                                      };
                                      setAttachments(a => [...a, newAtt]);
                                      onUpdated({ ...card, attachments: [...attachments, newAtt] });
                                      toast.success(t('kanbanCardDetailModal.toasts.fileAttached', { name: file.name }));
                                    } catch { toast.error(t('kanbanCardDetailModal.toasts.attachFileError')); }
                                  }
                                }}
                              >
                                {isFolder ? (
                                  <svg className="w-4 h-4 text-[#f4b400] flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                                ) : (
                                  <Paperclip className="w-3.5 h-3.5 text-[#626f86] flex-shrink-0" />
                                )}
                                <span className="flex-1 truncate text-xs text-[#172b4d] dark:text-gray-200">
                                  {file.name}
                                </span>
                                {!isFolder && (
                                  <span className="text-[10px] text-[#579dff] opacity-0 group-hover:opacity-100">{t('kanbanCardDetailModal.actions.attach')}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <p className="mt-2 text-[9px] text-[#8590a2] dark:text-gray-500">
                        {driveFolderStack.length > 0 && `📂 ${driveFolderStack.map(f => f.name).join(' / ')}`}
                      </p>
                    </div>
                  )}
                </section>
              )}

              {/* Custom Fields */}
              {customFieldDefs.length > 0 && (
                <section className="mb-4 rounded-[22px] border border-[#e2e6ea] bg-white p-5 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">
                    <LayoutList className="h-4 w-4 text-[#44546f] dark:text-[#8c9bab]" />
                    {t('kanbanCardDetailModal.sections.customFields')}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {customFieldDefs.map(def => (
                      <div key={def.id}>
                        <p className="mb-1 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{def.name}</p>
                        {def.type === 'text' && (
                          <input
                            type="text"
                            value={(customFields[def.id] as string) ?? ''}
                            onChange={e => void saveCustomField(def.id, e.target.value)}
                            placeholder="—"
                            className="w-full rounded-lg border border-[#cfd3d8] bg-[#f6f8fb] px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                          />
                        )}
                        {def.type === 'number' && (
                          <input
                            type="number"
                            value={(customFields[def.id] as number) ?? ''}
                            onChange={e => void saveCustomField(def.id, e.target.valueAsNumber || null)}
                            placeholder="—"
                            className="w-full rounded-lg border border-[#cfd3d8] bg-[#f6f8fb] px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                          />
                        )}
                        {def.type === 'date' && (
                          <input
                            type="date"
                            value={(customFields[def.id] as string)?.slice(0, 10) ?? ''}
                            onChange={e => void saveCustomField(def.id, e.target.value || null)}
                            className="w-full rounded-lg border border-[#cfd3d8] bg-[#f6f8fb] px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                          />
                        )}
                        {def.type === 'checkbox' && (
                          <label className="flex cursor-pointer items-center gap-2 pt-1">
                            <input
                              type="checkbox"
                              checked={!!(customFields[def.id])}
                              onChange={e => void saveCustomField(def.id, e.target.checked)}
                              className="h-4 w-4 accent-[#579dff]"
                            />
                            <span className="text-sm text-[#44546f] dark:text-[#8c9bab]">{def.name}</span>
                          </label>
                        )}
                        {def.type === 'dropdown' && (
                          <select
                            value={(customFields[def.id] as string) ?? ''}
                            onChange={e => void saveCustomField(def.id, e.target.value || null)}
                            className="w-full rounded-lg border border-[#cfd3d8] bg-[#f6f8fb] px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                          >
                            <option value="">{t('kanbanCardDetailModal.sidebar.selectOption')}</option>
                            {def.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                          </select>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Time Logs */}
              <section className="mb-4 rounded-[22px] border border-[#e2e6ea] bg-white p-5 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
                {/* Header */}
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">
                    <Timer className="h-4 w-4 text-[#44546f] dark:text-[#8c9bab]" /> {t('kanbanCardDetailModal.timeLog.title')}
                    {timeLogs.length > 0 && (
                      <span className="ml-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                        {timeLogs.reduce((s, l) => s + l.hours, 0).toFixed(1)}h{card.maxHours != null ? ` / ${card.maxHours}h` : ` ${t('kanbanCardDetailModal.timeLog.total')}`}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setShowTimeLogForm(v => !v)}
                    className="flex items-center gap-1 rounded-xl bg-[#091e420f] px-2.5 py-1 text-xs font-medium text-[#44546f] hover:bg-[#091e4224] dark:bg-[#ffffff1f] dark:text-[#8c9bab]"
                  >
                    <Plus className="w-3 h-3" /> {t('kanbanCardDetailModal.timeLog.registerButton')}
                  </button>
                </div>

                {/* Hour budget progress bar */}
                {card.maxHours != null && card.maxHours > 0 && (() => {
                  const totalLogged = timeLogs.reduce((s, l) => s + l.hours, 0);
                  const pct = Math.min(100, (totalLogged / card.maxHours) * 100);
                  const isOver = totalLogged > card.maxHours;
                  return (
                    <div className="mb-3">
                      <div className="mb-1 flex items-center justify-between text-[11px] text-[#626f86] dark:text-[#8c9bab]">
                        <span>{t('kanbanCardDetailModal.timeLog.consumed', { logged: totalLogged.toFixed(1), max: card.maxHours })}</span>
                        <span className={isOver ? 'font-bold text-red-500' : ''}>
                          {isOver ? t('kanbanCardDetailModal.timeLog.overLimit', { hours: (totalLogged - card.maxHours!).toFixed(1) }) : t('kanbanCardDetailModal.timeLog.remaining', { hours: (card.maxHours! - totalLogged).toFixed(1) })}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#e2e6ea] dark:bg-[#3b4754]">
                        <div
                          className={`h-full rounded-full transition-all ${isOver ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-violet-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })()}

                {/* Log form */}
                {showTimeLogForm && (() => {
                  const h = parseFloat(timeLogHours) || 0;
                  const maxH = card.maxHours;
                  const totalLogged = timeLogs.reduce((s, l) => s + l.hours, 0);
                  const wouldExceed = maxH != null && totalLogged + h > maxH;
                  const isLoading = submittingTimeLog || submittingHourRequest;
                  return (
                    <div className="mb-4 rounded-xl border border-[#d8dee6] bg-[#f8fafc] p-3 dark:border-[#3b4754] dark:bg-[#22272b]">
                      {wouldExceed && (
                        <div className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 dark:bg-amber-900/20 dark:border-amber-800">
                          <span className="mt-0.5 text-amber-500">⚠️</span>
                          <p className="text-[11px] text-amber-700 dark:text-amber-300">
                            {t('kanbanCardDetailModal.timeLog.budgetWarning', { max: maxH })}
                          </p>
                        </div>
                      )}
                      <div className="mb-2 flex flex-wrap gap-2">
                        <div className="flex flex-col gap-1 flex-1 min-w-[80px]">
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-[#44546f] dark:text-[#8c9bab]">
                          {t('kanbanCardDetailModal.timeLog.hoursLabel')} <span className="normal-case font-normal text-[#8590a2]">{t('kanbanCardDetailModal.timeLog.hoursHint')}</span>
                        </label>
                          <input
                            type="number"
                            min="0.25"
                            step="0.25"
                            value={timeLogHours}
                            onChange={e => setTimeLogHours(e.target.value)}
                            className="rounded-lg border border-[#d8dee6] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-violet-400 dark:border-[#3b4754] dark:bg-[#1b2024] dark:text-[#b6c2cf]"
                          />
                        </div>
                        <div className="flex flex-col gap-1 flex-1 min-w-[120px]">
                          <label className="text-[10px] font-semibold uppercase tracking-wider text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.timeLog.dateLabel')}</label>
                          <input
                            type="date"
                            value={timeLogDate}
                            onChange={e => setTimeLogDate(e.target.value)}
                            className="rounded-lg border border-[#d8dee6] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-violet-400 dark:border-[#3b4754] dark:bg-[#1b2024] dark:text-[#b6c2cf]"
                          />
                        </div>
                      </div>
                      <input
                        type="text"
                        value={timeLogDesc}
                        onChange={e => setTimeLogDesc(e.target.value)}
                        placeholder={t('kanbanCardDetailModal.placeholders.timeLogDesc')}
                        className="mb-2 w-full rounded-lg border border-[#d8dee6] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] placeholder-[#8590a2] outline-none focus:border-violet-400 dark:border-[#3b4754] dark:bg-[#1b2024] dark:text-[#b6c2cf]"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={submitTimeLog}
                          disabled={isLoading || !timeLogHours || parseFloat(timeLogHours) <= 0}
                          className={`rounded-xl px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${wouldExceed ? 'bg-amber-500 hover:bg-amber-600' : 'bg-violet-600 hover:bg-violet-700'}`}
                        >
                          {isLoading ? t('kanbanCardDetailModal.timeLog.sendingButton') : wouldExceed ? t('kanbanCardDetailModal.timeLog.requestAuthButton') : t('kanbanCardDetailModal.timeLog.saveButton')}
                        </button>
                        <button
                          onClick={() => setShowTimeLogForm(false)}
                          className="rounded-xl px-3 py-1.5 text-xs text-[#44546f] hover:bg-[#091e4224] dark:text-[#8c9bab]"
                        >
                          {t('kanbanCardDetailModal.timeLog.cancelButton')}
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Pending / resolved hour requests */}
                {hourRequests.filter(r => r.status !== 'cancelled').length > 0 && (
                  <div className="mb-3">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.timeLog.hourRequestsTitle')}</p>
                    <div className="space-y-2">
                      {hourRequests.filter(r => r.status !== 'cancelled').map(req => {
                        const member = boardMembers.find(m => m.id === req.userId);
                        const initials = (req.userName ?? member?.name ?? '?').slice(0, 1).toUpperCase();
                        const avatarColor = member?.avatarColor ?? '#8c9bab';
                        const statusConfig = {
                          pending:  { label: t('kanbanCardDetailModal.timeLog.hourRequests.pending'), cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
                          approved: { label: t('kanbanCardDetailModal.timeLog.hourRequests.approved'), cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
                          rejected: { label: t('kanbanCardDetailModal.timeLog.hourRequests.rejected'), cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
                          cancelled: { label: t('kanbanCardDetailModal.timeLog.hourRequests.cancelled'), cls: '' },
                        }[req.status];
                        return (
                          <div key={req.id} className="flex items-start gap-3 rounded-xl border border-dashed border-[#d8dee6] bg-[#f8fafc] px-3 py-2.5 dark:border-[#3b4754] dark:bg-[#22272b]">
                            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white mt-0.5" style={{ background: avatarColor }}>
                              {initials}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-[#172b4d] dark:text-[#b6c2cf]">{req.userName ?? member?.name ?? t('kanbanCardDetailModal.labels.unknown')}</span>
                                <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[11px] font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{req.hours}h</span>
                                <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${statusConfig?.cls}`}>{statusConfig?.label}</span>
                              </div>
                              {req.description && <p className="mt-0.5 text-xs text-[#44546f] dark:text-[#8c9bab]">{req.description}</p>}
                              {req.reviewNote && <p className="mt-0.5 text-xs italic text-[#626f86] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.labels.note', { text: req.reviewNote })}</p>}
                            </div>
                            {req.status === 'pending' && req.userId === currentUserId && (
                              <button
                                onClick={() => cancelHourRequest(req.id)}
                                className="flex-shrink-0 rounded p-1 text-[#626f86] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                                title={t('kanbanCardDetailModal.timeLog.hourRequests.cancelTitle')}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Log list */}
                {timeLogs.length === 0 && hourRequests.filter(r => r.status !== 'cancelled').length === 0 ? (
                  <p className="text-sm text-[#8590a2] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.timeLog.noLogsYet')}</p>
                ) : timeLogs.length > 0 ? (
                  <div className="space-y-2">
                    {timeLogs.map(log => {
                      const member = boardMembers.find(m => m.id === log.userId);
                      const initials = (log.userName ?? member?.name ?? '?').slice(0, 1).toUpperCase();
                      const avatarColor = member?.avatarColor ?? '#8c9bab';
                      return (
                        <div key={log.id} className="group flex items-center gap-3 rounded-xl bg-[#f6f8fb] px-3 py-2.5 dark:bg-[#ffffff0a]">
                          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: avatarColor }}>
                            {initials}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-semibold text-[#172b4d] dark:text-[#b6c2cf]">{log.userName ?? member?.name ?? t('kanbanCardDetailModal.labels.unknown')}</span>
                              <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[11px] font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{log.hours}h</span>
                              <span className="text-[11px] text-[#626f86] dark:text-[#8c9bab]">{new Date(log.loggedDate + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                            </div>
                            {log.description && (
                              <p className="mt-0.5 text-xs text-[#44546f] dark:text-[#8c9bab]">{log.description}</p>
                            )}
                          </div>
                          <button
                            onClick={() => deleteTimeLog(log.id)}
                            className="hidden group-hover:flex p-1 rounded text-[#626f86] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </section>

              {/* Executions panel */}
              {(executions.length > 0 || activeExecId) && (
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#44546f] dark:text-gray-400">
                      <Bot className="h-4 w-4" />
                      {t('kanbanCardDetailModal.sections.executions')}
                    </div>
                    <button
                      onClick={() => setExecutionsCollapsed(v => !v)}
                      className="rounded p-0.5 text-[#8590a2] hover:bg-[#f1f2f4] dark:text-gray-500 dark:hover:bg-[#2e3541]"
                    >
                      {executionsCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                    </button>
                  </div>

                  {!executionsCollapsed && (
                    <div className="space-y-2">
                      {/* Live log for running execution */}
                      {activeExecId && (
                        <div className="rounded-lg border border-[#dcdfe4] bg-[#0d1117] dark:border-[#2e3541]">
                          <div className="flex items-center justify-between border-b border-[#2e3541] px-3 py-2">
                            <div className="flex items-center gap-2 text-xs font-medium text-gray-300">
                              <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                              {t('kanbanCardDetailModal.github.executing')}
                            </div>
                            <button
                              onClick={() => {
                                void kanbanAgentService.cancelExecution(card.id, activeExecId);
                                setActiveExecId(null);
                              }}
                              className="text-gray-500 hover:text-red-400"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div
                            ref={liveLogRef}
                            className="max-h-48 overflow-y-auto p-3 font-mono text-xs text-gray-300 whitespace-pre-wrap"
                          >
                            {liveLog.map((line, i) => (
                              <div key={i}>{line}</div>
                            ))}
                            {liveLog.length === 0 && (
                              <span className="text-gray-600">{t('kanbanCardDetailModal.github.awaitingOutput')}</span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Past executions list */}
                      {executions.map(exec => (
                        <ExecutionRow key={exec.id} exec={exec} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* C4 – Blocking Dependencies */}
              <section className="mb-6 rounded-[22px] border border-[#e2e6ea] bg-white p-5 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">
                  <Lock className="w-4 h-4 text-[#ae2a19] dark:text-red-400" />
                  {t('kanbanCardDetailModal.sections.blockers')}
                  {blockerCards.length > 0 && (
                    <span className="ml-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-600 dark:bg-red-900/20 dark:text-red-400">
                      {blockerCards.length}
                    </span>
                  )}
                </div>
                {blockerCards.length === 0 && (
                  <p className="mb-2 text-xs text-[#8590a2] dark:text-[#6c7a8c]">{t('kanbanCardDetailModal.blockers.noBlockers')}</p>
                )}
                {blockerCards.map(bc => (
                  <div key={bc.id} className="flex items-center gap-2 mb-2 rounded-xl bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 px-3 py-2">
                    <Lock className="w-3 h-3 text-red-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#172b4d] dark:text-[#b6c2cf] truncate">{bc.title}</p>
                      <p className="text-[10px] text-[#626f86] dark:text-[#8c9bab] truncate">{bc.boardTitle} › {bc.listTitle}</p>
                    </div>
                    <button onClick={() => void removeBlocker(bc.id)} title={t('kanbanCardDetailModal.blockers.removeTitle')} className="p-1 text-[#626f86] hover:text-red-500 flex-shrink-0">
                      <Unlock className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <div className="relative mt-2">
                  <input
                    value={blockerSearch}
                    onChange={e => void searchBlockerCandidates(e.target.value)}
                    placeholder={t('kanbanCardDetailModal.placeholders.searchBlocker')}
                    className="w-full rounded-xl border border-[#cfd3d8] bg-white px-3 py-2 text-sm text-[#172b4d] outline-none placeholder-[#8590a2] focus:border-[#f87168] dark:border-[#3b4754] dark:bg-[#282e33] dark:text-[#b6c2cf]"
                  />
                  {blockerSearchLoading && (
                    <Loader2 className="absolute right-3 top-2.5 w-4 h-4 animate-spin text-[#626f86]" />
                  )}
                  {blockerSearchResults.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-xl border border-[#cfd3d8] bg-white shadow-lg dark:border-[#3b4754] dark:bg-[#282e33]">
                      {blockerSearchResults.map(r => (
                        <button
                          key={r.id}
                          disabled={addingBlocker}
                          onClick={() => void addBlocker(r.id, r.title, r.listTitle, r.boardTitle)}
                          className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-[#f1f2f4] dark:hover:bg-[#3b4754]"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-[#172b4d] dark:text-[#b6c2cf] truncate">{r.title}</p>
                            <p className="text-[10px] text-[#626f86] dark:text-[#8c9bab] truncate">{r.boardTitle} › {r.listTitle}</p>
                          </div>
                          <Plus className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* C3 – Linked Cards */}
              <section className="mb-6 rounded-[22px] border border-[#e2e6ea] bg-white p-5 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">
                  <ArrowRightCircle className="w-4 h-4 text-[#44546f] dark:text-[#8c9bab]" /> {t('kanbanCardDetailModal.sections.linkedCards')}
                </div>
                {linkedCards.map(lc => (
                  <div key={lc.id} className="flex items-center gap-2 mb-2 rounded-xl bg-[#f1f2f4] dark:bg-[#282e33] px-3 py-2">
                    <button
                      className="flex-1 min-w-0 text-left group"
                      onClick={() => onOpenCard?.(lc.id)}
                      title={onOpenCard ? t('kanbanCardDetailModal.linkedCards.openCard') : undefined}
                    >
                      <p className={`text-sm font-medium text-[#172b4d] dark:text-[#b6c2cf] truncate ${onOpenCard ? 'group-hover:text-[#0c66e4] dark:group-hover:text-blue-400 group-hover:underline cursor-pointer' : ''}`}>{lc.title}</p>
                      <p className="text-[10px] text-[#626f86] dark:text-[#8c9bab] truncate">{lc.boardTitle} › {lc.listTitle}</p>
                    </button>
                    <button onClick={() => void unlinkCard(lc.id)} title={t('kanbanCardDetailModal.linkedCards.unlinkTitle')} className="p-1 text-[#626f86] hover:text-red-500 flex-shrink-0">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <div className="relative mt-2">
                  <input
                    value={linkSearch}
                    onChange={e => void searchCardsToLink(e.target.value)}
                    placeholder={t('kanbanCardDetailModal.placeholders.searchCard')}
                    className={`w-full rounded-xl border pr-9 px-3 py-2 text-sm text-[#172b4d] outline-none placeholder-[#8590a2] dark:text-[#b6c2cf] transition-colors ${
                      isLinkRecording
                        ? 'border-red-400 bg-[#fff5f5] dark:border-red-600 dark:bg-[#2a1a1a]'
                        : 'border-[#cfd3d8] bg-white focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#282e33]'
                    }`}
                  />
                  {linkSearchLoading ? (
                    <Loader2 className="absolute right-3 top-2.5 w-4 h-4 animate-spin text-[#626f86]" />
                  ) : (
                    <button
                      onClick={isLinkRecording ? () => { linkRecognitionRef.current?.stop(); setIsLinkRecording(false); } : startLinkRecording}
                      title={isLinkRecording ? t('kanbanCardDetailModal.activity.voiceSearchStop') : t('kanbanCardDetailModal.activity.voiceSearch')}
                      className={`absolute right-2 top-2 flex items-center justify-center rounded-lg p-0.5 transition-colors ${
                        isLinkRecording
                          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                          : 'text-[#8590a2] hover:text-[#579dff]'
                      }`}
                    >
                      {isLinkRecording
                        ? <span className="relative flex h-4 w-4 items-center justify-center">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                            <Mic className="relative h-3.5 w-3.5" />
                          </span>
                        : <Mic className="h-3.5 w-3.5" />
                      }
                    </button>
                  )}
                  {linkSearchResults.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-xl border border-[#cfd3d8] bg-white shadow-lg dark:border-[#3b4754] dark:bg-[#282e33]">
                      {linkSearchResults.map(r => (
                        <button
                          key={r.id}
                          disabled={linkingCard}
                          onClick={() => void linkCard(r.id, r.title, r.listTitle, r.boardTitle)}
                          className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-[#f1f2f4] dark:hover:bg-[#3b4754]"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-[#172b4d] dark:text-[#b6c2cf] truncate">{r.title}</p>
                            <p className="text-[10px] text-[#626f86] dark:text-[#8c9bab] truncate">{r.boardTitle} › {r.listTitle}</p>
                          </div>
                          <Plus className="w-3.5 h-3.5 text-[#579dff] flex-shrink-0 mt-0.5" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Activity */}
              <section className="rounded-[22px] border border-[#e2e6ea] bg-white p-4 shadow-[0_12px_40px_-36px_rgba(15,23,42,0.8)] dark:border-[#3b4754] dark:bg-[#1f2428]">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-[#44546f] dark:text-[#8c9bab]" />
                    <span className="text-sm font-semibold text-[#172b4d] dark:text-[#b6c2cf]">{t('kanbanCardDetailModal.sections.activity')}</span>
                    {activities.filter(a => a.type === 'comment').length > 0 && (
                      <span className="rounded-full bg-[#f1f2f4] px-1.5 py-0.5 text-[10px] font-bold text-[#626f86] dark:bg-[#282e33] dark:text-[#8c9bab]">
                        {activities.filter(a => a.type === 'comment').length}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setShowOnlyComments(p => !p)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${showOnlyComments ? 'bg-[#e9f2ff] text-[#0c66e4] dark:bg-[#1c2b41] dark:text-[#85b8ff]' : 'text-[#626f86] hover:bg-[#f1f2f4] hover:text-[#44546f] dark:text-[#8c9bab] dark:hover:bg-[#282e33]'}`}
                  >
                    {showOnlyComments ? t('kanbanCardDetailModal.activity.showAll') : t('kanbanCardDetailModal.activity.onlyComments')}
                  </button>
                </div>

                {/* Comment composer */}
                {canComment ? (
                <div className="mb-5">
                  <div className="rounded-xl border border-[#d8dee6] bg-[#fbfcfe] transition-all focus-within:border-[#579dff] focus-within:shadow-[0_0_0_2px_rgba(87,157,255,0.15)] dark:border-[#3b4754] dark:bg-[#22272b]">
                    <div className="flex items-start gap-2.5 p-2.5">
                      <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#ffb968] text-xs font-bold text-white shadow-sm">
                        {title.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="flex-1">
                        <textarea
                          value={activityComment}
                          onChange={(e) => setActivityComment(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              void submitComment();
                            }
                          }}
                          onFocus={() => setCommentFocused(true)}
                          onBlur={() => { if (!activityComment.trim()) setCommentFocused(false); }}
                          rows={commentFocused || activityComment.trim() ? 3 : 2}
                          placeholder={t('kanbanCardDetailModal.placeholders.commentInput')}
                          className={`w-full resize-none bg-transparent px-1 pt-0.5 text-sm text-[#172b4d] outline-none placeholder-[#aab0b8] dark:text-[#b6c2cf] dark:placeholder-[#596773] ${
                            isRecording ? 'opacity-80' : ''
                          }`}
                        />
                        {(commentFocused || activityComment.trim()) && (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <button
                              onClick={submitComment}
                              disabled={submittingComment}
                              className="rounded-lg bg-[#579dff] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#4c8fe8] disabled:opacity-60"
                            >
                              {submittingComment ? t('kanbanCardDetailModal.activity.sendingComment') : t('kanbanCardDetailModal.activity.commentButton')}
                            </button>
                            <button
                              onClick={() => { setActivityComment(''); setCommentFocused(false); }}
                              className="rounded-lg px-2.5 py-1.5 text-xs text-[#44546f] hover:bg-[#091e4224] dark:text-[#8c9bab] dark:hover:bg-[#ffffff1f]"
                            >
                              {t('kanbanCardDetailModal.actions.cancel')}
                            </button>
                            <div className="ml-auto flex items-center gap-0.5">
                              <button
                                onClick={() => {
                                  setShowGiphy(!showGiphy);
                                  if (!showGiphy && giphyGifs.length === 0) {
                                    setGiphyLoading(true);
                                    kanbanService.trendingGiphy(boardId)
                                      .then(r => setGiphyGifs(r.gifs))
                                      .catch(() => {})
                                      .finally(() => setGiphyLoading(false));
                                  }
                                }}
                                className="flex items-center rounded-md px-2 py-1 text-[11px] font-semibold text-[#8590a2] hover:bg-[#f1f2f4] hover:text-[#44546f] dark:hover:bg-[#282e33] dark:hover:text-[#8c9bab] transition-colors"
                                title={t('kanbanCardDetailModal.activity.gifTitle')}
                              >
                                GIF
                              </button>
                              <button
                                onClick={isRecording ? stopRecording : startRecording}
                                title={isRecording ? t('kanbanCardDetailModal.activity.stopRecording') : t('kanbanCardDetailModal.activity.recordVoice')}
                                className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${
                                  isRecording
                                    ? 'text-red-500 bg-red-50 dark:bg-red-900/20'
                                    : 'text-[#8590a2] hover:bg-[#f1f2f4] hover:text-[#44546f] dark:hover:bg-[#282e33]'
                                }`}
                              >
                                {isRecording
                                  ? <span className="relative flex h-4 w-4 items-center justify-center">
                                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                                      <Mic className="relative h-3.5 w-3.5" />
                                    </span>
                                  : <Mic className="h-3.5 w-3.5" />
                                }
                              </button>
                              <button
                                onClick={formatCommentWithAI}
                                disabled={aiFormattingComment}
                                title="Formatar comentário com IA"
                                className="flex items-center justify-center rounded-md p-1.5 text-[#8590a2] hover:bg-[#f1f2f4] hover:text-[#44546f] dark:hover:bg-[#282e33] transition-colors disabled:opacity-50"
                              >
                                {aiFormattingComment
                                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  : <Sparkles className="h-3.5 w-3.5" />
                                }
                              </button>
                            </div>
                          </div>
                        )}
                      </div>{/* end flex-1 */}
                    </div>{/* end flex items-start row */}
                    {/* Voice transcript live preview */}
                    {(isRecording || voiceReady) && voiceTranscript && (
                      <div className="mt-1 rounded-lg border border-dashed border-[#d8dee6] bg-slate-50 px-3 py-2 text-xs italic text-[#626f86] dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
                        {voiceTranscript}
                      </div>
                    )}

                    {/* Post-recording mini toolbar */}
                    {voiceReady && voiceTranscript && (
                      <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-[#e2e6ea] bg-[#f8fafc] px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                        <span className="mr-1 text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanCardDetailModal.activity.voiceReady')}</span>
                        <button
                          onClick={() => {
                            setActivityComment(prev => prev + (prev ? '\n' : '') + voiceTranscript);
                            setVoiceTranscript('');
                            setVoiceReady(false);
                          }}
                          className="rounded-lg bg-[#091e4224] px-2.5 py-1 text-xs font-medium text-[#172b4d] hover:bg-[#091e423d] dark:bg-[#ffffff1f] dark:text-gray-200 dark:hover:bg-[#ffffff2f]"
                        >
                          {t('kanbanCardDetailModal.activity.insertDirectly')}
                        </button>
                        <button
                          onClick={formatWithAI}
                          disabled={formattingVoice}
                          className="flex items-center gap-1 rounded-lg bg-[#579dff] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-60"
                        >
                          {formattingVoice ? <><Loader2 className="h-3 w-3 animate-spin" /> {t('kanbanCardDetailModal.activity.formatting')}</> : t('kanbanCardDetailModal.activity.formatWithAi')}
                        </button>
                        <button
                          onClick={() => { setVoiceTranscript(''); setVoiceReady(false); }}
                          className="ml-auto rounded-lg px-2 py-1 text-xs text-[#626f86] hover:bg-[#091e4224] dark:text-gray-400 dark:hover:bg-[#ffffff1f]"
                        >
                          {t('kanbanCardDetailModal.activity.discard')}
                        </button>
                      </div>
                    )}

                    {/* Giphy Picker */}
                    {showGiphy && (
                      <div className="mt-2 rounded-xl border border-[#dcdfe4] bg-[#f8fafc] p-3 dark:border-gray-600 dark:bg-gray-800">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-semibold text-[#172b4d] dark:text-gray-200">GIF</span>
                          <span className="text-[9px] text-[#8590a2]">Powered by GIPHY</span>
                          <button onClick={() => setShowGiphy(false)} className="ml-auto p-0.5 text-[#626f86] hover:text-[#172b4d] dark:hover:text-gray-200">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex gap-1.5 mb-2 min-w-0">
                          <input
                            placeholder={t('kanbanCardDetailModal.placeholders.searchGif')}
                            value={giphySearch}
                            onChange={e => setGiphySearch(e.target.value)}
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter') {
                                setGiphyLoading(true);
                                try {
                                  if (giphySearch.trim()) {
                                    const r = await kanbanService.searchGiphy(boardId, giphySearch.trim());
                                    setGiphyGifs(r.gifs);
                                  } else {
                                    const r = await kanbanService.trendingGiphy(boardId);
                                    setGiphyGifs(r.gifs);
                                  }
                                } catch { /* Giphy não configurado */ }
                                setGiphyLoading(false);
                              }
                            }}
                            className="min-w-0 flex-1 rounded-lg border border-[#dcdfe4] bg-white px-2.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none"
                          />
                        </div>
                        {giphyLoading ? (
                          <div className="flex items-center justify-center py-6 text-xs text-[#626f86]">
                            <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> {t('kanbanCardDetailModal.activity.loadingGifs')}
                          </div>
                        ) : giphyGifs.length === 0 ? (
                          <p className="py-4 text-center text-xs text-[#626f86] dark:text-gray-400">
                            {t('kanbanCardDetailModal.activity.noGifs')}
                          </p>
                        ) : (
                          <div className="grid grid-cols-3 gap-1.5 max-h-52 overflow-y-auto">
                            {giphyGifs.map(gif => (
                              <button
                                key={gif.id}
                                onClick={() => {
                                  setActivityComment(prev => prev + (prev ? '\n' : '') + `![GIF](${gif.originalUrl})`);
                                  setShowGiphy(false);
                                  toast.success(t('kanbanCardDetailModal.toasts.gifInserted'));
                                }}
                                className="relative overflow-hidden rounded-lg bg-[#091e420f] hover:ring-2 hover:ring-[#579dff] transition-all aspect-square"
                                title={gif.title}
                              >
                                <img
                                  src={gif.previewUrl}
                                  alt={gif.title}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                ) : (
                  <div className="mb-4 rounded-xl border border-[#d8dee6] bg-[#fbfcfe] px-4 py-3 text-sm text-[#626f86] dark:border-[#3b4754] dark:bg-[#22272b] dark:text-[#8c9bab]">
                    {t('kanbanCardDetailModal.activity.commentsDisabled')}
                  </div>
                )}

                {/* Activity list */}
                <div ref={activitiesTopRef} />
                {loadingActivities ? (
                  <div className="text-sm text-[#626f86] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.activity.loadingActivity')}</div>
                ) : (
                  <div>
                    {groupedActivities.map(group => (
                      <div key={group.label} className="mb-4">
                        <div className="mb-3 flex items-center gap-2">
                          <div className="h-px flex-1 bg-[#e2e6ea] dark:bg-[#3b4754]" />
                          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#8590a2] dark:text-[#596773]">{group.label}</p>
                          <div className="h-px flex-1 bg-[#e2e6ea] dark:bg-[#3b4754]" />
                        </div>
                        <div className="space-y-2.5">
                          {group.items.map(act => {
                            const { icon, color, bg } = getActivityIcon(act);
                            return (
                              <div key={act.id} className={`group flex items-start gap-3 rounded-2xl border px-3 py-2.5 ${act.type === 'comment' ? 'border-[#e7ecf2] border-l-[#0c66e4] border-l-2 bg-[#f8fafd] dark:border-[#3b4754] dark:bg-[#252b31]' : 'border-transparent bg-transparent hover:border-[#edf1f5] hover:bg-[#f8fafd] dark:hover:border-[#343f4a] dark:hover:bg-[#23292f]'}`}>
                                <div className={`mt-0.5 flex flex-shrink-0 items-center justify-center rounded-full font-bold ring-1 ring-black/5 dark:ring-white/5 ${act.type === 'comment' ? 'h-8 w-8 text-xs' : 'h-6 w-6 text-[10px]'}`} style={{ color, background: bg }}>
                                  {act.type === 'comment' ? (act.userName?.slice(0, 1).toUpperCase() ?? '?') : icon}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
                                    {act.userName && <span className="text-[11px] font-semibold text-[#172b4d] dark:text-[#b6c2cf]">{act.userName}</span>}
                                    <span className="text-[10px] tabular-nums text-[#8590a2] dark:text-[#596773]">
                                      {new Date(act.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    {act.updatedAt && act.updatedAt !== act.createdAt && <span className="rounded-full bg-[#091e420f] px-1.5 py-0.5 text-[10px] text-[#626f86] dark:bg-[#ffffff14] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.labels.edited')}</span>}
                                  </div>
                                  {editingCommentId === act.id ? (
                                    <div className="mt-1">
                                      <textarea
                                        autoFocus
                                        value={editCommentText}
                                        onChange={e => setEditCommentText(e.target.value)}
                                        rows={10}
                                        className="min-h-[220px] w-full resize-y rounded-xl border border-[#579dff] bg-[#fbfcfe] px-3 py-2 text-sm leading-relaxed text-[#172b4d] outline-none dark:bg-[#22272b] dark:text-[#b6c2cf]"
                                      />
                                      <div className="mt-1 flex items-center gap-2">
                                        <button onClick={() => saveEditComment(act.id)} className="rounded-lg bg-[#579dff] px-3 py-1 text-xs font-medium text-white hover:bg-[#4c8fe8]">{t('kanbanCardDetailModal.activity.saveComment')}</button>
                                        <button onClick={() => setEditingCommentId(null)} className="rounded-lg px-3 py-1 text-xs text-[#44546f] hover:bg-[#091e4224] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.actions.cancel')}</button>
                                        <button
                                          onClick={formatEditCommentWithAI}
                                          disabled={aiFormattingComment}
                                          title="Formatar comentário com IA"
                                          className="ml-auto flex items-center justify-center rounded-md p-1.5 text-[#8590a2] hover:bg-[#f1f2f4] hover:text-[#44546f] dark:hover:bg-[#282e33] transition-colors disabled:opacity-50"
                                        >
                                          {aiFormattingComment
                                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            : <Sparkles className="h-3.5 w-3.5" />
                                          }
                                        </button>
                                      </div>
                                    </div>
                                  ) : act.type === 'comment' ? (
                                    <div className="mt-1 text-sm text-[#172b4d] dark:text-[#b6c2cf]">
                                      <KanbanMarkdown content={act.text} />
                                    </div>
                                  ) : (
                                    <p className="mt-1 leading-5 text-xs italic text-[#626f86] dark:text-[#8c9bab]">
                                      {act.text}
                                    </p>
                                  )}
                                  {act.type === 'comment' && editingCommentId !== act.id && (
                                    <div className="mt-2 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                                      <button onClick={() => startEditComment(act)} className="rounded-lg bg-[#091e420f] px-2 py-1 text-[10px] font-medium text-[#0c66e4] hover:bg-[#dbeafe] dark:bg-[#ffffff14] dark:text-[#85b8ff] dark:hover:bg-[#1c2b41]">{t('kanbanCardDetailModal.activity.editComment')}</button>
                                      <button onClick={() => void deleteComment(act.id)} className="rounded-lg bg-red-50 px-2 py-1 text-[10px] font-medium text-red-500 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30">{t('kanbanCardDetailModal.activity.deleteComment')}</button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {activities.length === 0 && (
                      <div className="space-y-3">
                        {[
                          { label: t('kanbanCardDetailModal.activity.cardCreated'), when: card.createdAt },
                          { label: t('kanbanCardDetailModal.activity.lastUpdated'), when: card.updatedAt },
                        ].map((item) => (
                          <div key={item.label} className="flex items-start gap-3 rounded-2xl bg-[#f6f8fb] p-3 dark:bg-[#ffffff0f]">
                            <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white text-[#44546f] shadow-sm dark:bg-[#2b3137] dark:text-[#8c9bab]">
                              <Clock3 className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-600 dark:text-gray-300">{item.label}</p>
                              <p className="text-xs text-[#626f86] dark:text-[#8c9bab]">
                                {new Date(item.when).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>

            {/* ── RIGHT: sidebar ── */}
            <aside className="kanban-scroll w-full md:w-[236px] md:flex-shrink-0 border-t md:border-t-0 md:border-l border-[#e2e6ea] bg-[#f8fafc] px-4 pb-4 pt-12 md:pt-16 dark:border-[#3b4754] dark:bg-[#1b2024] md:overflow-y-auto md:max-h-[calc(100vh-80px)] md:sticky md:top-0 md:self-start">
              <div>

              {/* ── Time Tracking Metric Card ── */}
              {(() => {
                const totalHours = timeLogs.reduce((s, l) => s + l.hours, 0);
                return (
                  <div className="mb-3 rounded-xl border border-[#e2e6ea] bg-white dark:border-[#3b4754] dark:bg-[#22272b]">
                    {/* Header */}
                    <div className="flex flex-wrap items-center gap-1.5 border-b border-[#e2e6ea] px-3 py-2 dark:border-[#3b4754]">
                      <Timer className="h-3.5 w-3.5 text-[#44546f] dark:text-[#8c9bab]" />
                      <span className="min-w-0 flex-1 text-xs font-semibold leading-tight text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.timeLog.title')}</span>
                      <button
                        onClick={() => setTimeDisplayMode(m => m === 'formatted' ? 'decimal' : 'formatted')}
                        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[#626f86] hover:bg-[#091e4214] dark:text-[#8c9bab] dark:hover:bg-[#ffffff14] transition-colors"
                        title={t('kanbanCardDetailModal.timeLog.toggleFormatTitle')}
                      >
                        {timeDisplayMode === 'formatted' ? t('kanbanCardDetailModal.timeLog.formatDecimal') : t('kanbanCardDetailModal.timeLog.formatFormatted')}
                      </button>
                    </div>
                    {/* Value */}
                    <div className="px-3 py-2.5">
                      {totalHours === 0 ? (
                        <p className="text-sm text-[#8590a2] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.timeLog.noHoursRegistered')}</p>
                      ) : (
                        <div className="flex items-baseline gap-2">
                          <span className="text-xl font-bold tabular-nums text-[#172b4d] dark:text-[#b6c2cf]">
                            {timeDisplayMode === 'formatted'
                              ? formatTotalTime(totalHours)
                              : `${totalHours % 1 === 0 ? totalHours : totalHours.toFixed(1)}h`}
                          </span>
                          <span className="text-[11px] text-[#8590a2] dark:text-[#8c9bab]">
                            {t('kanbanCardDetailModal.timeLog.registros_one', { count: timeLogs.length })}
                          </span>
                        </div>
                      )}
                    </div>
                    {/* Action */}
                    <button
                      onClick={() => setShowTimeLogForm(v => !v)}
                      className="flex w-full items-center gap-2 rounded-b-xl border-t border-[#e2e6ea] px-3 py-2 text-sm font-medium text-[#44546f] transition-colors hover:bg-[#eef2f6] hover:text-[#172b4d] dark:border-[#3b4754] dark:text-[#8c9bab] dark:hover:bg-[#2b3137] dark:hover:text-[#b6c2cf]"
                    >
                      <Plus className="h-3.5 w-3.5" /> {t('kanbanCardDetailModal.timeLog.registerHoursButton')}
                    </button>
                  </div>
                );
              })()}

              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sections.addToCard')}</p>
              <div className="space-y-1.5">

                {/* Execute Agent button */}
                <button
                  onClick={() => agentStatus?.connected ? setShowExecuteModal(true) : undefined}
                  disabled={!agentStatus?.connected}
                  title={agentStatus?.connected ? t('kanbanCardDetailModal.sidebar.executeAgent') : t('kanbanCardDetailModal.sidebar.agentNotConnected')}
                  className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                    agentStatus?.connected
                      ? 'border-[#e2e6ea] bg-white text-[#44546f] hover:bg-[#eef2f6] hover:text-[#172b4d] dark:border-[#3b4754] dark:bg-[#22272b] dark:text-[#8c9bab] dark:hover:bg-[#2b3137] dark:hover:text-[#b6c2cf]'
                      : 'cursor-not-allowed border-[#e2e6ea] bg-white text-[#a0aabb] dark:border-[#3b4754] dark:bg-[#22272b] dark:text-[#4a5568]'
                  }`}
                >
                  <div className="relative">
                    <Bot className="h-4 w-4" />
                    <span className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-white dark:border-[#22272b] ${
                      agentStatus?.connected ? 'bg-green-500' : 'bg-gray-400'
                    }`} />
                  </div>
                  {t('kanbanCardDetailModal.sidebar.executeAgent')}
                </button>

                <PanelWrap>
                  <Btn icon={<Users className="w-4 h-4"/>} label={t('kanbanCardDetailModal.sidebar.members')} active={panel==='members'} onClick={()=>tp('members')} />
                  {panel==='members' && (
                    <Pop title={t('kanbanCardDetailModal.sidebar.members')} onClose={()=>setPanel(null)}>
                      {boardMembers.length === 0 ? (
                        <p className="rounded-xl bg-[#f6f8fb] px-3 py-4 text-sm text-[#626f86] dark:bg-[#1d2125] dark:text-[#8c9bab]">
                          {t('kanbanCardDetailModal.sidebar.noMembers')}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <input
                            value={memberSearch}
                            onChange={e => setMemberSearch(e.target.value)}
                            placeholder={t('kanbanCardDetailModal.placeholders.searchMember')}
                            className="mb-2 w-full rounded-xl border border-[#cfd3d8] bg-white px-3 py-2 text-sm text-[#172b4d] outline-none placeholder-[#8590a2] focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#282e33] dark:text-[#b6c2cf]"
                            autoFocus
                          />
                          {boardMembers
                            .filter(m => !memberSearch || m.name.toLowerCase().includes(memberSearch.toLowerCase()))
                            .map((member) => {
                            const isAssigned = (card.memberIds || []).includes(member.id);
                            return (
                              <button
                                key={member.id}
                                onClick={() => toggleMemberAssignment(member.id)}
                                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
                                  isAssigned
                                    ? 'border-[#579dff] bg-[#e9efff] text-[#0c66e4] dark:border-[#579dff] dark:bg-[#1c2b41] dark:text-[#85b8ff]'
                                    : 'border-[#e2e6ea] bg-white text-[#172b4d] hover:bg-[#f6f8fb] dark:border-[#3b4754] dark:bg-[#22272b] dark:text-[#b6c2cf] dark:hover:bg-[#2b3137]'
                                }`}
                              >
                                <span className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: member.avatarColor || '#579dff' }}>
                                  {member.name.slice(0, 2).toUpperCase()}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium">{member.name}</span>
                                </span>
                                {isAssigned ? <Check className="h-4 w-4 flex-shrink-0" /> : null}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </Pop>
                  )}
                </PanelWrap>

                <PanelWrap>
                  <Btn icon={<Tag className="w-4 h-4"/>} label={t('kanbanCardDetailModal.sidebar.labels')} active={panel==='labels'} onClick={()=>tp('labels')} />
                  {panel==='labels' && (
                    <Pop title={t('kanbanCardDetailModal.sidebar.labels')} onClose={()=>setPanel(null)}>
                      <div className="grid grid-cols-5 gap-1 mb-3">
                        {LABEL_PRESETS.map(lp => {
                          const on = labels.some(l=>l.color===lp.color);
                          return <button key={lp.color} onClick={()=>toggleLabel(lp)} title={lp.name} className="h-7 rounded relative hover:scale-105 transition-all" style={{background:lp.color}}>{on&&<Check className="w-3 h-3 text-white absolute inset-0 m-auto drop-shadow"/>}</button>;
                        })}
                      </div>
                      <p className="text-[11px] font-semibold text-[#44546f] uppercase mb-1.5">{t('kanbanCardDetailModal.sidebar.customLabel')}</p>
                      <div className="flex gap-1 items-center">
                        <div className="w-8 h-8 rounded cursor-pointer flex-shrink-0 hover:scale-105 transition-all border-2 border-white dark:border-[#282e33]" style={{background:lblColor}} onClick={()=>{ const i=LABEL_PRESETS.findIndex(p=>p.color===lblColor); setLblColor(LABEL_PRESETS[(i+1)%LABEL_PRESETS.length].color); }} />
                        <input value={lblText} onChange={e=>setLblText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addCustomLabel()} placeholder={t('kanbanCardDetailModal.placeholders.labelName')} className="flex-1 min-w-0 text-sm px-2 py-1.5 bg-[#f1f2f4] dark:bg-[#1d2125] border border-[#cfd3d8] dark:border-[#3b4754] rounded outline-none text-[#172b4d] dark:text-[#b6c2cf] placeholder-[#8590a2]" />
                        <button onClick={addCustomLabel} className="px-2 py-1.5 bg-[#579dff] hover:bg-[#4c8fe8] text-white rounded flex-shrink-0"><Plus className="w-3.5 h-3.5"/></button>
                      </div>
                    </Pop>
                  )}
                </PanelWrap>

                <PanelWrap>
                  <Btn icon={<CheckSquare className="w-4 h-4"/>} label={t('kanbanCardDetailModal.sidebar.checklist')} active={panel==='checklist'} onClick={()=>tp('checklist')} />
                  {panel==='checklist' && (
                    <Pop title={t('kanbanCardDetailModal.sidebar.addChecklist')} onClose={()=>setPanel(null)}>
                      <p className="text-xs text-[#44546f] mb-1">{t('kanbanCardDetailModal.sidebar.checklistTitleLabel')}</p>
                      <input autoFocus value={newGroupTitle} onChange={e=>setNewGroupTitle(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addChecklistGroup()} className="w-full text-sm px-3 py-1.5 bg-[#f1f2f4] dark:bg-[#1d2125] border border-[#579dff] rounded-lg outline-none text-[#172b4d] dark:text-[#b6c2cf] mb-3" />
                      <button onClick={addChecklistGroup} className="w-full py-2 bg-[#579dff] hover:bg-[#4c8fe8] text-white rounded-lg text-sm font-medium">{t('kanbanCardDetailModal.sidebar.addChecklistButton')}</button>
                    </Pop>
                  )}
                </PanelWrap>

                <div data-section="duedate"><PanelWrap>
                  <Btn icon={<Calendar className="w-4 h-4"/>} label={t('kanbanCardDetailModal.sidebar.dates')} active={panel==='duedate'||panel==='startdate'} onClick={()=>tp('duedate')} />
                  {(panel==='duedate'||panel==='startdate') && (
                    <Pop title={t('kanbanCardDetailModal.sidebar.dates')} onClose={()=>setPanel(null)}>
                      <p className="mb-1 text-[11px] text-[#44546f] font-medium">{t('kanbanCardDetailModal.sidebar.startDate')}</p>
                      <input type="date" value={startDate} onChange={e=>saveStartDate(e.target.value)} className="mb-3 w-full text-sm px-3 py-2 bg-[#f1f2f4] dark:bg-[#1d2125] border border-[#cfd3d8] dark:border-[#3b4754] focus:border-[#579dff] rounded-lg outline-none text-[#172b4d] dark:text-[#b6c2cf]" />
                      <p className="mb-1 text-[11px] text-[#44546f] font-medium">{t('kanbanCardDetailModal.sidebar.dueDate')}</p>
                      <input type="date" value={dueDate} onChange={e=>saveDue(e.target.value)} className="w-full text-sm px-3 py-2 bg-[#f1f2f4] dark:bg-[#1d2125] border border-[#cfd3d8] dark:border-[#3b4754] focus:border-[#579dff] rounded-lg outline-none text-[#172b4d] dark:text-[#b6c2cf] mb-2" />
                      {(dueDate || startDate) && (
                        <button onClick={()=>{ saveStartDate(''); saveDue(''); }} className="w-full py-1.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg">{t('kanbanCardDetailModal.sidebar.removeDates')}</button>
                      )}
                      <hr className="my-3 border-[#e2e6ea] dark:border-[#3b4754]" />
                      <p className="mb-1 text-[11px] text-[#44546f] font-medium flex items-center gap-1">
                        <Timer className="w-3 h-3" /> {t('kanbanCardDetailModal.sidebar.hoursBudget')}
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0.5"
                          step="0.5"
                          placeholder={t('kanbanCardDetailModal.placeholders.hoursBudget')}
                          value={maxHours}
                          onChange={e => setMaxHours(e.target.value)}
                          className="flex-1 text-sm px-3 py-1.5 bg-[#f1f2f4] dark:bg-[#1d2125] border border-[#cfd3d8] dark:border-[#3b4754] focus:border-[#579dff] rounded-lg outline-none text-[#172b4d] dark:text-[#b6c2cf]"
                        />
                        <button
                          onClick={saveMaxHours}
                          disabled={savingMaxHours}
                          className="rounded-lg bg-[#579dff] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#388bff] disabled:opacity-50"
                        >
                          {savingMaxHours ? '...' : t('kanbanCardDetailModal.timeLog.saveButton')}
                        </button>
                      </div>
                      <p className="mt-1.5 text-[10px] text-[#8590a2] dark:text-[#8c9bab]">
                        {t('kanbanCardDetailModal.timeLog.minuteHint')}
                      </p>
                      {maxHours && (
                        <p className="mt-1 text-[11px] text-[#44546f] dark:text-[#8c9bab]">
                          {t('kanbanCardDetailModal.timeLog.budgetExceedHint')}
                        </p>
                      )}
                    </Pop>
                  )}
                </PanelWrap></div>

                <PanelWrap>
                  <Btn icon={<Palette className="w-4 h-4"/>} label={t('kanbanCardDetailModal.sidebar.cover')} active={panel==='cover'} onClick={()=>tp('cover')} />
                  {panel==='cover' && (
                    <Pop title={t('kanbanCardDetailModal.sidebar.cover')} onClose={()=>setPanel(null)}>
                      <div className="grid grid-cols-4 gap-1.5 mb-2">
                        {COVER_COLORS.map(c=>(
                          <button key={c} onClick={()=>saveCover(c)} className="h-9 rounded-md hover:scale-105 transition-all relative" style={{background:c,outline:cover===c?'3px solid #579dff':'none',outlineOffset:'2px'}}>
                            {cover===c&&<Check className="w-3.5 h-3.5 text-white absolute inset-0 m-auto drop-shadow"/>}
                          </button>
                        ))}
                      </div>
                      {attachments.filter((a) => a.isImage).length > 0 && (
                        <div className="mb-3">
                          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sidebar.uploadedImages')}</p>
                          <div className="grid grid-cols-3 gap-1.5">
                            {attachments.filter((a) => a.isImage).map((att) => (
                              <button key={att.id} onClick={() => setImageAsCover(att)} className="relative h-16 overflow-hidden rounded-lg border border-[#d8dee6] dark:border-[#3b4754]">
                                <img src={att.url} alt={att.name} className="h-full w-full object-cover" />
                                {card.coverAttachmentId === att.id && (
                                  <span className="absolute inset-x-1 bottom-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-medium text-white">{t('kanbanCardDetailModal.sidebar.inUse')}</span>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {hasCover && <button onClick={removeCover} className="w-full py-1.5 text-sm text-[#44546f] bg-[#f1f2f4] dark:bg-[#1d2125] hover:bg-[#e0e2e5] rounded-lg">{t('kanbanCardDetailModal.sidebar.removeCover')}</button>}
                    </Pop>
                  )}
                </PanelWrap>

                {customFieldDefs.length > 0 && (
                  <PanelWrap>
                    <Btn icon={<Tag className="w-4 h-4"/>} label={t('kanbanCardDetailModal.sidebar.fields')} active={panel==='customfields'} onClick={()=>tp('customfields')} />
                    {panel==='customfields' && (
                      <Pop title={t('kanbanCardDetailModal.sections.customFields')} onClose={()=>setPanel(null)}>
                        <div className="space-y-3">
                          {customFieldDefs.map(def => (
                            <div key={def.id}>
                              <p className="mb-1 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{def.name}</p>
                              {def.type === 'text' && (
                                <input
                                  type="text"
                                  value={(customFields[def.id] as string) ?? ''}
                                  onChange={e => void saveCustomField(def.id, e.target.value)}
                                  className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                                />
                              )}
                              {def.type === 'number' && (
                                <input
                                  type="number"
                                  value={(customFields[def.id] as number) ?? ''}
                                  onChange={e => void saveCustomField(def.id, e.target.valueAsNumber || null)}
                                  className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                                />
                              )}
                              {def.type === 'date' && (
                                <input
                                  type="date"
                                  value={(customFields[def.id] as string)?.slice(0,10) ?? ''}
                                  onChange={e => void saveCustomField(def.id, e.target.value || null)}
                                  className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                                />
                              )}
                              {def.type === 'checkbox' && (
                                <label className="flex cursor-pointer items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={!!(customFields[def.id])}
                                    onChange={e => void saveCustomField(def.id, e.target.checked)}
                                    className="h-4 w-4 accent-[#579dff]"
                                  />
                                  <span className="text-sm text-[#44546f] dark:text-[#8c9bab]">{def.name}</span>
                                </label>
                              )}
                              {def.type === 'dropdown' && (
                                <select
                                  value={(customFields[def.id] as string) ?? ''}
                                  onChange={e => void saveCustomField(def.id, e.target.value || null)}
                                  className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                                >
                                  <option value="">{t('kanbanCardDetailModal.sidebar.selectOption')}</option>
                                  {def.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                </select>
                              )}
                            </div>
                          ))}
                        </div>
                      </Pop>
                    )}
                  </PanelWrap>
                )}

                <PanelWrap>
                  <Btn icon={<span className="text-base leading-none">🎉</span>} label={t('kanbanCardDetailModal.sidebar.stickers')} active={panel==='stickers'} onClick={()=>tp('stickers')} />
                  {panel==='stickers' && (
                    <Pop title={t('kanbanCardDetailModal.sidebar.stickers')} onClose={()=>setPanel(null)} width={376}>
                      {/* scrollbar-color is inherited through the emoji-mart shadow DOM
                          boundary, which its own stylesheet leaves default (ugly black on
                          webkit). Set explicit thumb/track here so the picker scrollbar
                          matches the rest of the app in both light and dark mode. */}
                      <div style={{
                        scrollbarColor: document.documentElement.classList.contains('dark')
                          ? '#4b5563 #282e33'
                          : '#d1d5db #ffffff',
                        scrollbarWidth: 'thin',
                      }}>
                        <Picker
                          data={emojiData}
                          locale="pt"
                          theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
                          onEmojiSelect={(em: { native: string }) => void toggleSticker(em.native)}
                          previewPosition="none"
                          skinTonePosition="none"
                        />
                      </div>
                      {stickers.length > 0 && (
                        <button onClick={() => { setStickers([]); void kanbanService.updateCard(card.id, { stickers: [] }); }}
                          className="mt-2 w-full rounded-lg bg-[#f1f2f4] py-1.5 text-sm text-[#44546f] hover:bg-[#e0e2e5] dark:bg-[#1d2125] dark:text-[#8c9bab]"
                        >
                          {t('kanbanCardDetailModal.sidebar.removeAllStickers', { count: stickers.length })}
                        </button>
                      )}
                    </Pop>
                  )}
                </PanelWrap>

                <PanelWrap>
                  <Btn icon={<Clock3 className="w-4 h-4"/>} label={t('kanbanCardDetailModal.sidebar.recurrence')} active={panel==='recurrence'} onClick={()=>tp('recurrence')} />
                  {panel==='recurrence' && (
                    <Pop title={t('kanbanCardDetailModal.sidebar.recurrence')} onClose={()=>setPanel(null)}>
                      <div className="space-y-3">
                        <div>
                          <p className="mb-1.5 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sidebar.recurrenceFrequency')}</p>
                          <div className="flex flex-wrap gap-1.5">
                            {[
                              { value: null, label: t('kanbanCardDetailModal.sidebar.recurrenceNone') },
                              { value: 'daily', label: t('kanbanCardDetailModal.sidebar.recurrenceDaily') },
                              { value: 'weekly', label: t('kanbanCardDetailModal.sidebar.recurrenceWeekly') },
                              { value: 'monthly', label: t('kanbanCardDetailModal.sidebar.recurrenceMonthly') },
                            ].map(opt => (
                              <button
                                key={opt.label}
                                onClick={() => void saveRecurrence(opt.value ? { frequency: opt.value as KanbanRecurrence['frequency'] } : null)}
                                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                  (recurrence?.frequency ?? null) === opt.value
                                    ? 'bg-[#0c66e4] text-white'
                                    : 'bg-[#f1f2f4] text-[#44546f] hover:bg-[#e0e2e5] dark:bg-[#2c333a] dark:text-[#8c9bab]'
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        {recurrence?.frequency === 'weekly' && (
                          <div>
                            <p className="mb-1.5 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sidebar.dayOfWeek')}</p>
                            <div className="flex gap-1">
                              {['D','S','T','Q','Q','S','S'].map((d, i) => (
                                <button key={i} onClick={() => void saveRecurrence({ ...recurrence, dayOfWeek: i })}
                                  className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold ${recurrence.dayOfWeek === i ? 'bg-[#0c66e4] text-white' : 'bg-[#f1f2f4] text-[#44546f] hover:bg-[#e0e2e5] dark:bg-[#2c333a] dark:text-[#8c9bab]'}`}
                                >
                                  {d}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {recurrence?.frequency === 'monthly' && (
                          <div>
                            <p className="mb-1.5 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sidebar.dayOfMonth')}</p>
                            <input
                              type="number" min={1} max={31}
                              value={recurrence.dayOfMonth ?? 1}
                              onChange={e => void saveRecurrence({ ...recurrence, dayOfMonth: parseInt(e.target.value) || 1 })}
                              className="w-20 rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                            />
                          </div>
                        )}
                        {recurrence && (
                          <p className="text-[10px] text-[#8590a2] dark:text-[#6c7a89]">
                            {t('kanbanCardDetailModal.sidebar.recurrenceAutoCreate')}
                          </p>
                        )}
                      </div>
                    </Pop>
                  )}
                </PanelWrap>

                <Btn icon={<Paperclip className="w-4 h-4"/>} label={isUploading ? t('kanbanCardDetailModal.sidebar.fileUploading') : t('kanbanCardDetailModal.sidebar.file')} onClick={()=>!isUploading && fileRef.current?.click()} />
                <input ref={fileRef} type="file" multiple className="hidden" onChange={handleFileChange} />

                <PanelWrap>
                  <Btn icon={<MapPin className="w-4 h-4"/>} label={t('kanbanCardDetailModal.sidebar.location')} active={panel==='location'} onClick={()=>tp('location')} />
                  {panel==='location' && (
                    <Pop title={t('kanbanCardDetailModal.sidebar.location')} onClose={()=>setPanel(null)}>
                      <div className="space-y-2">
                        {/* Botão de localização real */}
                        <button
                          onClick={() => {
                            if (!navigator.geolocation) { toast.error(t('kanbanCardDetailModal.toasts.geolocationDenied')); return; }
                            const toastId = toast.loading(t('kanbanCardDetailModal.toasts.gettingLocation'));
                            navigator.geolocation.getCurrentPosition(
                              async (pos) => {
                                const { latitude, longitude } = pos.coords;
                                setLocationLat(String(latitude));
                                setLocationLng(String(longitude));
                                toast.dismiss(toastId);
                                // Reverse geocoding via Nominatim (gratuito, sem API key)
                                try {
                                  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
                                  const data = await r.json();
                                  const addr = data.display_name ?? '';
                                  if (addr) setLocationAddress(addr.split(',').slice(0, 3).join(', '));
                                  toast.success(t('kanbanCardDetailModal.toasts.locationObtained'));
                                } catch {
                                  toast.success(t('kanbanCardDetailModal.toasts.coordsObtained'));
                                }
                              },
                              (err) => {
                                toast.dismiss(toastId);
                                if (err.code === 1) toast.error(t('kanbanCardDetailModal.toasts.geolocationDenied'));
                                else toast.error(t('kanbanCardDetailModal.toasts.geolocationError'));
                              },
                              { enableHighAccuracy: true, timeout: 10000 }
                            );
                          }}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#cfd3d8] bg-white py-2 text-sm font-medium text-[#44546f] transition-colors hover:border-[#579dff] hover:text-[#0c66e4] dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#8c9bab] dark:hover:border-[#579dff] dark:hover:text-[#579dff]"
                        >
                          <MapPin className="h-3.5 w-3.5" />
                          {t('kanbanCardDetailModal.sidebar.useCurrentLocation')}
                        </button>
                        <div className="flex items-center gap-2 text-[10px] text-[#8590a2]">
                          <div className="flex-1 h-px bg-[#e2e6ea] dark:bg-[#3b4754]" />
                          {t('kanbanCardDetailModal.sidebar.orManually')}
                          <div className="flex-1 h-px bg-[#e2e6ea] dark:bg-[#3b4754]" />
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sidebar.latitudeLabel')}</p>
                          <input type="number" step="any" value={locationLat} onChange={e => setLocationLat(e.target.value)}
                            placeholder={t('kanbanCardDetailModal.placeholders.latitude')}
                            className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                          />
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sidebar.longitudeLabel')}</p>
                          <input type="number" step="any" value={locationLng} onChange={e => setLocationLng(e.target.value)}
                            placeholder={t('kanbanCardDetailModal.placeholders.longitude')}
                            className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                          />
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sidebar.addressLabel')}</p>
                          <input type="text" value={locationAddress} onChange={e => setLocationAddress(e.target.value)}
                            placeholder={t('kanbanCardDetailModal.placeholders.address')}
                            className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf]"
                          />
                        </div>
                        <button onClick={saveLocation} className="w-full rounded-lg bg-[#579dff] py-2 text-sm font-medium text-white hover:bg-[#4c8fe8]">
                          {t('kanbanCardDetailModal.sidebar.saveLocation')}
                        </button>
                        {card.location && (
                          <button onClick={() => { setLocationLat(''); setLocationLng(''); setLocationAddress(''); save({ location: null }); setPanel(null); }}
                            className="w-full rounded-lg py-1.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            {t('kanbanCardDetailModal.sidebar.removeLocation')}
                          </button>
                        )}
                      </div>
                    </Pop>
                  )}
                </PanelWrap>
              </div>

              {/* Votes — abaixo de Localização */}
              <button
                onClick={handleVote}
                className={`mt-2.5 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors border ${
                  votes.includes(currentUserId ?? '')
                    ? 'border-[#579dff] bg-[#e9efff] text-[#0c66e4] dark:border-[#579dff] dark:bg-[#1c2b41] dark:text-[#85b8ff]'
                    : 'border-[#e2e6ea] bg-white text-[#44546f] hover:bg-[#eef2f6] dark:border-[#3b4754] dark:bg-[#22272b] dark:text-[#8c9bab]'
                }`}
              >
                <ThumbsUp className="w-4 h-4" />
                {t('kanbanCardDetailModal.sidebar.vote', { count: votes.length })}
              </button>

              {/* Summary — colapsável */}
              <div className="mt-2.5 rounded-2xl border border-[#e2e6ea] bg-white dark:border-[#3b4754] dark:bg-[#22272b] overflow-hidden">
                <button
                  onClick={() => setSummaryOpen(o => !o)}
                  className="flex w-full items-center justify-between px-3 py-2.5 hover:bg-[#f6f8fb] dark:hover:bg-[#ffffff08] transition-colors"
                >
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sections.summary')}</p>
                  <svg className={`w-3.5 h-3.5 text-[#44546f] dark:text-[#8c9bab] transition-transform ${summaryOpen ? '' : 'rotate-180'}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7"/></svg>
                </button>
                {summaryOpen && (
                  <div className="space-y-1.5 px-3 pt-3 pb-3 text-sm text-[#44546f] dark:text-[#8c9bab]">
                    <div className="flex items-center justify-between rounded-xl bg-[#f6f8fb] px-3 py-2 dark:bg-[#ffffff0f]">
                      <span>{t('kanbanCardDetailModal.sidebar.members')}</span><strong>{selectedMembers.length}</strong>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-[#f6f8fb] px-3 py-2 dark:bg-[#ffffff0f]">
                      <span>{t('kanbanCardDetailModal.sidebar.labels')}</span><strong>{labels.length}</strong>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-[#f6f8fb] px-3 py-2 dark:bg-[#ffffff0f]">
                      <span>{t('kanbanCardDetailModal.sidebar.checklist')}</span><strong>{doneItems}/{totalItems}</strong>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-[#f6f8fb] px-3 py-2 dark:bg-[#ffffff0f]">
                      <span>{t('kanbanCardDetailModal.sections.attachments')}</span><strong>{attachments.length}</strong>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-[#f6f8fb] px-3 py-2 dark:bg-[#ffffff0f]">
                      <span>{t('kanbanCardDetailModal.activity.commentButton')}</span><strong>{activities.filter(a => a.type === 'comment').length}</strong>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-2.5 rounded-2xl border border-[#e2e6ea] bg-white dark:border-[#3b4754] dark:bg-[#22272b] overflow-hidden">
                <button
                  onClick={() => setActionsOpen(o => !o)}
                  className="flex w-full items-center justify-between px-3 py-2.5 hover:bg-[#f6f8fb] dark:hover:bg-[#ffffff08] transition-colors"
                >
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sections.actionsSection')}</p>
                  <svg className={`w-3.5 h-3.5 text-[#44546f] dark:text-[#8c9bab] transition-transform ${actionsOpen ? '' : 'rotate-180'}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7"/></svg>
                </button>
                {actionsOpen && (
              <div className="space-y-2 px-3 pt-3 pb-3">
                <button onClick={handleToggleWatch}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors border ${
                    isWatching
                      ? 'border-[#579dff] bg-[#e9efff] text-[#0c66e4] dark:border-[#579dff] dark:bg-[#1c2b41] dark:text-[#85b8ff]'
                      : 'bg-[#091e420f] border-transparent text-[#44546f] hover:bg-[#e9efff] hover:text-[#0c66e4] dark:bg-[#ffffff1f] dark:text-[#8c9bab]'
                  }`}
                >
                  {isWatching ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  {isWatching ? t('kanbanCardDetailModal.sidebar.stopWatchCard') : t('kanbanCardDetailModal.sidebar.watchCard')}
                </button>
                <button onClick={handleDuplicate} className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-[#44546f] transition-colors hover:bg-[#e9efff] hover:text-[#0c66e4] dark:bg-[#ffffff1f] dark:text-[#8c9bab]">
                  <Copy className="w-4 h-4" /> {t('kanbanCardDetailModal.sidebar.duplicateCard')}
                </button>
                <button onClick={openMoveToBoard} className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-[#44546f] transition-colors hover:bg-[#e9efff] hover:text-[#0c66e4] dark:bg-[#ffffff1f] dark:text-[#8c9bab]">
                  <ArrowRightCircle className="w-4 h-4" /> {t('kanbanCardDetailModal.sidebar.moveToBoard')}
                </button>
                {showMoveToBoard && (
                  <div className="rounded-xl border border-[#e2e6ea] bg-white p-3 dark:border-[#3b4754] dark:bg-[#22272b]">
                    <p className="mb-2 text-[11px] font-semibold text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.sidebar.boardDestination')}</p>
                    <select value={moveToBoardId} onChange={e => handleMoveToBoardChange(e.target.value)}
                      className="mb-2 w-full rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#282e33] dark:text-gray-200">
                      <option value="">{t('kanbanCardDetailModal.placeholders.selectBoard')}</option>
                      {otherBoards.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
                    </select>
                    {moveToBoardLists.length > 0 && (
                      <select value={moveToListId} onChange={e => setMoveToListId(e.target.value)}
                        className="mb-2 w-full rounded-lg border border-[#cfd3d8] bg-white px-2 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#282e33] dark:text-gray-200">
                        <option value="">{t('kanbanCardDetailModal.placeholders.selectList')}</option>
                        {moveToBoardLists.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
                      </select>
                    )}
                    <div className="flex gap-2">
                      <button onClick={handleMoveToBoard} className="flex-1 rounded-lg bg-[#579dff] py-1.5 text-sm font-medium text-white hover:bg-[#4c8fe8]">{t('kanbanCardDetailModal.sidebar.moveButton')}</button>
                      <button onClick={() => setShowMoveToBoard(false)} className="rounded-lg px-3 py-1.5 text-sm text-[#44546f] hover:bg-[#091e4224] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.actions.cancel')}</button>
                    </div>
                  </div>
                )}
                {/* Decompose with AI */}
                <button
                  disabled={decomposing}
                  onClick={async () => {
                    setDecomposing(true);
                    try {
                      const result = await kanbanService.decomposeCard(card.id);
                      toast.success(t('kanbanCardDetailModal.toasts.decomposeSuccess', { count: result.count }));
                      // Notify parent about new cards
                      if (onCardAdded) {
                        for (const c of result.cards) onCardAdded(c);
                      }
                      // Refresh activities
                      kanbanService.listActivities(card.id).then(setActivities).catch(() => {});
                      // Update linked cards
                      if (result.cards.length > 0) {
                        const newLinked = [...(card.linkedCardIds || []), ...result.cards.map(c => c.id)];
                        onUpdated({ ...card, linkedCardIds: newLinked });
                      }
                    } catch (err: any) {
                      const msg = err?.response?.data?.message || t('kanbanCardDetailModal.toasts.decomposeError');
                      toast.error(msg);
                    } finally {
                      setDecomposing(false);
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-xl bg-gradient-to-r from-[#6366f1]/10 to-[#8b5cf6]/10 px-3 py-2.5 text-sm font-medium text-[#6366f1] transition-colors hover:from-[#6366f1]/20 hover:to-[#8b5cf6]/20 dark:from-[#6366f1]/20 dark:to-[#8b5cf6]/20 dark:text-[#a78bfa] dark:hover:from-[#6366f1]/30 dark:hover:to-[#8b5cf6]/30 disabled:opacity-50"
                >
                  {decomposing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {decomposing ? t('kanbanCardDetailModal.sidebar.decomposing') : t('kanbanCardDetailModal.sidebar.decompose')}
                </button>
                {/* GitHub */}
                <button
                  onClick={async () => {
                    const next = !showGithub;
                    setShowGithub(next);
                    if (!next) return;
                    setGithubLoading(true);
                    try {
                      // Check if GitHub power-up is configured
                      const pups = await kanbanService.listPowerUps(boardId);
                      const ghPup = pups.find(p => p.type === 'github' && p.enabled);
                      setGithubPowerUp(ghPup ?? null);
                      if (ghPup) {
                        const [issues, prs] = await Promise.all([
                          kanbanService.listGithubIssues(boardId).catch(() => []),
                          kanbanService.listGithubPRs(boardId).catch(() => []),
                        ]);
                        // @ts-ignore
                        setGithubIssues(issues);
                        // @ts-ignore
                        setGithubPRs(prs);
                      }
                    } finally {
                      setGithubLoading(false);
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-[#44546f] transition-colors hover:bg-gray-200 hover:text-gray-800 dark:bg-[#ffffff1f] dark:text-[#8c9bab] dark:hover:bg-gray-700 dark:hover:text-gray-200"
                >
                  <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                  GitHub {(card.customFields?.['__githubIssueNumber'] || card.customFields?.['__githubPrNumber']) ? '✓' : ''}
                </button>
                {showGithub && (
                  <div className="space-y-2 rounded-xl bg-[#091e420f] p-3 dark:bg-[#ffffff0a]">
                    {githubLoading ? (
                      <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3 h-3 animate-spin" /> {t('kanbanCardDetailModal.github.loadingText')}</div>
                    ) : githubPowerUp === null ? (
                      /* ── GitHub não configurado ── */
                      <div className="space-y-2 text-center py-1">
                        <p className="text-xs text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.github.notConfigured')}</p>
                        <button
                          onClick={() => { setShowGithub(false); setGithubSetupOpen(true); }}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#238636] px-3 py-2 text-xs font-semibold text-white hover:bg-[#2ea043] transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                          {t('kanbanCardDetailModal.github.setupButton')}
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex gap-1 mb-2">
                          <button onClick={() => setGithubTab('issues')} className={`flex-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors ${githubTab === 'issues' ? 'bg-[#238636] text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>Issues</button>
                          <button onClick={() => setGithubTab('prs')} className={`flex-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors ${githubTab === 'prs' ? 'bg-[#8250df] text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>Pull Requests</button>
                        </div>
                        {githubTab === 'issues' && (
                          <div className="space-y-2">
                            {!card.customFields?.['__githubIssueNumber'] && (
                              <button
                                onClick={async () => {
                                  setGithubCreatingIssue(true);
                                  try {
                                    const result = await kanbanService.createGithubIssueFromCard(card.id);
                                    const updated = { ...card, customFields: { ...card.customFields, __githubIssueNumber: result.number, __githubIssueUrl: result.html_url } };
                                    onUpdated(updated);
                                    toast.success(t('kanbanCardDetailModal.toasts.githubIssueCreated', { number: result.number }));
                                    setShowGithub(false);
                                  } catch (err: any) {
                                    toast.error(err?.response?.data?.message || t('kanbanCardDetailModal.toasts.githubIssueCreateError'));
                                  } finally { setGithubCreatingIssue(false); }
                                }}
                                disabled={githubCreatingIssue}
                                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#238636] px-3 py-2 text-xs font-semibold text-white hover:bg-[#2ea043] disabled:opacity-60 transition-colors"
                              >
                                {githubCreatingIssue
                                  ? <><Loader2 className="w-3 h-3 animate-spin" /> {t('kanbanCardDetailModal.github.creatingIssue')}</>
                                  : <><svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/><path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/></svg> {t('kanbanCardDetailModal.github.createIssue')}</>
                                }
                              </button>
                            )}
                            {card.customFields?.['__githubIssueNumber'] && (
                              <a href={card.customFields['__githubIssueUrl'] as string} target="_blank" rel="noopener noreferrer"
                                className="flex w-full items-center gap-2 rounded-lg bg-[#1b1f2380] px-3 py-2 text-xs text-[#58a6ff] hover:underline transition-colors">
                                <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/><path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/></svg>
                                {t('kanbanCardDetailModal.github.linkedIssue', { number: card.customFields['__githubIssueNumber'] as number })}
                              </a>
                            )}
                            <div className="max-h-40 overflow-y-auto space-y-1">
                              {githubIssues.length === 0 && <p className="text-[10px] text-gray-400 px-1">{t('kanbanCardDetailModal.github.noIssues')}</p>}
                              {githubIssues.map(issue => (
                                <button key={issue.number}
                                  onClick={async () => {
                                    try {
                                      await kanbanService.linkCardToGithubIssue(card.id, issue.number);
                                      onUpdated({ ...card, customFields: { ...card.customFields, __githubIssueNumber: issue.number, __githubIssueUrl: issue.html_url } });
                                      toast.success(t('kanbanCardDetailModal.toasts.githubIssueLinked', { number: issue.number }));
                                      setShowGithub(false);
                                    } catch { toast.error(t('kanbanCardDetailModal.toasts.githubIssueLinkError')); }
                                  }}
                                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white dark:hover:bg-gray-700 transition-colors"
                                >
                                  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${issue.state === 'open' ? 'bg-[#238636]' : 'bg-[#8250df]'}`} />
                                  <span className="truncate text-[#172b4d] dark:text-gray-300">#{issue.number} {issue.title}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {githubTab === 'prs' && (
                          <div className="max-h-40 overflow-y-auto space-y-1">
                            {githubPRs.length === 0 && <p className="text-[10px] text-gray-400">{t('kanbanCardDetailModal.github.noPRs')}</p>}
                            {githubPRs.map(pr => (
                              <button key={pr.number}
                                onClick={async () => {
                                  try {
                                    await kanbanService.linkCardToGithubPR(card.id, pr.number);
                                    onUpdated({ ...card, customFields: { ...card.customFields, __githubPrNumber: pr.number, __githubPrUrl: pr.html_url, ...(pr.head?.ref ? { __githubBranch: pr.head.ref } : {}) } });
                                    toast.success(t('kanbanCardDetailModal.toasts.githubPRLinked', { number: pr.number }));
                                    setShowGithub(false);
                                  } catch { toast.error(t('kanbanCardDetailModal.toasts.githubPRLinkError')); }
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white dark:hover:bg-gray-700 transition-colors"
                              >
                                <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${pr.state === 'open' ? 'bg-[#238636]' : pr.state === 'merged' ? 'bg-[#8250df]' : 'bg-[#da3633]'}`} />
                                <span className="truncate text-[#172b4d] dark:text-gray-300">#{pr.number} {pr.title}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                {/* Confluence */}
                <button
                  onClick={() => {
                    setShowConfluence(!showConfluence);
                    if (!showConfluence && confluencePages.length === 0) {
                      setConfluenceLoading(true);
                      kanbanService.listRecentConfluencePages(boardId)
                        .then(setConfluencePages)
                        .catch(() => {})
                        .finally(() => setConfluenceLoading(false));
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-[#44546f] transition-colors hover:bg-blue-100 hover:text-blue-700 dark:bg-[#ffffff1f] dark:text-[#8c9bab] dark:hover:bg-blue-900/30 dark:hover:text-blue-400"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M3.27 14.22c-.2.34-.43.72-.62 1a.58.58 0 0 0 .2.8l3.64 2.22a.57.57 0 0 0 .79-.18c.16-.26.38-.6.63-1 1.68-2.63 3.38-2.3 6.46-.84l3.64 1.72a.58.58 0 0 0 .77-.27l1.63-3.47a.58.58 0 0 0-.28-.76c-.91-.43-2.73-1.29-3.64-1.72-5.5-2.59-9.1-2.59-13.22 2.5zm17.46-4.44c.2-.34.43-.72.62-1a.58.58 0 0 0-.2-.8L17.5 5.76a.57.57 0 0 0-.79.18c-.16.26-.38.6-.63 1-1.68 2.63-3.38 2.3-6.46.84L5.98 6.06a.58.58 0 0 0-.77.27L3.58 9.8a.58.58 0 0 0 .28.76c.91.43 2.73 1.29 3.64 1.72 5.5 2.59 9.1 2.59 13.22-2.5z"/></svg>
                  Confluence {linkedConfluencePages.length > 0 && `(${linkedConfluencePages.length})`}
                </button>
                {showConfluence && (
                  <div className="space-y-2 rounded-xl bg-[#091e420f] p-3 dark:bg-[#ffffff0a]">
                    {/* Linha 1: título + maximizar */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#44546f] dark:text-gray-400">{t('kanbanCardDetailModal.confluence.searchPages')}</span>
                      <button
                        title={t('kanbanCardDetailModal.confluence.openFullscreen')}
                        onClick={() => {
                          setShowConfluenceModal(true);
                          if (confluencePages.length === 0) {
                            setConfluenceLoading(true);
                            kanbanService.listRecentConfluencePages(boardId)
                              .then(setConfluencePages)
                              .catch(() => {})
                              .finally(() => setConfluenceLoading(false));
                          }
                        }}
                        className="flex items-center justify-center rounded-lg border border-[#dcdfe4] bg-white p-1 text-[#626f86] hover:border-[#0052cc] hover:text-[#0052cc] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400 dark:hover:text-blue-400 transition-colors"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {/* Linha 2: input */}
                    <input
                      placeholder={t('kanbanCardDetailModal.placeholders.searchConfluence')}
                      value={confluenceSearch}
                      onChange={e => setConfluenceSearch(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && confluenceSearch.trim()) {
                          setConfluenceLoading(true);
                          try {
                            const pages = await kanbanService.searchConfluencePages(boardId, confluenceSearch.trim());
                            setConfluencePages(pages);
                          } catch { toast.error(t('kanbanCardDetailModal.toasts.confluenceSearchError')); }
                          setConfluenceLoading(false);
                        }
                      }}
                      className="w-full rounded-lg border border-[#dcdfe4] bg-white px-2.5 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 outline-none"
                    />
                    {/* Linha 3: botão buscar */}
                    <button
                      onClick={async () => {
                        if (!confluenceSearch.trim()) return;
                        setConfluenceLoading(true);
                        try {
                          const pages = await kanbanService.searchConfluencePages(boardId, confluenceSearch.trim());
                          setConfluencePages(pages);
                        } catch { toast.error(t('kanbanCardDetailModal.toasts.confluenceSearchError')); }
                        setConfluenceLoading(false);
                      }}
                      className="w-full rounded-lg bg-[#0052cc] py-1.5 text-xs font-medium text-white hover:bg-[#0747a6] transition-colors"
                    >
                      {t('kanbanCardDetailModal.confluence.searchButton')}
                    </button>
                    {confluenceLoading ? (
                      <div className="flex items-center justify-center py-4 text-xs text-[#626f86]">
                        <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> {t('kanbanCardDetailModal.confluence.searching')}
                      </div>
                    ) : confluencePages.length === 0 ? (
                      <p className="py-3 text-center text-xs text-[#626f86] dark:text-gray-400">
                        {t('kanbanCardDetailModal.confluence.noPages')}
                      </p>
                    ) : (
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {confluencePages.map(page => {
                          const isLinked = linkedConfluencePages.some(p => p.id === page.id);
                          return (
                            <div key={page.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[#deebff] dark:hover:bg-[#1c2b41]">
                              <svg className="w-3.5 h-3.5 text-[#0052cc] flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M3.27 14.22c-.2.34-.43.72-.62 1a.58.58 0 0 0 .2.8l3.64 2.22a.57.57 0 0 0 .79-.18c.16-.26.38-.6.63-1 1.68-2.63 3.38-2.3 6.46-.84l3.64 1.72a.58.58 0 0 0 .77-.27l1.63-3.47a.58.58 0 0 0-.28-.76c-.91-.43-2.73-1.29-3.64-1.72-5.5-2.59-9.1-2.59-13.22 2.5zm17.46-4.44c.2-.34.43-.72.62-1a.58.58 0 0 0-.2-.8L17.5 5.76a.57.57 0 0 0-.79.18c-.16.26-.38.6-.63 1-1.68 2.63-3.38 2.3-6.46.84L5.98 6.06a.58.58 0 0 0-.77.27L3.58 9.8a.58.58 0 0 0 .28.76c.91.43 2.73 1.29 3.64 1.72 5.5 2.59 9.1 2.59 13.22-2.5z"/></svg>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-[#172b4d] dark:text-gray-200 truncate">{page.title}</p>
                                {page.excerpt && <p className="text-[10px] text-[#626f86] dark:text-gray-400 truncate">{page.excerpt}</p>}
                                <p className="text-[9px] text-[#8590a2]">{page.spaceKey} · {page.lastModifiedBy && `${page.lastModifiedBy} · `}{page.lastModified && new Date(page.lastModified).toLocaleDateString('pt-BR')}</p>
                              </div>
                              {isLinked ? (
                                <span className="text-[10px] text-green-600 font-medium">{t('kanbanCardDetailModal.confluence.linked')}</span>
                              ) : (
                                <button
                                  onClick={async () => {
                                    try {
                                      await kanbanService.linkConfluencePage(card.id, { id: page.id, title: page.title, webUrl: page.webUrl, spaceKey: page.spaceKey });
                                      const newPages = [...linkedConfluencePages, { id: page.id, title: page.title, webUrl: page.webUrl, spaceKey: page.spaceKey, linkedAt: new Date().toISOString() }];
                                      onUpdated({ ...card, customFields: { ...(card.customFields || {}), __confluencePages: JSON.stringify(newPages) } });
                                      toast.success(t('kanbanCardDetailModal.toasts.confluencePageLinked', { title: page.title }));
                                    } catch { toast.error(t('kanbanCardDetailModal.toasts.confluencePageLinkError')); }
                                  }}
                                  className="rounded-md bg-[#0052cc] px-2 py-0.5 text-[10px] font-medium text-white hover:bg-[#0747a6]"
                                >
                                  {t('kanbanCardDetailModal.confluence.link')}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Confluence expanded modal */}
                {showConfluenceModal && createPortal(
                  <div className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/50 p-4">
                    <div className="flex h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl dark:bg-gray-800">
                      {/* Header */}
                      <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4 dark:border-gray-700">
                        <svg className="h-5 w-5 text-[#0052cc]" viewBox="0 0 24 24" fill="currentColor"><path d="M3.27 14.22c-.2.34-.43.72-.62 1a.58.58 0 0 0 .2.8l3.64 2.22a.57.57 0 0 0 .79-.18c.16-.26.38-.6.63-1 1.68-2.63 3.38-2.3 6.46-.84l3.64 1.72a.58.58 0 0 0 .77-.27l1.63-3.47a.58.58 0 0 0-.28-.76c-.91-.43-2.73-1.29-3.64-1.72-5.5-2.59-9.1-2.59-13.22 2.5zm17.46-4.44c.2-.34.43-.72.62-1a.58.58 0 0 0-.2-.8L17.5 5.76a.57.57 0 0 0-.79.18c-.16.26-.38.6-.63 1-1.68 2.63-3.38 2.3-6.46.84L5.98 6.06a.58.58 0 0 0-.77.27L3.58 9.8a.58.58 0 0 0 .28.76c.91.43 2.73 1.29 3.64 1.72 5.5 2.59 9.1 2.59 13.22-2.5z"/></svg>
                        <div className="flex-1">
                          <h2 className="text-sm font-semibold text-[#172b4d] dark:text-white">{t('kanbanCardDetailModal.confluence.title')}</h2>
                          <p className="text-xs text-[#626f86] dark:text-gray-400">{t('kanbanCardDetailModal.confluence.subtitle')}</p>
                        </div>
                        <button onClick={() => setShowConfluenceModal(false)} className="flex h-8 w-8 items-center justify-center rounded-lg text-[#626f86] hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-700">
                          <X className="h-4 w-4" />
                        </button>
                      </div>

                      {/* Search bar */}
                      <div className="flex gap-2 border-b border-slate-200 px-5 py-3 dark:border-gray-700">
                        <input
                          autoFocus
                          placeholder={t('kanbanCardDetailModal.placeholders.searchConfluenceFull')}
                          value={confluenceSearch}
                          onChange={e => setConfluenceSearch(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && confluenceSearch.trim()) {
                              setConfluenceLoading(true);
                              try {
                                const pages = await kanbanService.searchConfluencePages(boardId, confluenceSearch.trim());
                                setConfluencePages(pages);
                              } catch { toast.error(t('kanbanCardDetailModal.toasts.confluenceSearchError')); }
                              setConfluenceLoading(false);
                            }
                          }}
                          className="min-w-0 flex-1 rounded-xl border border-[#dcdfe4] bg-slate-50 px-4 py-2.5 text-sm text-[#172b4d] outline-none focus:border-[#0052cc] focus:ring-2 focus:ring-[#0052cc]/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
                        />
                        <button
                          onClick={async () => {
                            if (!confluenceSearch.trim()) return;
                            setConfluenceLoading(true);
                            try {
                              const pages = await kanbanService.searchConfluencePages(boardId, confluenceSearch.trim());
                              setConfluencePages(pages);
                            } catch { toast.error(t('kanbanCardDetailModal.toasts.confluenceSearchError')); }
                            setConfluenceLoading(false);
                          }}
                          className="flex-shrink-0 rounded-xl bg-[#0052cc] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#0747a6] transition-colors"
                        >
                          {t('kanbanCardDetailModal.confluence.searchButton')}
                        </button>
                      </div>

                      {/* Results */}
                      <div className="flex-1 overflow-y-auto px-5 py-3">
                        {/* Already linked */}
                        {linkedConfluencePages.length > 0 && (
                          <div className="mb-4">
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#626f86] dark:text-gray-400">{t('kanbanCardDetailModal.confluence.linkedTitle', { count: linkedConfluencePages.length })}</p>
                            <div className="space-y-1.5">
                              {linkedConfluencePages.map(p => (
                                <div key={p.id} className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5 dark:border-green-900/40 dark:bg-green-900/20">
                                  <svg className="h-4 w-4 flex-shrink-0 text-[#0052cc]" viewBox="0 0 24 24" fill="currentColor"><path d="M3.27 14.22c-.2.34-.43.72-.62 1a.58.58 0 0 0 .2.8l3.64 2.22a.57.57 0 0 0 .79-.18c.16-.26.38-.6.63-1 1.68-2.63 3.38-2.3 6.46-.84l3.64 1.72a.58.58 0 0 0 .77-.27l1.63-3.47a.58.58 0 0 0-.28-.76c-.91-.43-2.73-1.29-3.64-1.72-5.5-2.59-9.1-2.59-13.22 2.5zm17.46-4.44c.2-.34.43-.72.62-1a.58.58 0 0 0-.2-.8L17.5 5.76a.57.57 0 0 0-.79.18c-.16.26-.38.6-.63 1-1.68 2.63-3.38 2.3-6.46.84L5.98 6.06a.58.58 0 0 0-.77.27L3.58 9.8a.58.58 0 0 0 .28.76c.91.43 2.73 1.29 3.64 1.72 5.5 2.59 9.1 2.59 13.22-2.5z"/></svg>
                                  <div className="flex-1 min-w-0">
                                    <a href={p.webUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-[#0052cc] hover:underline truncate block">{p.title}</a>
                                    <p className="text-xs text-[#626f86] dark:text-gray-400">{p.spaceKey}</p>
                                  </div>
                                  <button
                                    onClick={async () => {
                                      try {
                                        await kanbanService.unlinkConfluencePage(card.id, p.id);
                                        const newPages = linkedConfluencePages.filter(lp => lp.id !== p.id);
                                        onUpdated({ ...card, customFields: { ...(card.customFields || {}), __confluencePages: JSON.stringify(newPages) } });
                                        toast.success(t('kanbanCardDetailModal.toasts.confluenceUnlinked'));
                                      } catch { toast.error(t('kanbanCardDetailModal.toasts.confluenceUnlinkError')); }
                                    }}
                                    className="flex-shrink-0 rounded-lg px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                                  >
                                    {t('kanbanCardDetailModal.confluence.remove')}
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Search results */}
                        {confluenceLoading ? (
                          <div className="flex items-center justify-center py-12 text-sm text-[#626f86]">
                            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> {t('kanbanCardDetailModal.confluence.searching')}
                          </div>
                        ) : confluencePages.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-12 text-center">
                            <svg className="mb-3 h-10 w-10 text-[#c1c7d0]" viewBox="0 0 24 24" fill="currentColor"><path d="M3.27 14.22c-.2.34-.43.72-.62 1a.58.58 0 0 0 .2.8l3.64 2.22a.57.57 0 0 0 .79-.18c.16-.26.38-.6.63-1 1.68-2.63 3.38-2.3 6.46-.84l3.64 1.72a.58.58 0 0 0 .77-.27l1.63-3.47a.58.58 0 0 0-.28-.76c-.91-.43-2.73-1.29-3.64-1.72-5.5-2.59-9.1-2.59-13.22 2.5zm17.46-4.44c.2-.34.43-.72.62-1a.58.58 0 0 0-.2-.8L17.5 5.76a.57.57 0 0 0-.79.18c-.16.26-.38.6-.63 1-1.68 2.63-3.38 2.3-6.46.84L5.98 6.06a.58.58 0 0 0-.77.27L3.58 9.8a.58.58 0 0 0 .28.76c.91.43 2.73 1.29 3.64 1.72 5.5 2.59 9.1 2.59 13.22-2.5z"/></svg>
                            <p className="text-sm text-[#626f86] dark:text-gray-400">{t('kanbanCardDetailModal.confluence.noPagesFullscreen')}</p>
                            <p className="mt-1 text-xs text-[#8590a2] dark:text-gray-500">{t('kanbanCardDetailModal.confluence.noPagesHint')}</p>
                          </div>
                        ) : (
                          <>
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#626f86] dark:text-gray-400">{t('kanbanCardDetailModal.confluence.resultsTitle', { count: confluencePages.length })}</p>
                            <div className="space-y-1.5">
                              {confluencePages.map(page => {
                                const isLinked = linkedConfluencePages.some(p => p.id === page.id);
                                return (
                                  <div key={page.id} className={`flex items-start gap-3 rounded-xl border px-3 py-3 transition-colors ${isLinked ? 'border-green-200 bg-green-50 dark:border-green-900/40 dark:bg-green-900/20' : 'border-slate-200 bg-white hover:border-[#0052cc]/30 hover:bg-[#deebff]/50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700'}`}>
                                    <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#0052cc]" viewBox="0 0 24 24" fill="currentColor"><path d="M3.27 14.22c-.2.34-.43.72-.62 1a.58.58 0 0 0 .2.8l3.64 2.22a.57.57 0 0 0 .79-.18c.16-.26.38-.6.63-1 1.68-2.63 3.38-2.3 6.46-.84l3.64 1.72a.58.58 0 0 0 .77-.27l1.63-3.47a.58.58 0 0 0-.28-.76c-.91-.43-2.73-1.29-3.64-1.72-5.5-2.59-9.1-2.59-13.22 2.5zm17.46-4.44c.2-.34.43-.72.62-1a.58.58 0 0 0-.2-.8L17.5 5.76a.57.57 0 0 0-.79.18c-.16.26-.38.6-.63 1-1.68 2.63-3.38 2.3-6.46.84L5.98 6.06a.58.58 0 0 0-.77.27L3.58 9.8a.58.58 0 0 0 .28.76c.91.43 2.73 1.29 3.64 1.72 5.5 2.59 9.1 2.59 13.22-2.5z"/></svg>
                                    <div className="flex-1 min-w-0">
                                      <a href={page.webUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-[#0052cc] hover:underline">{page.title}</a>
                                      {page.excerpt && <p className="mt-0.5 text-xs text-[#44546f] dark:text-gray-400 line-clamp-2">{page.excerpt}</p>}
                                      <p className="mt-1 text-[10px] text-[#8590a2]">
                                        {page.spaceKey}
                                        {page.lastModifiedBy && ` · ${page.lastModifiedBy}`}
                                        {page.lastModified && ` · ${new Date(page.lastModified).toLocaleDateString('pt-BR')}`}
                                      </p>
                                    </div>
                                    {isLinked ? (
                                      <span className="flex-shrink-0 rounded-lg bg-green-100 px-2.5 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">{t('kanbanCardDetailModal.confluence.linked')}</span>
                                    ) : (
                                      <button
                                        onClick={async () => {
                                          try {
                                            await kanbanService.linkConfluencePage(card.id, { id: page.id, title: page.title, webUrl: page.webUrl, spaceKey: page.spaceKey });
                                            const newPages = [...linkedConfluencePages, { id: page.id, title: page.title, webUrl: page.webUrl, spaceKey: page.spaceKey, linkedAt: new Date().toISOString() }];
                                            onUpdated({ ...card, customFields: { ...(card.customFields || {}), __confluencePages: JSON.stringify(newPages) } });
                                            toast.success(t('kanbanCardDetailModal.toasts.confluencePageLinked', { title: page.title }));
                                          } catch { toast.error(t('kanbanCardDetailModal.toasts.confluencePageLinkError')); }
                                        }}
                                        className="flex-shrink-0 rounded-lg bg-[#0052cc] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0747a6] transition-colors"
                                      >
                                        {t('kanbanCardDetailModal.confluence.link')}
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>,
                  document.body
                )}

                {/* Snooze */}
                {isSnoozed ? (
                  <button
                    onClick={async () => {
                      try {
                        const updated = await kanbanService.unsnoozeCard(card.id);
                        onUpdated(updated);
                        toast.success(t('kanbanCardDetailModal.toasts.unsnoozeSuccess'));
                      } catch { toast.error(t('kanbanCardDetailModal.toasts.unsnoozeError')); }
                    }}
                    className="flex w-full items-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:hover:bg-amber-900/30"
                  >
                    <AlarmClock className="w-4 h-4" /> {t('kanbanCardDetailModal.sidebar.wakeUpCard', { date: new Date(card.customFields['__snoozedUntil'] as string).toLocaleDateString(i18n.language) })}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setShowSnooze(!showSnooze)}
                      className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-[#44546f] transition-colors hover:bg-indigo-100 hover:text-indigo-700 dark:bg-[#ffffff1f] dark:text-[#8c9bab] dark:hover:bg-indigo-900/30 dark:hover:text-indigo-400"
                    >
                      <AlarmClock className="w-4 h-4" /> {t('kanbanCardDetailModal.sidebar.snooze')}
                    </button>
                    {showSnooze && (
                      <div className="space-y-2 rounded-xl bg-[#091e420f] p-3 dark:bg-[#ffffff0a]">
                        <p className="text-xs font-semibold text-[#44546f] dark:text-gray-400">{t('kanbanCardDetailModal.snooze.quickSnooze')}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {[
                            { label: t('kanbanCardDetailModal.snooze.tomorrow'), days: 1 },
                            { label: t('kanbanCardDetailModal.snooze.threeDays'), days: 3 },
                            { label: t('kanbanCardDetailModal.snooze.oneWeek'), days: 7 },
                            { label: t('kanbanCardDetailModal.snooze.twoWeeks'), days: 14 },
                            { label: t('kanbanCardDetailModal.snooze.oneMonth'), days: 30 },
                          ].map(opt => (
                            <button
                              key={opt.days}
                              onClick={async () => {
                                const d = new Date();
                                d.setDate(d.getDate() + opt.days);
                                d.setHours(9, 0, 0, 0);
                                try {
                                  const updated = await kanbanService.snoozeCard(card.id, d.toISOString());
                                  onUpdated(updated);
                                  toast.success(t('kanbanCardDetailModal.toasts.snoozed', { date: d.toLocaleDateString(i18n.language) }));
                                  setShowSnooze(false);
                                } catch { toast.error(t('kanbanCardDetailModal.toasts.snoozeError')); }
                              }}
                              className="rounded-lg border border-[#dcdfe4] px-2.5 py-1 text-xs text-[#172b4d] hover:bg-[#e9efff] dark:border-gray-600 dark:text-gray-300 dark:hover:bg-[#1c2b41]"
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <div className="flex gap-1.5 pt-1 min-w-0">
                          <input
                            type="datetime-local"
                            value={snoozeDate}
                            onChange={e => setSnoozeDate(e.target.value)}
                            className="min-w-0 flex-1 rounded-lg border border-[#dcdfe4] bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
                          />
                          <button
                            onClick={async () => {
                              if (!snoozeDate) return;
                              try {
                                const updated = await kanbanService.snoozeCard(card.id, new Date(snoozeDate).toISOString());
                                onUpdated(updated);
                                toast.success(t('kanbanCardDetailModal.toasts.snoozed', { date: new Date(snoozeDate).toLocaleDateString(i18n.language) }));
                                setShowSnooze(false);
                              } catch { toast.error(t('kanbanCardDetailModal.toasts.snoozeError')); }
                            }}
                            disabled={!snoozeDate}
                            className="rounded-lg bg-[#579dff] px-3 py-1 text-xs font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-50"
                          >
                            {t('kanbanCardDetailModal.snooze.snoozeButton')}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                <button onClick={handleArchive} className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-[#44546f] transition-colors hover:bg-amber-100 hover:text-amber-700 dark:bg-[#ffffff1f] dark:text-[#8c9bab] dark:hover:bg-amber-900/30 dark:hover:text-amber-400">
                  <Archive className="w-4 h-4" /> {t('kanbanCardDetailModal.sidebar.archiveCard')}
                </button>
                <button onClick={handleDelete} className="flex w-full items-center gap-2 rounded-xl bg-[#091e420f] px-3 py-2.5 text-sm font-medium text-[#44546f] transition-colors hover:bg-red-100 hover:text-red-600 dark:bg-[#ffffff1f] dark:text-[#8c9bab] dark:hover:bg-red-900/30 dark:hover:text-red-400">
                  <Trash2 className="w-4 h-4" /> {t('kanbanCardDetailModal.sidebar.deleteCard')}
                </button>
              </div>
                )}
              </div>
              </div>
            </aside>

          </div>
        </div>
  );

  if (fullPage) return (
    <>
      {_inner}
      {showExecuteModal && (
        <ExecuteAgentModal
          cardId={card.id}
          repos={boardRepos}
          defaultExecType={listConfig?.defaultExecType ?? undefined}
          defaultRepoId={listConfig?.defaultRepoId ?? undefined}
          onClose={() => setShowExecuteModal(false)}
          onExecuted={handleExecuted}
        />
      )}
    </>
  );

  return createPortal(
    <>
      <div
        className="kanban-scroll fixed inset-0 z-[9999] overflow-y-auto"
        style={{ background: 'rgba(0,0,0,0.72)' }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="flex min-h-full items-start justify-center p-2 py-4 sm:p-4 sm:py-10">
          {_inner}
        </div>
      </div>
      {showExecuteModal && (
        <ExecuteAgentModal
          cardId={card.id}
          repos={boardRepos}
          defaultExecType={listConfig?.defaultExecType ?? undefined}
          defaultRepoId={listConfig?.defaultRepoId ?? undefined}
          onClose={() => setShowExecuteModal(false)}
          onExecuted={handleExecuted}
        />
      )}
      {/* GitHub setup dialog */}
      {githubSetupOpen && (
        <div
          className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setGithubSetupOpen(false); }}
        >
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl dark:bg-[#1f2428] p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-[#24292f] dark:text-white" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                <h2 className="text-base font-semibold text-[#172b4d] dark:text-[#b6c2cf]">{t('kanbanCardDetailModal.github.setupTitle')}</h2>
              </div>
              <button onClick={() => setGithubSetupOpen(false)} className="rounded-full p-1 text-[#44546f] hover:bg-[#091e4224] dark:hover:bg-[#ffffff1f] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.github.tokenLabel')}</label>
                <input
                  type="password"
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  value={githubSetup.token}
                  onChange={e => setGithubSetup(s => ({ ...s, token: e.target.value }))}
                  className="w-full rounded-xl border border-[#cfd3d8] bg-[#f8f9fb] px-3 py-2.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] focus:bg-white dark:border-[#3b4754] dark:bg-[#282e33] dark:text-[#b6c2cf] dark:focus:bg-[#1f2428] transition-colors"
                />
                <p className="mt-1 text-[10px] text-[#8590a2]">{t('kanbanCardDetailModal.github.tokenHint')}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.github.ownerLabel')}</label>
                  <input
                    type="text"
                    placeholder="minha-org"
                    value={githubSetup.repoOwner}
                    onChange={e => setGithubSetup(s => ({ ...s, repoOwner: e.target.value }))}
                    className="w-full rounded-xl border border-[#cfd3d8] bg-[#f8f9fb] px-3 py-2.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] focus:bg-white dark:border-[#3b4754] dark:bg-[#282e33] dark:text-[#b6c2cf] dark:focus:bg-[#1f2428] transition-colors"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#44546f] dark:text-[#8c9bab]">{t('kanbanCardDetailModal.github.repoLabel')}</label>
                  <input
                    type="text"
                    placeholder="meu-projeto"
                    value={githubSetup.repoName}
                    onChange={e => setGithubSetup(s => ({ ...s, repoName: e.target.value }))}
                    className="w-full rounded-xl border border-[#cfd3d8] bg-[#f8f9fb] px-3 py-2.5 text-sm text-[#172b4d] outline-none focus:border-[#579dff] focus:bg-white dark:border-[#3b4754] dark:bg-[#282e33] dark:text-[#b6c2cf] dark:focus:bg-[#1f2428] transition-colors"
                  />
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  disabled={!githubSetup.token || !githubSetup.repoOwner || !githubSetup.repoName}
                  onClick={async () => {
                    const tid = toast.loading(t('kanbanCardDetailModal.toasts.connectionTesting'));
                    try {
                      const r = await fetch(`https://api.github.com/repos/${githubSetup.repoOwner}/${githubSetup.repoName}`, {
                        headers: { Authorization: `Bearer ${githubSetup.token}`, Accept: 'application/vnd.github.v3+json' },
                      });
                      if (r.ok) {
                        const data = await r.json();
                        toast.success(t('kanbanCardDetailModal.toasts.connectionSuccess', { name: data.full_name }), { id: tid });
                      } else {
                        toast.error(t('kanbanCardDetailModal.toasts.connectionFailed', { status: r.status }), { id: tid });
                      }
                    } catch { toast.error(t('kanbanCardDetailModal.toasts.connectionError'), { id: tid }); }
                  }}
                  className="flex items-center gap-1.5 rounded-xl border border-[#cfd3d8] px-4 py-2.5 text-sm font-medium text-[#44546f] hover:bg-[#f4f5f7] disabled:opacity-40 dark:border-[#3b4754] dark:text-[#8c9bab] dark:hover:bg-[#282e33] transition-colors"
                >
                  {t('kanbanCardDetailModal.github.testConnection')}
                </button>
                <button
                  disabled={githubSetupSaving || !githubSetup.token || !githubSetup.repoOwner || !githubSetup.repoName}
                  onClick={async () => {
                    setGithubSetupSaving(true);
                    try {
                      const pup = await kanbanService.createPowerUp(boardId, {
                        type: 'github',
                        config: { token: githubSetup.token, repoOwner: githubSetup.repoOwner, repoName: githubSetup.repoName },
                      });
                      setGithubPowerUp(pup);
                      setGithubSetupOpen(false);
                      setGithubLoading(true);
                      setShowGithub(true);
                      const [issues, prs] = await Promise.all([
                        kanbanService.listGithubIssues(boardId).catch(() => []),
                        kanbanService.listGithubPRs(boardId).catch(() => []),
                      ]);
                      // @ts-ignore
                      setGithubIssues(issues);
                      // @ts-ignore
                      setGithubPRs(prs);
                      setGithubLoading(false);
                      toast.success(t('kanbanCardDetailModal.toasts.githubSetupSuccess'));
                    } catch { toast.error(t('kanbanCardDetailModal.toasts.githubSetupError')); }
                    finally { setGithubSetupSaving(false); }
                  }}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#238636] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2ea043] disabled:opacity-50 transition-colors"
                >
                  {githubSetupSaving ? <><Loader2 className="w-4 h-4 animate-spin" /> {t('kanbanCardDetailModal.github.saving')}</> : t('kanbanCardDetailModal.github.saveAndConnect')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Image preview lightbox */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/85 cursor-zoom-out"
          onClick={() => setPreviewImage(null)}
        >
          <button onClick={() => setPreviewImage(null)} className="absolute top-4 right-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors">
            <X className="h-5 w-5" />
          </button>
          <img src={previewImage} alt="Preview" className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl" />
        </div>
      )}
    </>,
    document.body
  );
};

// ── helpers ───────────────────────────────────────────────────────────────────
// PanelWrap, Btn, Pop, AnchoredPortal, PopoverAnchorContext, POP_WIDTH/POP_GAP
// all live in ./detail/ now (extracted 2026-05-04). See the import block at
// the top of this file.
