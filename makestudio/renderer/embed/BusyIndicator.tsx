import React from 'react';
import { createPortal } from 'react-dom';
import { useChatStore } from '../store';

// One big pool of playful phrases shown ONLY in the subtext (below the
// fixed "thinking…" verb). Rotates slowly so each phrase has time to
// breathe. Combines what used to be two separate lists.
const PLAYFUL_PHRASES = [
  'gerando bugs sem querer…',
  'pegando o token mais bonito…',
  'consultando o oráculo…',
  'agitando neurônios…',
  'puxando uma resposta da cartola…',
  'desenrolando o spaghetti…',
  'fingindo que sei o que faço…',
  'compilando opiniões…',
  'organizando o caos…',
  'aquecendo a CPU…',
  'rebobinando a fita…',
  'lendo nas entrelinhas…',
  'cutucando a inteligência artificial…',
  'desenferrujando os transistores…',
  'reorganizando o desktop mental…',
  'caçando o bug que ainda nem existe…',
  'tomando um café duplo digital…',
  'consultando o stack overflow paralelo…',
  'rolando os dados da inspiração…',
  'remexendo no porão dos pensamentos…',
  'preparando uma resposta caprichada…',
  'misturando token com criatividade…',
  'desempacotando ideias…',
  'inventando moda…',
  'puxando da memória de longo prazo…',
  'recombinando neurônios soltos…',
  'colocando ordem no quartel-general…',
  'avaliando 47 caminhos diferentes…',
  'descomplicando o complicado…',
  'cogitando alternativas absurdas…',
  'tomando fôlego antes da resposta…',
  'desempoeirando o dicionário…',
  'consultando o GPS interno…',
  'abrindo aspas mentalmente…',
  'desbravando o contexto…',
  'soltando os dragões…',
  'entrando em modo profundo…',
  'quase lá, perdi o token, ele estava por aqui…',
  'cutucando o modelo pra acordar…',
  'modelo tomando café — já volta…',
  'esperando o primeiro byte sair do forno…',
  'tokens estão num engarrafamento…',
  'modelo respirando fundo antes de responder…',
  'fazendo a fila andar no servidor…',
  'um momento, garimpando contexto…',
  'aquecendo as engrenagens…',
  'o modelo está olhando pro teto, paciência…',
  'modelo procurando o token perdido…',
  'modelo lendo a pergunta com calma…',
  'token saiu pra dar uma volta…',
  'modelo afiando o lápis virtual…',
  'modelo organizando os pensamentos em fila indiana…',
  'segurando a respiração junto com o modelo…',
  'modelo abrindo o caderninho de respostas…',
  'token preso no semáforo, segura aí…',
  'modelo conferindo a gramática antes de mandar…',
  'modelo apertando o cinto do raciocínio…',
  'token tá fazendo cooper, vem chegando…',
  'modelo encarando o cursor piscando…',
  'token entrando em conferência interna…',
  'modelo fazendo média móvel com o universo…',
  'modelo descongelando a frase perfeita…',
  'token a caminho — tomou um Uber…',
  'modelo pensando em fluxo de consciência…',
  'token tá no checkpoint da fronteira…',
  'modelo decidindo entre 3 sinônimos pra "talvez"…',
  'token em revisão final…',
  'modelo segurando a língua pra escolher melhor…',
  'modelo ajustando o tom da voz…',
  'token meditando no zen do servidor…',
  'modelo fazendo polimento…',
  'modelo conferindo se entendeu mesmo a pergunta…',
  'token saindo do forno em 3, 2, 1…',
  'modelo arrumando a postura antes de falar…',
  'token brigando com o roteador…',
  'modelo amarrando os cadarços do pensamento…',
  'paciência: a primeira frase é sempre a pior…',
  'modelo refazendo as contas mais uma vez…',
];

function pickStable<T>(list: T[], seed: number): T {
  return list[((seed % list.length) + list.length) % list.length];
}

/**
 * Picks a phrase from `pool` and rotates every `rotateEveryMs`. The
 * `seedKey` resets the rotation index when it changes (e.g., a fresh
 * turn id ⇒ fresh starting phrase).
 */
function useRotatingPhrase(
  pool: string[],
  rotateEveryMs: number,
  seedKey: string,
): string {
  const seedRef = React.useRef(0);
  const lastSeedKey = React.useRef<string>('');
  if (lastSeedKey.current !== seedKey) {
    lastSeedKey.current = seedKey;
    seedRef.current = Math.floor(Math.random() * pool.length);
  }
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), rotateEveryMs);
    return () => clearInterval(id);
  }, [rotateEveryMs]);
  return pickStable(pool, seedRef.current + tick);
}

/**
 * "Thinking" indicator in the spirit of the Claude Code CLI:
 *   · Pensando… (1m 14s · ↓ 3.0k tokens)
 *     └ Bash: rm /tmp/...
 *
 * Reads the chat store fields the kernel already publishes:
 *   - busy, busyLabel       → state of the current turn
 *   - streamTokens          → tokens streamed so far this turn
 *   - currentTool           → last tool the agent invoked (if any)
 *
 * Elapsed time is computed client-side from when busy first flipped to true.
 * Renders portaled into the MessageList scroll so it sits with the
 * conversation, just above the input.
 */
export function BusyIndicator(): React.ReactElement | null {
  const busy = useChatStore((s) => s.busy);
  const busyLabel = useChatStore((s) => s.busyLabel);
  const streamTokens = useChatStore((s) => s.streamTokens);
  const currentTool = useChatStore((s) => s.currentTool);
  const lastTool = useChatStore((s) => s.lastTool);
  const totalTokens = useChatStore((s) => s.totalTokens);

  const [elapsedMs, setElapsedMs] = React.useState(0);
  const startedAt = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!busy) {
      startedAt.current = null;
      setElapsedMs(0);
      return;
    }
    if (startedAt.current == null) startedAt.current = Date.now();
    const id = setInterval(() => {
      if (startedAt.current != null) setElapsedMs(Date.now() - startedAt.current);
    }, 250);
    return () => clearInterval(id);
  }, [busy]);

  const portalTarget = React.useMemo<Element | null>(() => {
    if (!busy) return null;
    if (typeof document === 'undefined') return null;
    return document.querySelector('[data-message-list-content]');
  }, [busy]);

  // Auto-scroll to keep the indicator visible when it first appears.
  React.useEffect(() => {
    if (!busy || !portalTarget) return;
    requestAnimationFrame(() => {
      const scroll = portalTarget.parentElement;
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
  }, [busy, portalTarget]);

  // Seed key: re-roll phrases on each fresh turn (when the indicator
  // (re)appears). startedAt.current is set once per turn in the effect
  // above, so its stringified value works as a turn id.
  const turnSeed = String(startedAt.current ?? 0);
  // Slow rotation — Claude-Code-style. A single phrase stays visible
  // long enough to read it (and re-read it), then drifts to the next.
  const rotatingPhrase = useRotatingPhrase(PLAYFUL_PHRASES, 12000, turnSeed);

  if (!busy) return null;

  // Top line stays as the kernel's busyLabel (defaults to "thinking…"
  // from the CLI). Subtext below carries the playful rotation.
  const verb = (busyLabel?.trim() || 'thinking…').trim();
  const timeText = formatElapsed(elapsedMs);
  const tokensText = streamTokens > 0 ? `↓ ${formatTokens(streamTokens)} tokens` : null;
  const totalTokensText = totalTokens > 0 ? `${formatTokens(totalTokens)} total` : null;

  const currentToolName =
    typeof currentTool === 'object' && currentTool && 'name' in currentTool
      ? String((currentTool as { name?: string }).name ?? '')
      : '';
  const lastToolName =
    typeof lastTool === 'object' && lastTool && 'name' in lastTool
      ? String((lastTool as { name?: string }).name ?? '')
      : '';

  // Subtext priority: current tool > waiting after last tool > rotating
  // playful phrase. The playful phrase shows ANY time the model is
  // working without a specific tool to surface — not only on TTFT — so
  // long thinking turns also get the gracinhas.
  let subText: string | null = null;
  if (currentToolName) {
    subText = `executando: ${currentToolName}`;
  } else if (streamTokens === 0 && lastToolName) {
    subText = `aguardando modelo (último: ${lastToolName})`;
  } else {
    subText = rotatingPhrase;
  }

  const card = (
    <div className="my-2 font-mono text-[12px] leading-tight">
      <div className="flex items-center gap-1.5 text-primary">
        <span className="animate-pulse-fade text-[14px]">·</span>
        <span className="font-semibold animate-pulse-fade">{verb}</span>
        <span className="text-dim-soft font-normal">
          ({timeText}
          {tokensText ? ` · ${tokensText}` : ''}
          {totalTokensText && !tokensText ? ` · ${totalTokensText}` : ''})
        </span>
      </div>
      {subText && (
        <div className="ml-3 mt-0.5 text-dim-soft text-[11.5px]">
          <span className="opacity-50">└</span> {subText}
        </div>
      )}
    </div>
  );

  if (portalTarget) return createPortal(card, portalTarget);
  return <div className="px-3">{card}</div>;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
