/**
 * KanbanAutomationPanel — Butler-style automation rules panel
 *
 * Displays existing rules as human-readable sentences ("When card moves to 'Done' → Archive card"),
 * shows last execution timestamp + status badge, provides quick-start templates,
 * and has a guided create form (trigger → action) with full field support.
 */
// @ts-ignore
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Zap, Plus, Trash2, X, Loader2, Archive, Calendar, AlertTriangle,
  // @ts-ignore
  Check, Users, ArrowRight, ChevronDown, ChevronUp, Play, Globe,
  // @ts-ignore
  CheckCircle2, XCircle, Clock, Layers, Tag, UserCheck, Move,
  Webhook, GitBranch, Layout, Unlock, Sparkles,
} from 'lucide-react';
import toast from 'react-hot-toast';
import kanbanService, {
  KanbanAutomationRule,
  KanbanList,
  KanbanBoardMember,
  KanbanActivity,
  KanbanAutomationAction,
  KanbanAutomationTrigger,
} from '@/services/kanban.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

const LABEL_PALETTE = [
  '#4bce97', '#f5cd47', '#fea362', '#f87168', '#9f8fef',
  '#579dff', '#6cc3e0', '#94c748', '#e774bb', '#8590a2',
];

function relativeTime(iso: string, t: TFunction): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('kanbanAutomation.justNow');
  if (mins < 60) return t('kanbanAutomation.minutesAgo', { mins });
  if (mins < 1440) return t('kanbanAutomation.hoursAgo', { hours: Math.floor(mins / 60) });
  return t('kanbanAutomation.daysAgo', { days: Math.floor(mins / 1440) });
}

function getTriggerLabel(r: KanbanAutomationRule, lists: KanbanList[], t: TFunction): string {
  const listName = r.trigger.listId
    ? (lists.find(l => l.id === r.trigger.listId)?.title ?? r.trigger.listTitle ?? r.trigger.listId)
    : '';
  switch (r.trigger.type) {
    case 'card_moved_to_list': return listName ? t('kanbanAutomation.cardMovedToList', { list: listName }) : t('kanbanAutomation.cardMovedFromList');
    case 'card_created':       return listName ? t('kanbanAutomation.cardCreatedInList', { list: listName }) : t('kanbanAutomation.cardCreated');
    case 'due_date_approaching': return t('kanbanAutomation.dueDateApproaching', { days: r.trigger.daysBeforeDue ?? 1 });
    case 'checklist_completed': return t('kanbanAutomation.checklistCompleted');
    case 'label_added':         return t('kanbanAutomation.labelAdded');
    case 'member_assigned':     return t('kanbanAutomation.memberAssigned');
    case 'card_archived':       return t('kanbanAutomation.cardArchived');
    // @ts-ignore
    case 'card_unblocked':      return t('kanbanAutomation.cardUnblocked');
    default:                    return r.trigger.type;
  }
}

function getActionLabel(r: KanbanAutomationRule, lists: KanbanList[], boardMembers: KanbanBoardMember[], t: TFunction): string {
  switch (r.action.type) {
    case 'add_label':    return r.action.labelText ? t('kanbanAutomation.addLabelWithName', { name: r.action.labelText }) : t('kanbanAutomation.addLabel');
    case 'remove_label': return t('kanbanAutomation.removeLabel');
    case 'assign_member': {
      const m = boardMembers.find(x => x.id === r.action.memberId);
      return m ? t('kanbanAutomation.assignMemberWithName', { name: m.name }) : t('kanbanAutomation.assignMember');
    }
    case 'set_due_offset': return t('kanbanAutomation.setDueOffset', { days: r.action.daysOffset ?? 3 });
    case 'move_card': {
      const l = lists.find(x => x.id === r.action.targetListId);
      return l ? t('kanbanAutomation.moveCardToList', { list: l.title }) : t('kanbanAutomation.moveCard');
    }
    case 'archive_card':  return t('kanbanAutomation.archiveCard');
    case 'send_webhook':  return t('kanbanAutomation.sendWebhook');
    case 'execute_flow':  return r.action.flowName ? t('kanbanAutomation.executeFlowWithName', { name: r.action.flowName }) : t('kanbanAutomation.executeFlow');
    case 'open_app':      return r.action.appName ? t('kanbanAutomation.openAppWithName', { name: r.action.appName }) : t('kanbanAutomation.openApp');
    default:              return (r.action as KanbanAutomationAction).type;
  }
}

/** Build "natural language" sentence for a rule */
function buildRuleSentence(r: KanbanAutomationRule, lists: KanbanList[], boardMembers: KanbanBoardMember[], t: TFunction): string {
  return t('kanbanAutomation.ruleSentence', { trigger: getTriggerLabel(r, lists, t), action: getActionLabel(r, lists, boardMembers, t) });
}

/** Find the most recent activity that matches a rule (by ruleId or description fallback) */
function findLastActivity(rule: KanbanAutomationRule, activities: KanbanActivity[]): KanbanActivity | null {
  const byId = activities
    .filter(a => a.text.includes(rule.id))
    .sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime())[0];
  if (byId) return byId;

  // fallback: match by description or action type keyword
  const key = rule.description || rule.action?.type || '';
  return activities
    .filter(a => a.text.startsWith('🤖') && a.text.includes(key))
    .sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime())[0] ?? null;
}

// ─── Trigger icon map ───────────────────────────────────────────────────────

function TriggerIcon({ type }: { type: KanbanAutomationTrigger['type'] }) {
  const cls = 'h-3.5 w-3.5';
  switch (type) {
    case 'card_moved_to_list':   return <Move className={cls} />;
    case 'card_created':         return <Plus className={cls} />;
    case 'due_date_approaching': return <Clock className={cls} />;
    case 'checklist_completed':  return <Check className={cls} />;
    case 'label_added':          return <Tag className={cls} />;
    case 'member_assigned':      return <UserCheck className={cls} />;
    case 'card_archived':        return <Archive className={cls} />;
    // @ts-ignore
    case 'card_unblocked':       return <Unlock className={cls} />;
    default:                     return <Zap className={cls} />;
  }
}

function ActionIcon({ type }: { type: KanbanAutomationAction['type'] }) {
  const cls = 'h-3.5 w-3.5';
  switch (type) {
    case 'add_label':      return <Tag className={cls} />;
    case 'remove_label':   return <Tag className={cls} />;
    case 'assign_member':  return <Users className={cls} />;
    case 'set_due_offset': return <Calendar className={cls} />;
    case 'move_card':      return <Move className={cls} />;
    case 'archive_card':   return <Archive className={cls} />;
    case 'send_webhook':   return <Webhook className={cls} />;
    case 'execute_flow':   return <GitBranch className={cls} />;
    case 'open_app':       return <Layout className={cls} />;
    default:               return <Play className={cls} />;
  }
}

// ─── Execution status badge ──────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
}

interface ExecutionBadgeProps {
  rule: KanbanAutomationRule;
  activities: KanbanActivity[];
  t: TFunction;
}

function ExecutionBadge({ rule, activities, t }: ExecutionBadgeProps) {
  const lastAct = findLastActivity(rule, activities);

  // Determine status — prefer explicit field on rule, fallback to activity text scan
  const explicitStatus = (rule as KanbanAutomationRule & { lastExecutionStatus?: string; lastExecutedAt?: string }).lastExecutionStatus;
  const explicitAt = (rule as KanbanAutomationRule & { lastExecutionStatus?: string; lastExecutedAt?: string }).lastExecutedAt;

  const isError =
    explicitStatus === 'error' ||
    explicitStatus === 'failed' ||
    (!explicitStatus && (
      lastAct?.text.toLowerCase().includes('erro') ||
      lastAct?.text.toLowerCase().includes('error') ||
      lastAct?.text.toLowerCase().includes('falhou')
    ));

  const isSuccess =
    explicitStatus === 'success' ||
    (!explicitStatus && lastAct && !isError);

  // Determine the timestamp to use for display
  const timestampIso = explicitAt ?? lastAct?.createdAt ?? null;

  // Check if inactive for > 7 days
  const isStale = timestampIso
    ? (Date.now() - new Date(timestampIso).getTime()) > SEVEN_DAYS_MS
    : false;

  const staleTooltip = timestampIso
    ? t('kanbanAutomation.noExecutionDays', { days: daysSince(timestampIso) })
    : t('kanbanAutomation.neverExecuted');

  if (isError) {
    return (
      <div className="mt-1.5 flex items-center gap-1">
        <XCircle className="h-3 w-3 flex-shrink-0 text-red-500 dark:text-red-400" />
        <span className="text-[10px] font-medium text-red-500 dark:text-red-400">
          {t('kanbanAutomation.failedAt', { time: timestampIso ? relativeTime(timestampIso, t) : '' })}
        </span>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="mt-1.5 flex items-center gap-1">
        {isStale ? (
          <Clock
            className="h-3 w-3 flex-shrink-0 text-amber-500 dark:text-amber-400"
            // @ts-ignore
            title={staleTooltip}
          />
        ) : (
          <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-emerald-500 dark:text-emerald-400" />
        )}
        <span
          className={`text-[10px] font-medium ${isStale ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}
          title={isStale ? staleTooltip : undefined}
        >
          {t('kanbanAutomation.executedAt', { time: timestampIso ? relativeTime(timestampIso, t) : '' })}
        </span>
        {isStale && (
          <span className="ml-0.5 text-[10px] text-amber-500 dark:text-amber-400" title={staleTooltip}>
            {t('kanbanAutomation.inactiveDays', { days: daysSince(timestampIso!) })}
          </span>
        )}
      </div>
    );
  }

  // Never executed
  return (
    <div className="mt-1.5 flex items-center gap-1">
      <Clock className="h-3 w-3 flex-shrink-0 text-[#adb5c0] dark:text-gray-600" />
      <span className="text-[10px] text-[#adb5c0] dark:text-gray-600">{t('kanbanAutomation.neverExecutedShort')}</span>
    </div>
  );
}

// ─── Rule card ──────────────────────────────────────────────────────────────

interface RuleCardProps {
  rule: KanbanAutomationRule;
  lists: KanbanList[];
  boardMembers: KanbanBoardMember[];
  activities: KanbanActivity[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  t: TFunction;
}

function RuleCard({ rule, lists, boardMembers, activities, onToggle, onDelete, t }: RuleCardProps) {
  return (
    <div
      className={`group rounded-xl border transition-all ${
        rule.enabled
          ? 'border-slate-200 bg-white dark:border-gray-600 dark:bg-gray-750'
          : 'border-slate-100 bg-slate-50/50 opacity-55 dark:border-gray-700 dark:bg-gray-700/50'
      }`}
    >
      <div className="flex items-start gap-2 p-3">
        {/* Rule icon */}
        <div className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${rule.enabled ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400' : 'bg-slate-100 text-slate-400 dark:bg-gray-700 dark:text-gray-500'}`}>
          <Zap className="h-3.5 w-3.5" />
        </div>

        {/* Rule content */}
        <div className="min-w-0 flex-1">
          {/* Human-readable sentence */}
          <p className="text-xs font-semibold leading-snug text-[#172b4d] dark:text-gray-200">
            {buildRuleSentence(rule, lists, boardMembers, t)}
          </p>

          {/* Trigger → Action pills */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
              <TriggerIcon type={rule.trigger.type} />
              {getTriggerLabel(rule, lists, t)}
            </span>
            <ArrowRight className="h-3 w-3 flex-shrink-0 text-slate-400 dark:text-gray-500" />
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
              <ActionIcon type={rule.action.type} />
              {getActionLabel(rule, lists, boardMembers, t)}
            </span>
          </div>

          {/* Execution status badge */}
          <ExecutionBadge rule={rule} activities={activities} t={t} />
        </div>

        {/* Controls */}
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            onClick={() => onToggle(rule.id)}
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold transition-colors ${
              rule.enabled
                ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-900/50'
                : 'bg-slate-200 text-slate-500 hover:bg-slate-300 dark:bg-gray-600 dark:text-gray-400 dark:hover:bg-gray-500'
            }`}
          >
            {rule.enabled ? t('kanbanAutomation.ruleActive') : t('kanbanAutomation.ruleInactive')}
          </button>
          <button
            onClick={() => onDelete(rule.id)}
            title={t('kanbanAutomation.deleteRule')}
            className="rounded p-1 text-[#626f86] opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100 dark:text-gray-500 dark:hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add-rule form ──────────────────────────────────────────────────────────

interface AddRuleFormProps {
  lists: KanbanList[];
  boardMembers: KanbanBoardMember[];
  boardId: string;
  onCreated: (rule: KanbanAutomationRule) => void;
  onCancel: () => void;
  t: TFunction;
}

// @ts-ignore
function AddRuleForm({ lists, boardMembers, boardId, onCreated, onCancel, t }: AddRuleFormProps) {
  const [step, setStep] = useState<'trigger' | 'action'>('trigger');

  const [triggerType, setTriggerType] = useState<KanbanAutomationTrigger['type']>('card_moved_to_list');
  const [triggerListId, setTriggerListId] = useState('');

  const [actionType, setActionType] = useState<KanbanAutomationAction['type']>('add_label');
  const [labelColor, setLabelColor] = useState(LABEL_PALETTE[0]);
  const [labelText, setLabelText] = useState('');
  const [memberId, setMemberId] = useState('');
  const [daysOffset, setDaysOffset] = useState('3');
  const [targetListId, setTargetListId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [flowId, setFlowId] = useState('');
  const [flowName, setFlowName] = useState('');
  const [appId, setAppId] = useState('');
  const [appName, setAppName] = useState('');
  const [appPageSlug, setAppPageSlug] = useState('');
  const [openMode, setOpenMode] = useState<'dialog' | 'new_tab' | 'sidebar'>('dialog');
  const [availableFlows, setAvailableFlows] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [availableApps, setAvailableApps] = useState<Array<{ id: string; name: string }>>([]);
  const [flowsLoaded, setFlowsLoaded] = useState(false);
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const triggerNeedsListId = triggerType === 'card_moved_to_list' || triggerType === 'card_created';

  const canProceedToAction =
    !triggerNeedsListId || triggerListId.trim() !== '';

  const canSave =
    (actionType !== 'move_card' || targetListId.trim() !== '') &&
    (actionType !== 'send_webhook' || webhookUrl.trim() !== '') &&
    (actionType !== 'execute_flow' || flowId.trim() !== '') &&
    (actionType !== 'open_app' || appId.trim() !== '');

  const handleSave = async () => {
    setSaving(true);
    try {
      const trigList = lists.find(l => l.id === triggerListId);
      const trigger: KanbanAutomationTrigger =
        triggerNeedsListId
          ? { type: triggerType, listId: triggerListId, listTitle: trigList?.title }
          : { type: triggerType };

      let action: KanbanAutomationAction;
      switch (actionType) {
        case 'add_label':     action = { type: 'add_label', labelColor, labelText: labelText || undefined }; break;
        case 'remove_label':  action = { type: 'remove_label', labelColor }; break;
        case 'assign_member': action = { type: 'assign_member', memberId: memberId || undefined }; break;
        case 'set_due_offset':action = { type: 'set_due_offset', daysOffset: parseInt(daysOffset) || 3 }; break;
        case 'move_card':     action = { type: 'move_card', targetListId: targetListId || undefined }; break;
        case 'archive_card':  action = { type: 'archive_card' }; break;
        case 'send_webhook':  action = { type: 'send_webhook', webhookUrl: webhookUrl || undefined }; break;
        case 'execute_flow':  action = { type: 'execute_flow', flowId: flowId || undefined, flowName: flowName || undefined } as KanbanAutomationAction; break;
        case 'open_app':      action = { type: 'open_app', appId: appId || undefined, appName: appName || undefined, appPageSlug: appPageSlug || undefined, openMode } as KanbanAutomationAction; break;
        default:              action = { type: 'archive_card' };
      }

      const triggerLabels: Record<string, string> = {
        card_moved_to_list:   t('kanbanAutomation.descTriggerMoveTo', { list: trigList?.title ?? '?' }),
        card_created:         t('kanbanAutomation.descTriggerCreated'),
        due_date_approaching: t('kanbanAutomation.descTriggerDueApproaching'),
        checklist_completed:  t('kanbanAutomation.descTriggerChecklistDone'),
        label_added:          t('kanbanAutomation.descTriggerLabelAdded'),
        member_assigned:      t('kanbanAutomation.descTriggerMemberAssigned'),
        card_archived:        t('kanbanAutomation.descTriggerCardArchived'),
      };
      const actionDesc: Record<string, string> = {
        add_label:     t('kanbanAutomation.descActionAddLabel', { label: labelText || labelColor }),
        remove_label:  t('kanbanAutomation.descActionRemoveLabel', { label: labelColor }),
        assign_member: t('kanbanAutomation.descActionAssignMember', { member: boardMembers.find(m => m.id === memberId)?.name ?? '?' }),
        set_due_offset:t('kanbanAutomation.descActionSetDueOffset', { days: parseInt(daysOffset) || 3 }),
        move_card:     t('kanbanAutomation.descActionMoveCard', { list: lists.find(l => l.id === targetListId)?.title ?? '?' }),
        archive_card:  t('kanbanAutomation.descActionArchiveCard'),
        send_webhook:  t('kanbanAutomation.descActionSendWebhook'),
        execute_flow:  t('kanbanAutomation.descActionExecuteFlow', { name: flowName || '?' }),
        open_app:      t('kanbanAutomation.descActionOpenApp', { name: appName || '?', mode: openMode }),
      };
      const description = `${triggerLabels[triggerType] ?? triggerType}: ${actionDesc[actionType] ?? actionType}`;

      const rule: KanbanAutomationRule = {
        id: `rule_${Date.now()}`,
        enabled: true,
        trigger,
        action,
        description,
      };
      onCreated(rule);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[#0c66e4] bg-slate-50 p-4 dark:border-blue-600 dark:bg-[#1a2332]">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-purple-500" />
          <p className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">{t('kanbanAutomation.newAutomation')}</p>
        </div>
        <button
          onClick={onCancel}
          className="rounded p-0.5 text-[#626f86] hover:bg-slate-200 hover:text-[#172b4d] dark:text-gray-500 dark:hover:bg-gray-600 dark:hover:text-gray-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Step indicator */}
      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => setStep('trigger')}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
            step === 'trigger'
              ? 'bg-purple-600 text-white'
              : 'bg-purple-100 text-purple-600 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-400'
          }`}
        >
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/30 text-[10px] font-bold">1</span>
          {t('kanbanAutomation.stepTrigger')}
        </button>
        <ArrowRight className="h-3 w-3 text-slate-400 dark:text-gray-500" />
        <button
          onClick={() => canProceedToAction && setStep('action')}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
            step === 'action'
              ? 'bg-blue-600 text-white'
              : canProceedToAction
                ? 'bg-blue-100 text-blue-600 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400'
                : 'cursor-not-allowed bg-slate-100 text-slate-400 dark:bg-gray-700 dark:text-gray-500'
          }`}
        >
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/30 text-[10px] font-bold">2</span>
          {t('kanbanAutomation.stepAction')}
        </button>
      </div>

      {/* Step 1: Trigger */}
      {step === 'trigger' && (
        <div className="space-y-3">
          <div className="rounded-lg bg-purple-50 p-3 dark:bg-purple-900/10">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-purple-600 dark:text-purple-400">
              {t('kanbanAutomation.whenTrigger')}
            </p>
            <select
              value={triggerType}
              onChange={e => setTriggerType(e.target.value as KanbanAutomationTrigger['type'])}
              className="mb-2 w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-purple-400 dark:border-purple-800 dark:bg-[#282e33] dark:text-gray-200"
            >
              <option value="card_moved_to_list">{t('kanbanAutomation.triggerCardMovedToList')}</option>
              <option value="card_created">{t('kanbanAutomation.triggerCardCreated')}</option>
              <option value="due_date_approaching">{t('kanbanAutomation.triggerDueDateApproaching')}</option>
              <option value="checklist_completed">{t('kanbanAutomation.triggerChecklistCompleted')}</option>
              <option value="label_added">{t('kanbanAutomation.triggerLabelAdded')}</option>
              <option value="member_assigned">{t('kanbanAutomation.triggerMemberAssigned')}</option>
              <option value="card_archived">{t('kanbanAutomation.triggerCardArchived')}</option>
              <option value="card_unblocked">{t('kanbanAutomation.triggerCardUnblocked')}</option>
            </select>

            {triggerNeedsListId && (
              <select
                value={triggerListId}
                onChange={e => setTriggerListId(e.target.value)}
                className="w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-purple-400 dark:border-purple-800 dark:bg-[#282e33] dark:text-gray-200"
              >
                <option value="">{t('kanbanAutomation.selectList')}</option>
                {lists.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
              </select>
            )}
          </div>

          <button
            onClick={() => setStep('action')}
            disabled={!canProceedToAction}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-40"
          >
            {t('kanbanAutomation.nextAction')} <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Step 2: Action */}
      {step === 'action' && (
        <div className="space-y-3">
          <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-900/10">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-400">
              {t('kanbanAutomation.doThisAutomatically')}
            </p>
            <select
              value={actionType}
              onChange={e => setActionType(e.target.value as KanbanAutomationAction['type'])}
              className="mb-3 w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
            >
              <option value="add_label">{t('kanbanAutomation.actionAddLabel')}</option>
              <option value="remove_label">{t('kanbanAutomation.actionRemoveLabel')}</option>
              <option value="assign_member">{t('kanbanAutomation.actionAssignMember')}</option>
              <option value="set_due_offset">{t('kanbanAutomation.actionSetDueOffset')}</option>
              <option value="move_card">{t('kanbanAutomation.actionMoveCard')}</option>
              <option value="archive_card">{t('kanbanAutomation.actionArchiveCard')}</option>
              <option value="send_webhook">{t('kanbanAutomation.actionSendWebhook')}</option>
              <option value="execute_flow">{t('kanbanAutomation.actionExecuteFlow')}</option>
              <option value="open_app">{t('kanbanAutomation.actionOpenApp')}</option>
            </select>

            {/* Action-specific inputs */}
            {(actionType === 'add_label' || actionType === 'remove_label') && (
              <div className="space-y-2">
                <p className="text-xs text-blue-600 dark:text-blue-400">{t('kanbanAutomation.labelColor')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {LABEL_PALETTE.map(c => (
                    <button
                      key={c}
                      onClick={() => setLabelColor(c)}
                      title={c}
                      className="h-6 w-6 flex-shrink-0 rounded-md transition-transform hover:scale-110"
                      style={{ background: c, outline: labelColor === c ? '3px solid #579dff' : 'none', outlineOffset: '2px' }}
                    />
                  ))}
                </div>
                {actionType === 'add_label' && (
                  <input
                    value={labelText}
                    onChange={e => setLabelText(e.target.value)}
                    placeholder={t('kanbanAutomation.labelNameOptional')}
                    className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
                  />
                )}
              </div>
            )}

            {actionType === 'assign_member' && (
              <select
                value={memberId}
                onChange={e => setMemberId(e.target.value)}
                className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
              >
                <option value="">{t('kanbanAutomation.selectMember')}</option>
                {boardMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}

            {actionType === 'set_due_offset' && (
              <div className="flex items-center gap-2">
                <input
                  type="number" min="1"
                  value={daysOffset}
                  onChange={e => setDaysOffset(e.target.value)}
                  className="w-20 rounded-lg border border-blue-200 bg-white px-3 py-2 text-center text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
                />
                <span className="text-sm text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.daysFromToday')}</span>
              </div>
            )}

            {actionType === 'move_card' && (
              <select
                value={targetListId}
                onChange={e => setTargetListId(e.target.value)}
                className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
              >
                <option value="">{t('kanbanAutomation.selectDestinationList')}</option>
                {lists.filter(l => !l.isArchived).map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
              </select>
            )}

            {actionType === 'send_webhook' && (
              <input
                value={webhookUrl}
                onChange={e => setWebhookUrl(e.target.value)}
                placeholder="https://hooks.example.com/..."
                className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
              />
            )}

            {actionType === 'execute_flow' && (
              <div className="space-y-1">
                <select
                  value={flowId}
                  onChange={e => {
                    const id = e.target.value;
                    setFlowId(id);
                    setFlowName(availableFlows.find(f => f.id === id)?.name ?? '');
                  }}
                  onFocus={() => {
                    if (!flowsLoaded) {
                      kanbanService.listAvailableFlows()
                        .then(flows => { setAvailableFlows(flows); setFlowsLoaded(true); })
                        .catch(() => toast.error(t('kanbanAutomation.errorLoadingFlows')));
                    }
                  }}
                  className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
                >
                  <option value="">{t('kanbanAutomation.selectFlow')}</option>
                  {availableFlows.filter(f => f.status === 'active').map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                  {availableFlows.filter(f => f.status !== 'active').length > 0 && (
                    <optgroup label={t('kanbanAutomation.inactiveFlows')}>
                      {availableFlows.filter(f => f.status !== 'active').map(f => (
                        <option key={f.id} value={f.id}>{f.name} ({f.status})</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="text-[10px] text-[#8590a2] dark:text-gray-500">
                  {t('kanbanAutomation.flowReceivesInfo')}
                </p>
              </div>
            )}

            {actionType === 'open_app' && (
              <div className="space-y-2">
                <select
                  value={appId}
                  onChange={e => {
                    const id = e.target.value;
                    setAppId(id);
                    setAppName(availableApps.find(a => a.id === id)?.name ?? '');
                  }}
                  onFocus={() => {
                    if (!appsLoaded) {
                      kanbanService.listAvailableApps()
                        .then(apps => { setAvailableApps(apps); setAppsLoaded(true); })
                        .catch(() => toast.error(t('kanbanAutomation.errorLoadingApps')));
                    }
                  }}
                  className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
                >
                  <option value="">{t('kanbanAutomation.selectApp')}</option>
                  {availableApps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <input
                  value={appPageSlug}
                  onChange={e => setAppPageSlug(e.target.value)}
                  placeholder={t('kanbanAutomation.pageSlugOptional')}
                  className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
                />
                <select
                  value={openMode}
                  onChange={e => setOpenMode(e.target.value as 'dialog' | 'new_tab' | 'sidebar')}
                  className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-[#172b4d] outline-none focus:border-blue-400 dark:border-blue-800 dark:bg-[#282e33] dark:text-gray-200"
                >
                  <option value="dialog">{t('kanbanAutomation.openModeDialog')}</option>
                  <option value="new_tab">{t('kanbanAutomation.openModeNewTab')}</option>
                  <option value="sidebar">{t('kanbanAutomation.openModeSidebar')}</option>
                </select>
              </div>
            )}
          </div>

          {/* Preview sentence */}
          {canSave && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 dark:border-emerald-800 dark:bg-emerald-900/10">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p className="text-xs text-emerald-700 dark:text-emerald-300">
                {t('kanbanAutomation.previewWhen')} {triggerType === 'card_moved_to_list' || triggerType === 'card_created'
                  ? lists.find(l => l.id === triggerListId)?.title
                    ? `"${lists.find(l => l.id === triggerListId)!.title}"`
                    : t('kanbanAutomation.selectedList')
                  : triggerType.replace(/_/g, ' ')
                } → {actionType.replace(/_/g, ' ')}
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => setStep('trigger')}
              className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-[#44546f] hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-600"
            >
              <ChevronUp className="h-4 w-4" /> {t('kanbanAutomation.back')}
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={!canSave || saving}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#0c66e4] py-2 text-sm font-semibold text-white hover:bg-[#0055cc] disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {t('kanbanAutomation.createRule')}
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg px-3 py-2 text-sm text-[#44546f] hover:bg-slate-100 dark:text-gray-400 dark:hover:bg-gray-600"
            >
              {t('kanbanAutomation.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

interface KanbanAutomationPanelProps {
  board: { id: string; automationRules: KanbanAutomationRule[] };
  lists: KanbanList[];
  boardMembers: KanbanBoardMember[];
  automationActivities: KanbanActivity[];
  butlerInput: string;
  butlerParsing: boolean;
  onButlerInputChange: (v: string) => void;
  onParseButlerRule: () => void;
  onToggleRule: (ruleId: string) => void;
  onDeleteRule: (ruleId: string) => void;
  onAddRule: (rule: KanbanAutomationRule) => void;
}

export function KanbanAutomationPanel({
  board,
  lists,
  boardMembers,
  automationActivities,
  butlerInput,
  butlerParsing,
  onButlerInputChange,
  onParseButlerRule,
  onToggleRule,
  onDeleteRule,
  onAddRule,
}: KanbanAutomationPanelProps) {
  const { t } = useTranslation('common');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showTemplates, setShowTemplates] = useState(true);

  const automationRules = board.automationRules ?? [];
  const activeCount = automationRules.filter(r => r.enabled).length;

  const handleRuleCreated = (rule: KanbanAutomationRule) => {
    onAddRule(rule);
    setShowAddForm(false);
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">{t('kanbanAutomation.automations')}</h3>
          {automationRules.length > 0 && (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
              {t('kanbanAutomation.activeCount', { count: activeCount })}
            </span>
          )}
        </div>
        {!showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1 rounded-lg bg-[#0c66e4] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#0055cc]"
          >
            <Plus className="h-3.5 w-3.5" /> {t('kanbanAutomation.newRule')}
          </button>
        )}
      </div>

      <div className="mb-3 border-b border-slate-200 dark:border-gray-700" />

      {/* Section: Butler IA */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.butlerAI')}</span>
        <div className="h-px flex-1 bg-[#e2e6ea] dark:bg-[#3b4754]" />
      </div>

      {/* Butler NLP */}
      <div className="mb-4 rounded-xl border border-[#579dff]/30 bg-[#f0f6ff] p-3 dark:border-blue-700/30 dark:bg-[#0d1b2a]">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[#579dff]" />
          <span className="text-xs font-semibold text-[#0c66e4] dark:text-[#85b8ff]">{t('kanbanAutomation.butlerCreateRule')}</span>
        </div>
        <textarea
          value={butlerInput}
          onChange={e => onButlerInputChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onParseButlerRule(); } }}
          placeholder={t('kanbanAutomation.butlerPlaceholder')}
          rows={3}
          className="mb-2 w-full resize-none rounded-lg border border-[#579dff]/40 bg-white px-3 py-2 text-xs text-[#172b4d] outline-none placeholder-[#8590a2] dark:border-blue-700/40 dark:bg-gray-800 dark:text-gray-200 dark:placeholder-gray-500"
        />
        <button
          onClick={onParseButlerRule}
          disabled={butlerParsing || !butlerInput.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-[#0c66e4] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0055cc] disabled:opacity-50"
        >
          {butlerParsing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {t('kanbanAutomation.createRule')}
        </button>
      </div>

      {/* Add rule form */}
      {showAddForm && (
        <div className="mb-4">
          <AddRuleForm
            lists={lists}
            boardMembers={boardMembers}
            boardId={board.id}
            onCreated={handleRuleCreated}
            onCancel={() => setShowAddForm(false)}
            t={t}
          />
        </div>
      )}

      {/* Section: Suas regras */}
      {automationRules.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.yourRules')}</span>
          <div className="h-px flex-1 bg-[#e2e6ea] dark:bg-[#3b4754]" />
        </div>
      )}

      {/* Existing rules */}
      {automationRules.length > 0 && (
        <div className="mb-4 space-y-2">
          {automationRules.map(rule => (
            <RuleCard
              key={rule.id}
              rule={rule}
              lists={lists}
              boardMembers={boardMembers}
              activities={automationActivities}
              onToggle={onToggleRule}
              onDelete={onDeleteRule}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Empty state + templates */}
      {automationRules.length === 0 && !showAddForm && (
        <div>
          <div className="mb-5 flex flex-col items-center py-4 text-center">
            <Zap className="mb-2 h-8 w-8 opacity-40 text-[#8590a2] dark:text-gray-500" />
            <p className="text-sm font-medium text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.noAutomations')}</p>
            <p className="mt-1 text-xs text-[#8590a2] dark:text-gray-500">
              {t('kanbanAutomation.automationsDescription')}
            </p>
          </div>

          {/* Section: Começar por template */}
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.startFromTemplate')}</span>
            <div className="h-px flex-1 bg-[#e2e6ea] dark:bg-[#3b4754]" />
            <button
              onClick={() => setShowTemplates(v => !v)}
              className="ml-1 flex-shrink-0 text-[#626f86] hover:text-[#172b4d] dark:text-gray-400 dark:hover:text-gray-200"
              title={showTemplates ? t('kanbanAutomation.collapseTemplates') : t('kanbanAutomation.expandTemplates')}
            >
              {showTemplates ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          </div>

          {showTemplates && (
            <div className="space-y-2">
              {/* Template 1 */}
              <button
                onClick={() => {
                  const doneList = lists.find(l =>
                    l.title.toLowerCase().includes('done') ||
                    l.title.toLowerCase().includes('concluí') ||
                    l.title.toLowerCase().includes('finaliz')
                  );
                  onButlerInputChange(t('kanbanAutomation.butlerTemplateArchive', { list: doneList?.title ?? 'Done' }));
                  onParseButlerRule();
                }}
                className="flex w-full items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-all hover:border-purple-300 hover:bg-purple-50 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-purple-600 dark:hover:bg-purple-900/10"
              >
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                  <Archive className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#172b4d] dark:text-gray-200">
                    {t('kanbanAutomation.templateMovedDoneArchive')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.templateMovedDoneArchiveDesc')}</p>
                </div>
              </button>

              {/* Template 2 */}
              <button
                onClick={() => {
                  const backlogList = lists.find(l =>
                    l.title.toLowerCase().includes('backlog') ||
                    l.title.toLowerCase().includes('to do') ||
                    l.title.toLowerCase().includes('a fazer')
                  );
                  onButlerInputChange(t('kanbanAutomation.butlerTemplateDueDate', { list: backlogList?.title ?? 'Backlog' }));
                  onParseButlerRule();
                }}
                className="flex w-full items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-all hover:border-blue-300 hover:bg-blue-50 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-blue-600 dark:hover:bg-blue-900/10"
              >
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                  <Calendar className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#172b4d] dark:text-gray-200">
                    {t('kanbanAutomation.templateCreatedBacklogDueDate')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.templateCreatedBacklogDueDateDesc')}</p>
                </div>
              </button>

              {/* Template 3 */}
              <button
                onClick={() => {
                  onButlerInputChange(t('kanbanAutomation.butlerTemplateLabelUrgent'));
                  onParseButlerRule();
                }}
                className="flex w-full items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-all hover:border-red-300 hover:bg-red-50 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-red-600 dark:hover:bg-red-900/10"
              >
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-red-100 dark:bg-red-900/30">
                  <AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#172b4d] dark:text-gray-200">
                    {t('kanbanAutomation.templateDueApproachingLabel')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.templateDueApproachingLabelDesc')}</p>
                </div>
              </button>

              {/* Template 4 */}
              <button
                onClick={() => {
                  const nextList = lists.length > 1 ? lists[1] : lists[0];
                  onButlerInputChange(t('kanbanAutomation.butlerTemplateChecklistMove', { list: nextList?.title ?? 'next list' }));
                  onParseButlerRule();
                }}
                className="flex w-full items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-all hover:border-emerald-300 hover:bg-emerald-50 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-emerald-600 dark:hover:bg-emerald-900/10"
              >
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#172b4d] dark:text-gray-200">
                    {t('kanbanAutomation.templateChecklistMove')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.templateChecklistMoveDesc')}</p>
                </div>
              </button>

              {/* Template 5 */}
              <button
                onClick={() => {
                  onButlerInputChange(t('kanbanAutomation.butlerTemplateAssignMember', { member: boardMembers[0]?.name ?? 'default' }));
                  onParseButlerRule();
                }}
                className="flex w-full items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-all hover:border-amber-300 hover:bg-amber-50 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-amber-600 dark:hover:bg-amber-900/10"
              >
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                  <Users className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#172b4d] dark:text-gray-200">
                    {t('kanbanAutomation.templateCreatedAssign')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.templateCreatedAssignDesc')}</p>
                </div>
              </button>

              {/* Template 6 — execute_flow */}
              <button
                onClick={() => {
                  onButlerInputChange(t('kanbanAutomation.butlerTemplateExecuteFlow'));
                  onParseButlerRule();
                }}
                className="flex w-full items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-all hover:border-violet-300 hover:bg-violet-50 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-violet-600 dark:hover:bg-violet-900/10"
              >
                <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-900/30">
                  <GitBranch className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#172b4d] dark:text-gray-200">
                    {t('kanbanAutomation.templateMovedReviewFlow')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[#626f86] dark:text-gray-400">{t('kanbanAutomation.templateMovedReviewFlowDesc')}</p>
                </div>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Add another rule button (when rules exist but form is closed) */}
      {automationRules.length > 0 && !showAddForm && (
        <button
          onClick={() => setShowAddForm(true)}
          className="mt-1 flex w-full items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-[#44546f] hover:bg-slate-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600"
        >
          <Plus className="h-4 w-4" /> {t('kanbanAutomation.addAutomationRule')}
        </button>
      )}
    </div>
  );
}
