import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Plus,
  Search,
  ArrowUp,
  Square,
  X,
  FileText,
  Image as ImageIcon,
  Paperclip,
} from 'lucide-react';
import {
  invoke,
  storePastedText,
  storeImage,
  storeFilePath,
  listProjectFiles,
  settingsApi,
  dialogApi,
} from '../../ipc/client';
import { useChatStore } from '../../store';
import * as CH from '@shared/channels';
import { useVim, loadVimEnabled, setVimEnabled } from '../../hooks/useVim';
import { ModelConfigPicker } from '../common/ModelConfigPicker';
import { SlashCommandPicker, type SlashPickerHandle } from './SlashCommandPicker';
import type { SettingsDTO } from '@shared/types';

// Defaults preserved from the historical hard-coded constants — applied
// when settings.json doesn't override them so existing installs feel the
// same after upgrade.
const PASTE_LINE_THRESHOLD_DEFAULT = 5;
const PASTE_CHAR_THRESHOLD_DEFAULT = 800;
const AT_FILE_MAX_RESULTS_DEFAULT = 20;

type AttachmentChip =
  | { kind: 'paste'; id: number; lines: number; preview?: string }
  | { kind: 'image'; id: number; mime: string; bytes: number; thumbUrl?: string }
  | { kind: 'file'; id: number; name: string; lines: number };

async function makeThumbnail(
  buf: ArrayBuffer,
  mime: string,
  maxDim = 64,
): Promise<string | undefined> {
  try {
    const blob = new Blob([buf], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('image decode failed'));
        i.src = url;
      });
      const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return undefined;
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL('image/webp', 0.7);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return undefined;
  }
}

async function tryThumbnailFromFile(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) return undefined;
  try {
    const buf = await file.arrayBuffer();
    return await makeThumbnail(buf, file.type);
  } catch {
    return undefined;
  }
}

function insertAtCursor(
  el: HTMLTextAreaElement,
  current: string,
  replacement: string,
): { next: string; nextCursor: number } {
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  const next = current.slice(0, start) + replacement + current.slice(end);
  return { next, nextCursor: start + replacement.length };
}

// ── localStorage key para history persistente entre reloads ────────────
const HISTORY_KEY = 'makestudio:input:history';
const HISTORY_MAX = 500;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushHistory(entry: string): string[] {
  const cur = loadHistory();
  if (cur[cur.length - 1] === entry) return cur;
  const next = [...cur, entry].slice(-HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* quota — ignore */
  }
  return next;
}

interface Props {
  variant?: 'welcome' | 'chat';
}

export function InputBox({ variant = 'chat' }: Props = {}): React.ReactElement {
  // Settings — drives paste thresholds and @file picker behaviour. The
  // defaults are baked into the destructure so the first render (before
  // the query resolves) still uses sane numbers.
  const settingsQuery = useQuery<SettingsDTO>({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get(),
    staleTime: 60_000,
  });
  const pasteAutoMarker = settingsQuery.data?.inputPaste?.autoMarker !== false; // default true
  const pasteLineThreshold =
    settingsQuery.data?.inputPaste?.markerThresholdLines ?? PASTE_LINE_THRESHOLD_DEFAULT;
  const pasteCharThreshold =
    settingsQuery.data?.inputPaste?.markerThresholdChars ?? PASTE_CHAR_THRESHOLD_DEFAULT;
  const atFileEnabled = settingsQuery.data?.inputAtFile?.enabled !== false; // default true
  const atFileMaxResults =
    settingsQuery.data?.inputAtFile?.maxResults ?? AT_FILE_MAX_RESULTS_DEFAULT;

  const [value, setValue] = useState('');
  const [draft, setDraft] = useState('');
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIdx, setSearchIdx] = useState(-1);
  const [escArmed, setEscArmed] = useState(false);
  const [vimEnabled, setVimEnabledState] = useState(() => loadVimEnabled());
  const [completions, setCompletions] = useState<string[]>([]);
  const [completionIdx, setCompletionIdx] = useState(0);

  const busy = useChatStore((s) => s.busy);

  // Attachment chips (paste/image/file) — sincronizam com markers no texto.
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
  // Attach popover
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLDivElement>(null);
  // Drag-and-drop visual hint
  const [dragActive, setDragActive] = useState(false);
  // @file completion popover
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const [fileQuery, setFileQuery] = useState<string | null>(null);
  // Range do `@query` no textarea (pra substituir ao aceitar)
  const fileQueryRangeRef = useRef<{ start: number; end: number } | null>(null);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<string[]>(loadHistory());

  // Close attach popover on outside click
  useEffect(() => {
    if (!attachOpen) return;
    const handler = (e: MouseEvent) => {
      if (attachRef.current && !attachRef.current.contains(e.target as Node)) {
        setAttachOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [attachOpen]);

  const escTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastSubmitRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });

  // Auto-resize do textarea conforme conteúdo.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxH = 220;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }, [value, searchMode, searchQuery]);

  // Submit — bloqueia quando busy (user precisa Esc-esc pra cancelar primeiro)
  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (busy) return;

      // Debounce accidental double-enter.
      const now = Date.now();
      if (
        lastSubmitRef.current.value === trimmed &&
        now - lastSubmitRef.current.at < 400
      ) {
        return;
      }
      lastSubmitRef.current = { value: trimmed, at: now };

      // Hidden trigger: /order66 fires the easter egg overlay and is
      // swallowed before reaching the agent (no echo, no submit).
      if (/^\/order66\b/i.test(trimmed)) {
        setValue('');
        setHistoryIdx(-1);
        setDraft('');
        setCompletions([]);
        setAttachments([]);
        window.dispatchEvent(new CustomEvent('makestudio:order66'));
        return;
      }

      setValue('');
      setHistoryIdx(-1);
      setDraft('');
      setCompletions([]);
      setAttachments([]);
      historyRef.current = pushHistory(trimmed);

      // Eco local da user message — o agent core (chat.ts) não publica
      // EVT_MESSAGE_ADD pra role 'user' (no TUI Ink isso era visível
      // direto pelo readline). Sem este push, o renderer fica em branco
      // até o assistant responder.
      useChatStore.getState().addMessage({
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        text: trimmed,
        timestamp: Date.now(),
      });

      // VS Code embed: if an active editor is pinned, prepend a
      // context block so the LLM not only knows which file the user is
      // looking at but treats it as the default subject of the request.
      // Lives only in the wire payload; the local echo above keeps the
      // clean text the user typed. The user can drop the pin via the
      // chip's X button when they want a workspace-wide request instead.
      const pinned = useChatStore.getState().activeFile;
      const wirePayload = pinned
        ? `[Active file in the editor: ${pinned.path}]\n` +
          `Unless I clearly ask for something else, treat this file as the ` +
          `subject of my request and operate on it directly.\n\n${trimmed}`
        : trimmed;

      try {
        const res = (await invoke(CH.AGENT_SUBMIT, wirePayload)) as
          | { ok: boolean; error?: string; consumedAsAnswer?: boolean }
          | undefined;
        // Main rejected the submit (most common: previous turn still
        // running — `turnInflight` stuck because a stream hung). Without
        // surfacing this, the user sees the optimistic echo of their
        // message above and waits for a response that will never come.
        if (res && res.ok === false) {
          const reason = res.error || 'unknown';
          const isBusy = reason === 'busy';
          useChatStore.getState().addMessage({
            id: `submit-rejected-${Date.now()}`,
            role: 'error',
            text: isBusy
              ? 'Turn anterior ainda rodando — clique em Stop pra abortar antes de enviar a próxima mensagem.'
              : `Submit rejeitado: ${reason}`,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[agent:submit] failed', err);
        useChatStore.getState().addMessage({
          id: `submit-err-${Date.now()}`,
          role: 'error',
          text: `Falha ao enviar: ${(err as Error)?.message ?? err}`,
          timestamp: Date.now(),
        });
      }
    },
    [busy],
  );

  // Reconcilia chips com markers presentes no texto — se user apaga
  // [Pasted text #N] / [Image #N] manualmente, o chip some.
  useEffect(() => {
    if (attachments.length === 0) return;
    const next = attachments.filter((att) => {
      if (att.kind === 'paste' || att.kind === 'file') {
        return new RegExp(`\\[Pasted text #${att.id} `).test(value);
      }
      // image
      return new RegExp(`\\[Image #${att.id}\\]`).test(value);
    });
    if (next.length !== attachments.length) setAttachments(next);
  }, [value, attachments]);

  const removeAttachment = useCallback(
    (chip: AttachmentChip) => {
      const marker =
        chip.kind === 'image'
          ? new RegExp(`\\s?\\[Image #${chip.id}\\]\\s?`)
          : new RegExp(`\\s?\\[Pasted text #${chip.id} \\+\\d+ lines\\]\\s?`);
      setValue((cur) => cur.replace(marker, ''));
      setAttachments((cur) => cur.filter((c) => !(c.kind === chip.kind && c.id === chip.id)));
    },
    [],
  );

  const insertMarker = useCallback((marker: string) => {
    const el = taRef.current;
    if (!el) {
      setValue((cur) => cur + marker);
      return;
    }
    setValue((cur) => {
      const { next, nextCursor } = insertAtCursor(el, cur, marker);
      requestAnimationFrame(() => {
        el.selectionStart = nextCursor;
        el.selectionEnd = nextCursor;
        el.focus();
      });
      return next;
    });
  }, []);

  const openImagePicker = useCallback(async () => {
    setAttachOpen(false);
    const paths = await dialogApi.openImages();
    for (const fpath of paths) {
      try {
        const res = await storeFilePath(fpath);
        if (!res.ok) continue;
        if (res.kind === 'image') {
          insertMarker(`[Image #${res.id}] `);
          setAttachments((cur) => [...cur, { kind: 'image', id: res.id, mime: res.mime, bytes: res.bytes, thumbUrl: undefined }]);
        }
      } catch { /* ignore */ }
    }
  }, [insertMarker]);

  const openFilePicker = useCallback(async () => {
    setAttachOpen(false);
    const paths = await dialogApi.openFiles();
    for (const fpath of paths) {
      try {
        const res = await storeFilePath(fpath);
        if (!res.ok) continue;
        if (res.kind === 'text') {
          const marker = `[Pasted text #${res.id} +${res.lines} lines]`;
          insertMarker(marker + ' ');
          setAttachments((cur) => [...cur, { kind: 'file', id: res.id, name: res.name, lines: res.lines }]);
        } else if (res.kind === 'image') {
          insertMarker(`[Image #${res.id}] `);
          setAttachments((cur) => [...cur, { kind: 'image', id: res.id, mime: res.mime, bytes: res.bytes, thumbUrl: undefined }]);
        }
      } catch { /* ignore */ }
    }
  }, [insertMarker]);

  // ── Paste handler — image vs large text vs default ──────────────────
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const cd = e.clipboardData;
      // 1) imagem
      const items = cd?.items ? Array.from(cd.items) : [];
      const imageItem = items.find(
        (it) => it.kind === 'file' && it.type.startsWith('image/'),
      );
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (file) {
          e.preventDefault();
          void (async () => {
            try {
              const buf = await file.arrayBuffer();
              const mime = file.type || 'image/png';
              const [res, thumbUrl] = await Promise.all([
                storeImage(buf, mime),
                makeThumbnail(buf, mime),
              ]);
              if (res.ok) {
                insertMarker(`[Image #${res.id}] `);
                setAttachments((cur) => [
                  ...cur,
                  {
                    kind: 'image',
                    id: res.id,
                    mime: res.mime,
                    bytes: res.bytes,
                    thumbUrl,
                  },
                ]);
              }
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('[paste:image] failed', err);
            }
          })();
          return;
        }
      }
      // 2) texto longo → paste marker
      const text = cd?.getData('text') ?? '';
      const lines = text.split('\n').length;
      if (
        pasteAutoMarker &&
        (text.length >= pasteCharThreshold || lines >= pasteLineThreshold)
      ) {
        e.preventDefault();
        void (async () => {
          try {
            const ref = await storePastedText(text);
            const marker = `[Pasted text #${ref.id} +${ref.lines} lines]`;
            insertMarker(marker + ' ');
            setAttachments((cur) => [
              ...cur,
              {
                kind: 'paste',
                id: ref.id,
                lines: ref.lines,
                preview: text.slice(0, 80).replace(/\s+/g, ' '),
              },
            ]);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[paste:text] failed', err);
          }
        })();
      }
      // senão: default browser paste
    },
    [insertMarker, pasteAutoMarker, pasteCharThreshold, pasteLineThreshold],
  );

  // ── Drag-and-drop ───────────────────────────────────────────────────
  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      for (const file of files) {
        const fpath = (file as File & { path?: string }).path;
        try {
          if (fpath) {
            const [res, thumbUrl] = await Promise.all([
              storeFilePath(fpath),
              tryThumbnailFromFile(file),
            ]);
            if (!res.ok) continue;
            if (res.kind === 'image') {
              insertMarker(`[Image #${res.id}] `);
              setAttachments((cur) => [
                ...cur,
                { kind: 'image', id: res.id, mime: res.mime, bytes: res.bytes, thumbUrl },
              ]);
            } else if (res.kind === 'text') {
              const marker = `[Pasted text #${res.id} +${res.lines} lines]`;
              insertMarker(marker + ' ');
              setAttachments((cur) => [
                ...cur,
                {
                  kind: 'file',
                  id: res.id,
                  name: res.name,
                  lines: res.lines,
                },
              ]);
            }
          } else if (file.type.startsWith('image/')) {
            // Browser drop — sem path, manda buffer.
            const buf = await file.arrayBuffer();
            const [res, thumbUrl] = await Promise.all([
              storeImage(buf, file.type),
              makeThumbnail(buf, file.type),
            ]);
            if (res.ok) {
              insertMarker(`[Image #${res.id}] `);
              setAttachments((cur) => [
                ...cur,
                { kind: 'image', id: res.id, mime: res.mime, bytes: res.bytes, thumbUrl },
              ]);
            }
          } else {
            // Texto puro
            const text = await file.text();
            const ref = await storePastedText(text);
            const marker = `[Pasted text #${ref.id} +${ref.lines} lines]`;
            insertMarker(marker + ' ');
            setAttachments((cur) => [
              ...cur,
              { kind: 'file', id: ref.id, name: file.name, lines: ref.lines },
            ]);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[drop] failed', err);
        }
      }
    },
    [insertMarker],
  );

  // ── @file completion — detecta @token contíguo no caret ────────────
  // Mantém o popover aberto enquanto o user digita; fecha ao acabar a palavra.
  const refreshFileCompletions = useCallback(async () => {
    if (!atFileEnabled) {
      // Picker disabled in settings — keep `@token` as plain text and
      // ensure no stale popover stays open.
      setFileQuery(null);
      setFileResults([]);
      fileQueryRangeRef.current = null;
      return;
    }
    const el = taRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    const before = value.slice(0, caret);
    const m = /(^|\s)@([\w./-]*)$/.exec(before);
    if (!m) {
      setFileQuery(null);
      setFileResults([]);
      fileQueryRangeRef.current = null;
      return;
    }
    const query = m[2] ?? '';
    const start = caret - query.length - 1; // -1 do `@`
    fileQueryRangeRef.current = { start, end: caret };
    setFileQuery(query);
    try {
      const list = await listProjectFiles(query, atFileMaxResults);
      setFileResults(list);
      setFileIdx(0);
    } catch {
      setFileResults([]);
    }
  }, [value, atFileEnabled, atFileMaxResults]);

  useEffect(() => {
    void refreshFileCompletions();
  }, [refreshFileCompletions]);

  const acceptFileCompletion = useCallback(
    (relPath: string) => {
      const range = fileQueryRangeRef.current;
      const el = taRef.current;
      if (!el || !range) {
        setFileQuery(null);
        setFileResults([]);
        return;
      }
      const before = value.slice(0, range.start);
      const after = value.slice(range.end);
      const inserted = `@${relPath} `;
      const next = before + inserted + after;
      const cursor = before.length + inserted.length;
      setValue(next);
      setFileQuery(null);
      setFileResults([]);
      fileQueryRangeRef.current = null;
      requestAnimationFrame(() => {
        el.selectionStart = cursor;
        el.selectionEnd = cursor;
        el.focus();
      });
    },
    [value],
  );

  // Tab completion — fetch quando input começa com "/" e não tem espaço
  const fetchCompletions = useCallback(async (): Promise<string[]> => {
    const prefix = value.trim();
    if (!prefix.startsWith('/') || prefix.includes(' ')) return [];
    try {
      return await invoke<string, string[]>(CH.AGENT_COMPLETIONS, prefix);
    } catch {
      return [];
    }
  }, [value]);

  const applyCompletion = useCallback((cmd: string) => {
    setValue(cmd + ' ');
    setCompletions([]);
    setCompletionIdx(0);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      const pos = cmd.length + 1;
      el.selectionStart = pos;
      el.selectionEnd = pos;
      el.focus();
    });
  }, []);

  const abort = useCallback(async () => {
    try {
      await invoke(CH.AGENT_ABORT);
    } catch {
      /* */
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      await invoke(CH.AGENT_CLEAR);
    } catch {
      /* */
    }
  }, []);

  // Vim state machine — consome eventos antes do resto se habilitado
  const vim = useVim({
    enabled: vimEnabled,
    taRef,
    onChangeValue: setValue,
    onSubmit: submit,
  });

  // Slash command picker — abre quando o input começa com "/" e ainda
  // não tem espaço (estamos digitando o nome do comando).
  const slashPickerRef = useRef<SlashPickerHandle | null>(null);
  const slashOpen = React.useMemo(() => {
    const trimmed = value.trimStart();
    return trimmed.startsWith('/') && !trimmed.includes(' ') && !trimmed.includes('\n');
  }, [value]);
  const slashQuery = value.trimStart();

  const onSlashSelect = useCallback(
    (cmd: { name: string; args?: string }) => {
      // Substitui só a primeira "palavra" (o que digitou após "/") pelo
      // comando completo. Mantém o resto do texto se houver.
      const trimmed = value.trimStart();
      const firstSpace = trimmed.search(/\s/);
      const rest = firstSpace >= 0 ? trimmed.slice(firstSpace) : '';

      // Auto-submit when the command takes no args AND the user hasn't
      // typed anything after the slash word yet — Enter on the picker is
      // expected to RUN /cost, /version, /trust, etc. directly. Before
      // we just inserted the name and parked the caret, leaving a
      // confusing dead Enter (user pressed Enter twice to actually run).
      if (!cmd.args && !rest) {
        setValue('');
        submit(cmd.name);
        return;
      }

      // Otherwise: insert the command and let the user type / accept the
      // remaining args before submitting.
      const next = `${cmd.name}${cmd.args ? ' ' : ''}${rest}`;
      setValue(next);
      // Foca o textarea e move o caret pro fim do nome (antes dos args, se houver).
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        const pos = cmd.name.length + (cmd.args ? 1 : 0);
        try {
          ta.setSelectionRange(pos, pos);
        } catch {
          /* */
        }
      });
    },
    [value, submit],
  );

  // Keydown
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Slash picker tem prioridade — captura ↑↓ Enter Tab Esc quando aberto
      if (slashOpen && slashPickerRef.current?.handleKeyDown(e)) {
        return;
      }

      // Vim primeiro — se consumiu o key, aborta o resto
      if (vim.handleKey(e)) {
        e.preventDefault();
        return;
      }

      // Reverse search — Ctrl+R
      if (e.ctrlKey && e.key.toLowerCase() === 'r' && !searchMode) {
        e.preventDefault();
        setSearchMode(true);
        setSearchQuery('');
        setSearchIdx(historyRef.current.length - 1);
        return;
      }

      if (searchMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setSearchMode(false);
          setSearchQuery('');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const hit = findMatch(historyRef.current, searchQuery, searchIdx);
          if (hit) {
            setValue(hit.entry);
            setHistoryIdx(hit.idx);
          }
          setSearchMode(false);
          return;
        }
        if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
          e.preventDefault();
          const hit = findMatch(historyRef.current, searchQuery, searchIdx - 1);
          if (hit) setSearchIdx(hit.idx);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const hit = findMatch(
            historyRef.current,
            searchQuery,
            searchIdx + 1,
            'forward',
          );
          if (hit) setSearchIdx(hit.idx);
          return;
        }
        if (e.key === 'Backspace') {
          setSearchQuery((q) => q.slice(0, -1));
          return;
        }
        if (e.key.length === 1) {
          e.preventDefault();
          setSearchQuery((q) => q + e.key);
          return;
        }
        return;
      }

      // Ctrl+L — clear conversation
      if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        clear();
        return;
      }

      // ── @file popover navigation ────────────────────────────────────
      if (fileQuery !== null && fileResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFileIdx((i) => (i + 1) % fileResults.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFileIdx((i) => (i - 1 + fileResults.length) % fileResults.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          acceptFileCompletion(fileResults[fileIdx] ?? fileResults[0]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setFileQuery(null);
          setFileResults([]);
          fileQueryRangeRef.current = null;
          return;
        }
      }

      // Tab — accept pending suggestion first, fall back to completions
      if (e.key === 'Tab') {
        e.preventDefault();
        // Se popover já aberto, cicla ou aceita
        if (completions.length > 0) {
          if (e.shiftKey) {
            setCompletionIdx((i) => (i - 1 + completions.length) % completions.length);
          } else {
            setCompletionIdx((i) => (i + 1) % completions.length);
          }
          return;
        }
        // Pending suggestion path: when the agent emitted "↳ suggestion: …
        // (Tab to use)" via background-tasks/schedulePromptSuggestion, the
        // string lives on the bridge until consumed. Consume on Tab when
        // the input is empty (so a user mid-sentence isn't surprised by
        // their work being overwritten). Falls through to completions if
        // nothing pending.
        void (async () => {
          if (!value.trim()) {
            try {
              const pending = await invoke<void, string | null>(CH.AGENT_SUGGESTION_CONSUME);
              if (pending) {
                setValue(pending);
                requestAnimationFrame(() => {
                  const ta = taRef.current;
                  if (ta) {
                    ta.focus();
                    try { ta.setSelectionRange(pending.length, pending.length); } catch (err) { /* */ }
                  }
                });
                return;
              }
            } catch (err) { /* IPC may be down — fall through to completions */ }
          }
          const list = await fetchCompletions();
          if (list.length === 1) {
            applyCompletion(list[0].split(' ')[0]);
          } else if (list.length > 1) {
            setCompletions(list);
            setCompletionIdx(0);
          }
        })();
        return;
      }

      // Enter quando popover de completions aberto — aceita o selected
      if (e.key === 'Enter' && completions.length > 0) {
        e.preventDefault();
        const chosen = completions[completionIdx] ?? completions[0];
        applyCompletion(chosen.split(' ')[0]);
        return;
      }

      // Esc fecha popover de completions (antes do Esc-esc de cancel)
      if (e.key === 'Escape' && completions.length > 0) {
        e.preventDefault();
        setCompletions([]);
        setCompletionIdx(0);
        return;
      }

      // Esc-esc — cancel in-flight turn
      if (e.key === 'Escape') {
        if (escArmed) {
          if (escTimerRef.current) clearTimeout(escTimerRef.current);
          escTimerRef.current = null;
          setEscArmed(false);
          if (busy) abort();
        } else if (busy) {
          setEscArmed(true);
          if (escTimerRef.current) clearTimeout(escTimerRef.current);
          escTimerRef.current = setTimeout(() => {
            setEscArmed(false);
            escTimerRef.current = null;
          }, 600);
        }
        return;
      }

      // Multi-line: Ctrl+J or Shift+Enter inserts newline; plain Enter submits.
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.shiftKey) return; // default behaviour: insert newline
        e.preventDefault();
        submit(value);
        return;
      }

      // History navigation — ArrowUp/Down when cursor is at edge
      if (e.key === 'ArrowUp') {
        const el = taRef.current;
        if (!el) return;
        const atTop = el.selectionStart === 0;
        if (!atTop) return;
        e.preventDefault();
        const hist = historyRef.current;
        if (hist.length === 0) return;
        if (historyIdx === -1) setDraft(value);
        const next = historyIdx === -1 ? hist.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(next);
        setValue(hist[next]);
        return;
      }
      if (e.key === 'ArrowDown') {
        if (historyIdx === -1) return;
        const el = taRef.current;
        if (!el) return;
        const atBottom = el.selectionStart === el.value.length;
        if (!atBottom) return;
        e.preventDefault();
        const hist = historyRef.current;
        const next = historyIdx + 1;
        if (next >= hist.length) {
          setHistoryIdx(-1);
          setValue(draft);
        } else {
          setHistoryIdx(next);
          setValue(hist[next]);
        }
      }
    },
    [
      searchMode,
      searchQuery,
      searchIdx,
      escArmed,
      busy,
      value,
      historyIdx,
      draft,
      submit,
      abort,
      clear,
      vim,
      completions,
      completionIdx,
      fetchCompletions,
      applyCompletion,
      fileQuery,
      fileResults,
      fileIdx,
      acceptFileCompletion,
      slashOpen,
    ],
  );

  const toggleVim = useCallback(() => {
    const next = !vimEnabled;
    setVimEnabledState(next);
    setVimEnabled(next);
    vim.resetToInsert();
  }, [vimEnabled, vim]);

  const lines = value.split('\n');
  const isMultiline = lines.length > 1;
  const isWelcome = variant === 'welcome';

  const searchHit = searchMode
    ? findMatch(historyRef.current, searchQuery, searchIdx)
    : null;

  return (
    <div
      className={clsx(
        'mx-auto w-full',
        // Width matches MessageList (max-w-4xl = 896px) so the input lines
        // up vertically with the chat bubbles above. Welcome screen still
        // uses the narrower max-w-3xl since there's no chat to align with.
        isWelcome ? 'max-w-3xl' : 'max-w-4xl px-6 pb-4',
      )}
    >
      {/* Esc-armed hint */}
      {escArmed && busy && (
        <div className="mb-1.5 text-[11px] text-warning">
          pressione Esc novamente pra cancelar…
        </div>
      )}

      {/* Completions popover */}
      {completions.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-md border border-border-subtle bg-surface-1/95 shadow-elev backdrop-blur">
          <div className="flex items-center justify-between border-b border-border-subtle/60 px-3 py-1.5 text-[10px] uppercase tracking-[0.13em] text-dim/70">
            <span>comandos</span>
            <span className="font-mono text-[10px] text-dim/60">
              Tab cicla · Enter aceita · Esc fecha
            </span>
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {completions.map((c, i) => (
              <button
                key={c}
                type="button"
                onClick={() => applyCompletion(c.split(' ')[0])}
                className={clsx(
                  'flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-[12.5px]',
                  i === completionIdx
                    ? 'bg-surface-3 text-text'
                    : 'text-text-soft hover:bg-surface-2',
                )}
              >
                <span className="text-primary">{c.split(' ')[0]}</span>
                {c.includes(' ') && (
                  <span className="text-dim">{c.slice(c.indexOf(' '))}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* @file completion popover */}
      {fileQuery !== null && fileResults.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-md border border-border-subtle bg-surface-1/95 shadow-elev backdrop-blur">
          <div className="flex items-center justify-between border-b border-border-subtle/60 px-3 py-1.5 text-[10px] uppercase tracking-[0.13em] text-dim/70">
            <span>arquivos do projeto</span>
            <span className="font-mono text-[10px] text-dim/60">
              ↑↓ navega · Enter/Tab aceita · Esc fecha
            </span>
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {fileResults.map((p, i) => (
              <button
                key={p}
                type="button"
                onClick={() => acceptFileCompletion(p)}
                className={clsx(
                  'flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-[12.5px]',
                  i === fileIdx
                    ? 'bg-surface-3 text-text'
                    : 'text-text-soft hover:bg-surface-2',
                )}
              >
                <FileText size={12} strokeWidth={1.8} className="shrink-0 text-dim" />
                <span className="truncate">{p}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((chip) => (
            <AttachmentChipView
              key={`${chip.kind}-${chip.id}`}
              chip={chip}
              onRemove={() => removeAttachment(chip)}
            />
          ))}
        </div>
      )}

      {/* Reverse search overlay */}
      {searchMode && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-primary/30 bg-surface-2/80 px-3 py-2 font-mono text-[12.5px]">
          <Search size={12} strokeWidth={2} className="text-primary" />
          <span className="text-dim">(reverse-i-search) &apos;</span>
          <span className="text-text">{searchQuery}</span>
          <span className="text-dim">&apos;:</span>
          <span className="ml-2 flex-1 truncate text-text-soft">
            {searchHit ? searchHit.entry : <em className="text-dim">nenhum match</em>}
          </span>
          <span className="text-[10px] text-dim">Enter aceita · Esc cancela</span>
        </div>
      )}

      {/* Input shell — glass + soft border, estilo macOS */}
      <div
        className={clsx(
          'group relative rounded-[20px] border bg-surface-2/60 backdrop-blur-md transition-all duration-200',
          isWelcome ? 'shadow-elev' : 'shadow-card',
          dragActive
            ? 'border-primary/70 shadow-[0_0_0_3px_rgba(232,93,39,0.18)]'
            : searchMode
              ? 'border-primary/40'
              : 'border-border-soft hover:border-border-soft/80 focus-within:border-primary/40 focus-within:shadow-[0_0_0_3px_rgba(217,119,87,0.08)]',
        )}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            setDragActive(true);
          }
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragActive(false);
        }}
        onDrop={onDrop}
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[20px] bg-primary/10 text-[12.5px] font-medium text-primary">
            <Paperclip size={14} className="mr-2" /> solta para anexar
          </div>
        )}
        {slashOpen && (
          <SlashCommandPicker
            ref={slashPickerRef}
            query={slashQuery}
            onSelect={onSlashSelect}
            onClose={() => {
              // Apaga o "/" pra fechar — modo "esc fecha" sem mexer no foco.
              setValue((v) => v.replace(/^\s*\/[^\s]*/, '').trimStart());
            }}
          />
        )}
        <ActiveFileChip />
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={searchMode}
          placeholder={
            busy
              ? 'rodando — Esc Esc cancela'
              : isWelcome
                ? 'Como posso ajudar você hoje?'
                : 'Pergunte qualquer coisa…'
          }
          rows={1}
          className={clsx(
            'block w-full resize-none bg-transparent pt-4 text-[15px] leading-relaxed text-text placeholder:text-dim/90 focus:outline-none',
            isWelcome ? 'px-5 pb-2' : 'px-5 pb-2',
          )}
          spellCheck={false}
          style={{ minHeight: isWelcome ? 56 : 44 }}
        />

        {/* Toolbar inferior */}
        <div className="flex items-center justify-between px-3 pb-2 pt-1">
          {/* Left — attach popover */}
          <div ref={attachRef} className="relative">
            <button
              type="button"
              title="Anexar arquivo ou imagem"
              aria-label="Anexar arquivo ou imagem"
              aria-expanded={attachOpen}
              onClick={() => setAttachOpen((v) => !v)}
              className={clsx(
                'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                attachOpen ? 'bg-surface-3 text-text' : 'text-dim-soft hover:bg-surface-3 hover:text-text',
              )}
            >
              <Plus size={16} strokeWidth={1.8} className={clsx('transition-transform duration-150', attachOpen && 'rotate-45')} />
            </button>
            {attachOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-44 overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-elev">
                <button
                  type="button"
                  onClick={openImagePicker}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[12.5px] text-text-soft hover:bg-surface-2 hover:text-text"
                >
                  <ImageIcon size={13} className="shrink-0 text-dim-soft" aria-hidden="true" />
                  Imagem
                </button>
                <button
                  type="button"
                  onClick={openFilePicker}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[12.5px] text-text-soft hover:bg-surface-2 hover:text-text"
                >
                  <FileText size={13} className="shrink-0 text-dim-soft" aria-hidden="true" />
                  Arquivo
                </button>
              </div>
            )}
          </div>

          {/* Right — model + send */}
          <div className="flex items-center gap-2">
            <ModelBadge />
            {busy ? (
              <button
                type="button"
                onClick={abort}
                title="Cancelar (Esc Esc)"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-text-soft transition-colors hover:bg-surface-3/80"
              >
                <Square size={13} strokeWidth={2} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => submit(value)}
                disabled={!value.trim()}
                title="Enviar (Enter)"
                className={clsx(
                  'flex h-8 w-8 items-center justify-center rounded-full transition-all',
                  value.trim()
                    ? 'bg-primary text-surface-0 hover:bg-primary-soft'
                    : 'cursor-not-allowed bg-surface-3 text-dim',
                )}
              >
                <ArrowUp size={15} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>

        {/* Barra de metadados inferior — só na variante chat */}
        {!isWelcome && (isMultiline || vimEnabled) && (
          <div className="flex items-center gap-3 border-t border-border-subtle/60 px-4 py-1 text-[10.5px] text-dim">
            {vimEnabled && (
              <button
                type="button"
                onClick={toggleVim}
                className={clsx(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold',
                  vim.mode === 'NORMAL' ? 'bg-success/20 text-success' : 'bg-accent/20 text-accent',
                )}
                title={`vim ${vim.mode} — clique pra desligar`}
              >
                [{vim.mode === 'NORMAL' ? 'N' : 'I'}]
              </button>
            )}
            {isMultiline && (
              <span>
                {lines.length} linhas · <kbd className="font-mono">Ctrl+J</kbd> nova linha
              </span>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Model badge ──────────────────────────────────────────────────────
// Reusa o ModelConfigPicker compartilhado (mesmo da StatusBar) — clicar
// abre a lista das api-configs cadastradas e permite trocar a ativa.
function ActiveFileChip(): React.ReactElement | null {
  const file = useChatStore((s) => s.activeFile);
  if (!file) return null;
  const clear = (): void =>
    useChatStore.getState().setActiveFile(null);
  return (
    <div
      className="mx-3 mt-2 inline-flex w-fit items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2/60 px-2 py-1 font-mono text-[11.5px] text-text-soft"
      title={file.path}
    >
      <FileText size={12} className="shrink-0 text-primary" />
      <span className="truncate max-w-[260px]">{file.fileName}</span>
      <button
        type="button"
        onClick={clear}
        title="Soltar arquivo do contexto"
        className="ml-1 rounded p-0.5 text-dim transition-colors hover:bg-surface-3 hover:text-text"
      >
        <X size={11} strokeWidth={2.4} />
      </button>
    </div>
  );
}

function ModelBadge(): React.ReactElement | null {
  const model = useChatStore((s) => s.model);
  return (
    <ModelConfigPicker
      currentModel={model}
      panelWidth={340}
      placement="top"
      triggerClassName="flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-text-soft transition-colors hover:bg-surface-3"
      renderTrigger={(display) => (
        <>
          <span className="font-medium">{display}</span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="currentColor"
            className="ml-0.5 text-dim"
          >
            <path d="M5 7L1.5 3.5h7L5 7z" />
          </svg>
        </>
      )}
    />
  );
}

// ── Attachment chip view ───────────────────────────────────────────────

interface ChipViewProps {
  chip: AttachmentChip;
  onRemove: () => void;
}

function AttachmentChipView({ chip, onRemove }: ChipViewProps): React.ReactElement {
  const Icon =
    chip.kind === 'image' ? ImageIcon : chip.kind === 'file' ? Paperclip : FileText;
  const label =
    chip.kind === 'image'
      ? `Imagem #${chip.id} · ${formatBytes(chip.bytes)}`
      : chip.kind === 'file'
        ? `${chip.name} · ${chip.lines}L`
        : `Pasted #${chip.id} · ${chip.lines}L`;
  const hasThumb = chip.kind === 'image' && Boolean(chip.thumbUrl);
  return (
    <div
      className={clsx(
        'inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-border-subtle bg-surface-3/60 text-[11.5px] text-text-soft',
        hasThumb ? 'py-0.5 pl-0.5 pr-1' : 'py-1 pl-2 pr-1',
      )}
    >
      {hasThumb ? (
        <img
          src={(chip as Extract<AttachmentChip, { kind: 'image' }>).thumbUrl}
          alt=""
          className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-border-subtle"
          draggable={false}
        />
      ) : (
        <Icon size={12} strokeWidth={1.8} className="shrink-0 text-primary" />
      )}
      <span className="truncate font-mono">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        title="Remover anexo"
        className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-dim transition-colors hover:bg-surface-3 hover:text-text"
      >
        <X size={11} strokeWidth={2} />
      </button>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

// ── history search util ────────────────────────────────────────────────
type SearchDir = 'backward' | 'forward';

function findMatch(
  history: string[],
  query: string,
  startIdx: number,
  dir: SearchDir = 'backward',
): { entry: string; idx: number } | null {
  if (history.length === 0) return null;
  const q = query.toLowerCase();
  const step = dir === 'backward' ? -1 : 1;
  let i = Math.max(0, Math.min(history.length - 1, startIdx));
  for (let k = 0; k < history.length; k++) {
    const entry = history[i];
    if (!q || entry.toLowerCase().includes(q)) {
      return { entry, idx: i };
    }
    i += step;
    if (i < 0) i = history.length - 1;
    if (i >= history.length) i = 0;
  }
  return null;
}
