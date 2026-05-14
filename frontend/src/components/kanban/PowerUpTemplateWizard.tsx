// flowbuilder/src/components/kanban/PowerUpTemplateWizard.tsx
import React, { useState } from 'react';
import { X, ChevronRight, ChevronLeft, Zap, Globe, Sliders, Code2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
  createTemplate, updateTemplate, submitTemplate,
  PowerUpTemplate, PowerUpMode, KANBAN_EVENTS, TEMPLATE_VARIABLES,
} from '@/services/kanbanPowerUpTemplate.service';

interface Props {
  boardId: string;
  editingTemplate?: PowerUpTemplate | null;
  onClose: () => void;
  onSaved: (tpl: PowerUpTemplate) => void;
}

const MODES: { value: PowerUpMode; label: string; desc: string; icon: React.ReactNode; hint: string }[] = [
  {
    value: 'simple',
    label: 'Notificacao',
    desc: 'Envia um aviso para uma URL quando o evento ocorrer',
    icon: <Globe className="h-4 w-4" />,
    hint: 'Ideal para webhooks simples — Slack, Discord, Zapier, Make, etc.',
  },
  {
    value: 'builder',
    label: 'Personalizado',
    desc: 'Defina exatamente o que enviar e como enviar',
    icon: <Sliders className="h-4 w-4" />,
    hint: 'Use quando precisar customizar os dados enviados para o serviço.',
  },
  {
    value: 'script',
    label: 'Script avancado',
    desc: 'Controle total via JavaScript — para integrações complexas',
    icon: <Code2 className="h-4 w-4" />,
    hint: 'Requer conhecimento de JavaScript. Útil para lógica condicional ou múltiplas chamadas.',
  },
];

const STEPS = [
  { label: 'Identidade', sublabel: 'Nome e quando disparar' },
  { label: 'Acao', sublabel: 'O que acontece ao disparar' },
  { label: 'Revisao', sublabel: 'Confirmar e publicar' },
];

const STARTER_SCRIPT = `// Contexto disponível: ctx.card, ctx.event, ctx.config
// Use fetch() para fazer requisições HTTP

const response = await fetch('https://meu-servico.com/webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + ctx.config.token,
  },
  body: JSON.stringify({
    card: ctx.card,
    event: ctx.event,
  }),
});

// response.status e response.body disponíveis
`;

export function PowerUpTemplateWizard({
  boardId,
  editingTemplate,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation('flow-builder');
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Step 0 — Identidade
  const [name, setName] = useState(editingTemplate?.name ?? '');
  const [icon, setIcon] = useState(editingTemplate?.icon ?? '⚡');
  const [description, setDescription] = useState(editingTemplate?.description ?? '');
  const [triggerEvents, setTriggerEvents] = useState<string[]>(editingTemplate?.triggerEvents ?? []);

  // Step 1 — Ação
  const [mode, setMode] = useState<PowerUpMode>(editingTemplate?.mode ?? 'simple');
  const [url, setUrl] = useState(editingTemplate?.url ?? '');
  const [headersRaw, setHeadersRaw] = useState(
    editingTemplate?.headersTemplate
      ? JSON.stringify(editingTemplate.headersTemplate, null, 2)
      : '{\n  "Content-Type": "application/json"\n}'
  );
  const [payloadRaw, setPayloadRaw] = useState(
    editingTemplate?.payloadTemplate
      ? JSON.stringify(editingTemplate.payloadTemplate, null, 2)
      : '{\n  "event": "{{event.type}}",\n  "card": "{{card.title}}"\n}'
  );
  const [script, setScript] = useState(editingTemplate?.script ?? STARTER_SCRIPT);

  const toggleEvent = (key: string) => {
    setTriggerEvents(prev =>
      prev.includes(key) ? prev.filter(e => e !== key) : [...prev, key]
    );
  };

  const buildPayload = () => ({
    name: name.trim(),
    icon,
    description: description.trim() || null,
    mode,
    triggerEvents,
    url: (mode === 'simple' || mode === 'builder') ? url.trim() : undefined,
    headersTemplate: mode === 'builder' ? tryParseJson(headersRaw) : undefined,
    payloadTemplate: mode === 'builder' ? tryParseJson(payloadRaw) : undefined,
    script: mode === 'script' ? script : undefined,
  });

  const handleSaveDraft = async () => {
    if (!name.trim()) { toast.error('Nome obrigatório'); return; }
    setSaving(true);
    try {
      let tpl: PowerUpTemplate;
      if (editingTemplate) {
        // @ts-ignore
        tpl = await updateTemplate(editingTemplate.id, buildPayload());
      } else {
        // @ts-ignore
        tpl = await createTemplate(boardId, buildPayload());
      }
      toast.success('Rascunho salvo');
      onSaved(tpl);
    } catch {
      toast.error('Erro ao salvar rascunho');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) { toast.error('Nome obrigatório'); return; }
    setSaving(true);
    try {
      let tpl: PowerUpTemplate;
      if (editingTemplate) {
        // @ts-ignore
        tpl = await updateTemplate(editingTemplate.id, buildPayload());
      } else {
        // @ts-ignore
        tpl = await createTemplate(boardId, buildPayload());
      }
      tpl = await submitTemplate(tpl.id);
      toast.success('Enviado para aprovação do administrador');
      onSaved(tpl);
    } catch {
      toast.error('Erro ao enviar para aprovação');
    } finally {
      setSaving(false);
    }
  };

  const canNextStep0 = name.trim().length > 0 && triggerEvents.length > 0;
  const canNextStep1 = mode === 'script' ? script.trim().length > 0 : url.trim().length > 0;

  const insertVariable = (v: string, setter: React.Dispatch<React.SetStateAction<string>>) => {
    setter(prev => prev + v);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800"
        style={{ maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#e9efff] dark:bg-[#1c2b41]">
              <Zap className="h-4 w-4 text-[#0c66e4]" />
            </div>
            <span className="font-semibold text-[#172b4d] dark:text-white">
              {editingTemplate ? 'Editar power-up' : 'Criar power-up'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            {/* Step indicator */}
            <div className="flex items-center gap-1">
              {/* @ts-ignore */}
              {STEPS.map((s, i) => (
                <React.Fragment key={i}>
                  <div className="flex flex-col items-center">
                    <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                      i < step
                        ? 'bg-[#0c66e4] text-white'
                        : i === step
                          ? 'border-2 border-[#0c66e4] text-[#0c66e4]'
                          : 'border-2 border-slate-200 text-slate-400 dark:border-gray-600'
                    }`}>
                      {i < step ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                    </div>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={`h-px w-6 transition-colors ${i < step ? 'bg-[#0c66e4]' : 'bg-slate-200 dark:bg-gray-600'}`} />
                  )}
                </React.Fragment>
              ))}
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-[#626f86] hover:bg-slate-100 dark:hover:bg-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Step label */}
        <div className="border-b border-slate-100 px-6 py-2 dark:border-gray-700/50">
          <p className="text-xs text-[#626f86]">
            Passo {step + 1} de {STEPS.length} — <span className="font-medium text-[#172b4d] dark:text-gray-200">{STEPS[step].label}</span>
            <span className="ml-1 text-[#626f86]">/ {STEPS[step].sublabel}</span>
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">

          {/* ===== STEP 0: Identidade ===== */}
          {step === 0 && (
            <div className="space-y-5">
              <div className="flex gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-[#626f86]">{t('nodes.powerUpTemplateWizard.tsx.icone')}</label>
                  <input
                    value={icon}
                    onChange={e => setIcon(e.target.value)}
                    maxLength={2}
                    className="w-14 rounded-lg border border-slate-200 px-2 py-2.5 text-center text-xl dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:border-[#0c66e4] focus:outline-none"
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <label className="text-xs font-medium text-[#626f86]">
   {t('nodes.powerUpTemplateWizard.tsx.nomeDoPowerUp')}<span className="text-red-500">*</span>
                  </label>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder={t('nodes.powerUpTemplateWizard.tsx.exNotificacaoNoDiscord_placeholder')}
                    className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:border-[#0c66e4] focus:outline-none focus:ring-1 focus:ring-[#0c66e4]"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[#626f86]">
   {t('nodes.powerUpTemplateWizard.tsx.descricao')}<span className="text-slate-400">(opcional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={2}
                  placeholder="Ex: Envia uma mensagem no canal #projetos quando um card for movido"
                  className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white resize-none focus:border-[#0c66e4] focus:outline-none focus:ring-1 focus:ring-[#0c66e4]"
                />
              </div>

              <div className="flex flex-col gap-2">
                <div>
                  <label className="text-xs font-medium text-[#626f86]">
                    Quando este power-up deve disparar? <span className="text-red-500">*</span>
                  </label>
                  <p className="mt-0.5 text-xs text-slate-400">Selecione um ou mais eventos</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {KANBAN_EVENTS.map(ev => (
                    <label
                      key={ev.key}
                      className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                        triggerEvents.includes(ev.key)
                          ? 'border-[#0c66e4] bg-[#e9efff] text-[#0c66e4] dark:bg-[#1c2b41]'
                          : 'border-slate-200 text-[#172b4d] hover:bg-slate-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={triggerEvents.includes(ev.key)}
                        onChange={() => toggleEvent(ev.key)}
                        className="accent-[#0c66e4]"
                      />
                      {ev.label}
                    </label>
                  ))}
                </div>
                {triggerEvents.length === 0 && (
                  <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Selecione pelo menos um evento para continuar
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ===== STEP 1: Ação ===== */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <label className="text-xs font-medium text-[#626f86]">Como este power-up vai reagir?</label>
                <div className="mt-2 flex flex-col gap-2">
                  {MODES.map(m => (
                    <button
                      key={m.value}
                      onClick={() => setMode(m.value)}
                      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                        mode === m.value
                          ? 'border-[#0c66e4] bg-[#e9efff] dark:bg-[#1c2b41]'
                          : 'border-slate-200 hover:bg-slate-50 dark:border-gray-600 dark:hover:bg-gray-700'
                      }`}
                    >
                      <div className={`mt-0.5 ${mode === m.value ? 'text-[#0c66e4]' : 'text-[#626f86]'}`}>
                        {m.icon}
                      </div>
                      <div className="flex-1">
                        <div className={`text-sm font-medium ${mode === m.value ? 'text-[#0c66e4]' : 'text-[#172b4d] dark:text-white'}`}>
                          {m.label}
                        </div>
                        <div className="text-xs text-[#626f86] mt-0.5">{m.desc}</div>
                        {mode === m.value && (
                          <div className="mt-1.5 text-xs text-[#0c66e4]/80 dark:text-blue-400">{m.hint}</div>
                        )}
                      </div>
                      <div className={`mt-1 h-4 w-4 rounded-full border-2 flex-shrink-0 ${
                        mode === m.value
                          ? 'border-[#0c66e4] bg-[#0c66e4]'
                          : 'border-slate-300 dark:border-gray-500'
                      }`}>
                        {mode === m.value && (
                          <div className="flex h-full w-full items-center justify-center">
                            <div className="h-1.5 w-1.5 rounded-full bg-white" />
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {(mode === 'simple' || mode === 'builder') && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-[#626f86]">
                    URL de destino <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/..."
                    className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-mono dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:border-[#0c66e4] focus:outline-none focus:ring-1 focus:ring-[#0c66e4]"
                  />
                  <p className="text-xs text-slate-400">{t('nodes.powerUpTemplateWizard.tsx.enderecoQueReceberaOsDadosQuandoOEventoOcorrerPost')}</p>
                </div>
              )}

              {mode === 'builder' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-[#626f86]">{t('nodes.powerUpTemplateWizard.tsx.cabecalhosDaRequisicaoJson')}</label>
                    <p className="text-xs text-slate-400">{t('nodes.powerUpTemplateWizard.tsx.defineAutenticacaoETipoDeConteudoEnviado')}</p>
                    <textarea
                      value={headersRaw}
                      onChange={e => setHeadersRaw(e.target.value)}
                      rows={4}
                      className="rounded-lg border border-slate-200 px-3 py-2.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-white resize-none focus:border-[#0c66e4] focus:outline-none"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-[#626f86]">Dados a enviar (JSON)</label>
                    <p className="text-xs text-slate-400">
                      Use <code className="rounded bg-slate-100 px-1 dark:bg-gray-700">{'{{variavel}}'}</code> para inserir informações do card e do evento
                    </p>
                    <textarea
                      value={payloadRaw}
                      onChange={e => setPayloadRaw(e.target.value)}
                      rows={6}
                      className="rounded-lg border border-slate-200 px-3 py-2.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-white resize-none focus:border-[#0c66e4] focus:outline-none"
                    />
                    <div className="space-y-1">
                      <p className="text-xs text-slate-400">{t('nodes.powerUpTemplateWizard.tsx.cliqueParaInserirUmaVariavel')}</p>
                      <div className="flex flex-wrap gap-1">
                        {TEMPLATE_VARIABLES.map(v => (
                          <button
                            key={v}
                            onClick={() => insertVariable(v, setPayloadRaw)}
                            className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-slate-100 text-[#626f86] hover:bg-[#e9efff] hover:text-[#0c66e4] dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {mode === 'script' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 dark:bg-amber-900/20">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Modo avançado — requer conhecimento de JavaScript. O script roda em ambiente isolado com acesso ao contexto do card.
                    </p>
                  </div>
                  <label className="text-xs font-medium text-[#626f86]">
   {t('nodes.powerUpTemplateWizard.tsx.codigoJavascript')}<span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={script}
                    onChange={e => setScript(e.target.value)}
                    rows={14}
                    className="rounded-lg border border-slate-200 px-3 py-2.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-white resize-none focus:border-[#0c66e4] focus:outline-none"
                  />
                  <div className="space-y-1">
                    <p className="text-xs text-slate-400">{t('nodes.powerUpTemplateWizard.tsx.inserirReferencia')}</p>
                    <div className="flex flex-wrap gap-1">
                      {TEMPLATE_VARIABLES.map(v => (
                        <button
                          key={v}
                          onClick={() => insertVariable('\n// ' + v, setScript)}
                          className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-slate-100 text-[#626f86] hover:bg-[#e9efff] hover:text-[#0c66e4] dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===== STEP 2: Revisão ===== */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-200 p-5 space-y-3 dark:border-gray-600">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#e9efff] text-xl dark:bg-[#1c2b41]">
                    {icon}
                  </div>
                  <div>
                    <p className="font-semibold text-[#172b4d] dark:text-white">{name}</p>
                    {description && <p className="text-sm text-[#626f86]">{description}</p>}
                  </div>
                </div>

                <div className="border-t border-slate-100 pt-3 dark:border-gray-700 space-y-2">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1.5">Dispara quando</p>
                    <div className="flex flex-wrap gap-1.5">
                      {triggerEvents.map(e => (
                        <span key={e} className="rounded-full bg-[#e9efff] px-2.5 py-0.5 text-xs font-medium text-[#0c66e4] dark:bg-[#1c2b41]">
                          {KANBAN_EVENTS.find(ev => ev.key === e)?.label ?? e}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{t('nodes.powerUpTemplateWizard.tsx.tipoDeAcao')}</p>
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-[#626f86] dark:bg-gray-700 dark:text-gray-300">
                      {MODES.find(m => m.value === mode)?.label}
                    </span>
                  </div>

                  {url && (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">URL de destino</p>
                      <code className="block text-xs font-mono text-[#626f86] break-all">{url}</code>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-gray-700 dark:bg-gray-700/30">
                <p className="text-sm font-medium text-[#172b4d] dark:text-white mb-1">O que acontece agora?</p>
                <ul className="space-y-1.5 text-sm text-[#626f86]">
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-slate-400 flex-shrink-0" />
                    <span><strong>Salvar rascunho</strong> {t('nodes.powerUpTemplateWizard.tsx.ficaSalvoComoPrivadoVocePodeContinuarEditandoDepois')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[#0c66e4] flex-shrink-0" />
                    <span><strong>{t('nodes.powerUpTemplateWizard.tsx.enviarParaAprovacao')}</strong> {t('nodes.powerUpTemplateWizard.tsx.oAdministradorRevisaraAntesDeAtivarParaOBoard')}</span>
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4 dark:border-gray-700">
          <button
            onClick={() => step > 0 ? setStep(s => s - 1) : onClose()}
            className="flex items-center gap-1 rounded-xl border border-slate-200 px-4 py-2 text-sm text-[#626f86] hover:bg-slate-50 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            <ChevronLeft className="h-4 w-4" />
            {step === 0 ? 'Cancelar' : 'Voltar'}
          </button>
          <div className="flex gap-2">
            {step === 2 ? (
              <>
                <button
                  onClick={handleSaveDraft}
                  disabled={saving}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-[#626f86] hover:bg-slate-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
                >
                  Salvar rascunho
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={saving}
                  className="flex items-center gap-2 rounded-xl bg-[#0c66e4] px-4 py-2 text-sm font-medium text-white hover:bg-[#0055cc] disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Enviando...
                    </>
                  ) : (
                    'Enviar para aprovação'
                  )}
                </button>
              </>
            ) : (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={step === 0 ? !canNextStep0 : !canNextStep1}
                className="flex items-center gap-1 rounded-xl bg-[#0c66e4] px-4 py-2 text-sm font-medium text-white hover:bg-[#0055cc] disabled:opacity-50 disabled:cursor-not-allowed"
              >
   {t('nodes.powerUpTemplateWizard.tsx.proximo')}<ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function tryParseJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s); } catch { return null; }
}
