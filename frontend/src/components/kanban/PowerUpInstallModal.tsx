// flowbuilder/src/components/kanban/PowerUpInstallModal.tsx
// @ts-ignore
import React, { useState } from 'react';
import { X, CheckCircle2, Info, Eye, EyeOff, Zap, ArrowRight, Code2, Webhook } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { PowerUpTemplate, installTemplate, PowerUpInstallation, KANBAN_EVENTS } from '@/services/kanbanPowerUpTemplate.service';
import { useTranslation } from 'react-i18next';

interface Props {
  boardId: string;
  template: PowerUpTemplate;
  onClose: () => void;
  onInstalled: (installation: PowerUpInstallation) => void;
}

export function PowerUpInstallModal({
  boardId,
  template,
  onClose,
  onInstalled,
}: Props) {
  const { t } = useTranslation('flow-builder');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});

  const requiredFields = (template.configSchema ?? []).filter(f => f.required);
  const optionalFields = (template.configSchema ?? []).filter(f => !f.required);
  const filledRequired = requiredFields.filter(f => config[f.key]?.trim()).length;
  const allRequiredFilled = filledRequired === requiredFields.length;

  const handleInstall = async () => {
    const missing = requiredFields.filter(f => !config[f.key]?.trim());
    if (missing.length) {
      toast.error(`Preencha: ${missing.map(f => f.label).join(', ')}`);
      return;
    }
    setLoading(true);
    try {
      const inst = await installTemplate(boardId, template.id, config);
      toast.success(`${template.name} instalado com sucesso!`);
      onInstalled(inst);
    } catch {
      toast.error('Não foi possível instalar. Verifique as informações e tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const toggleShowPassword = (key: string) => {
    setShowPassword(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const ACTION_LABELS: Record<string, string> = {
    moveCard: 'Mover card de lista',
    assignMember: 'Atribuir membro ao card',
    setDue: 'Definir prazo do card',
    addComment: 'Adicionar comentário',
  };

  const MODE_LABELS: Record<string, string> = {
    simple: 'Webhook simples',
    builder: 'Construtor visual',
    script: 'Script personalizado',
  };

  const eventLabel = (key: string) =>
    KANBAN_EVENTS.find(e => e.key === key)?.label ?? key;

  const hasTriggersOrActions =
    (template.triggerEvents?.length > 0) ||
    (template.responseMapping && template.responseMapping.length > 0);

  const renderPreview = () => {
    const triggers = template.triggerEvents ?? [];
    const actions = template.responseMapping ?? [];

    return (
      <div className="mb-4 rounded-xl border border-[#e2e6ea] bg-[#f8fafc] p-4 dark:border-[#3b4754] dark:bg-[#1b2024]">
        <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#626f86] dark:text-gray-400">Como funciona</p>

        {/* Trigger events */}
        {triggers.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-[11px] font-semibold text-[#172b4d] dark:text-gray-200">O que dispara este power-up</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {triggers.map(t => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/25 dark:text-amber-400"
                >
                  {eventLabel(t)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        {actions.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center gap-1.5">
              <ArrowRight className="h-3.5 w-3.5 text-[#0c66e4]" />
              <span className="text-[11px] font-semibold text-[#172b4d] dark:text-gray-200">O que vai acontecer</span>
            </div>
            <div className="flex flex-col gap-1">
              {actions.map((a, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[#e9efff] text-[9px] font-bold text-[#0c66e4] dark:bg-[#1c2b41]">
                    {i + 1}
                  </span>
                  <span className="text-[11px] text-[#626f86] dark:text-gray-400">
                    {ACTION_LABELS[a.action] ?? a.action}
                    {a.condition && (
                      <span className="ml-1 text-[10px] italic">
                        (quando {a.condition.field} {a.condition.operator} &quot;{a.condition.value}&quot;)
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mode badge + description fallback when no structured data */}
        {!hasTriggersOrActions && template.description && (
          <p className="text-[12px] leading-relaxed text-[#626f86] dark:text-gray-400">{template.description}</p>
        )}

        {/* Mode indicator */}
        <div className="mt-2 flex items-center gap-1.5 border-t border-[#e2e6ea] pt-2 dark:border-[#3b4754]">
          {template.mode === 'script' ? (
            <Code2 className="h-3 w-3 text-[#626f86]" />
          ) : (
            <Webhook className="h-3 w-3 text-[#626f86]" />
          )}
          <span className="text-[10px] text-[#626f86] dark:text-gray-500">
            Modo: {MODE_LABELS[template.mode] ?? template.mode}
          </span>
        </div>
      </div>
    );
  };

  const renderField = (field: typeof template.configSchema[0]) => (
    <div key={field.key} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-[#172b4d] dark:text-gray-200">
          {field.label}
          {field.required && <span className="ml-1 text-red-500">*</span>}
        </label>
        {field.required && config[field.key]?.trim() && (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        )}
      </div>

      {field.type === 'select' && field.options ? (
        <select
          value={config[field.key] ?? ''}
          onChange={e => setConfig(p => ({ ...p, [field.key]: e.target.value }))}
          className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-[#172b4d] dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:border-[#0c66e4] focus:outline-none focus:ring-1 focus:ring-[#0c66e4]"
        >
          <option value="">{t('nodes.powerUpInstallModal.tsx.selecioneUmaOpcao')}</option>
          {field.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <div className="relative">
          <input
            type={field.type === 'password' && !showPassword[field.key] ? 'password' : 'text'}
            value={config[field.key] ?? ''}
            placeholder={field.placeholder ?? `Ex: ${field.label}`}
            onChange={e => setConfig(p => ({ ...p, [field.key]: e.target.value }))}
            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-[#172b4d] dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:border-[#0c66e4] focus:outline-none focus:ring-1 focus:ring-[#0c66e4]"
          />
          {field.type === 'password' && (
            <button
              type="button"
              onClick={() => toggleShowPassword(field.key)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#626f86] hover:text-[#172b4d] dark:hover:text-gray-200"
            >
              {showPassword[field.key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">

        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4 dark:border-gray-700">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#e9efff] text-xl dark:bg-[#1c2b41]">
              {template.icon || <Zap className="h-5 w-5 text-[#0c66e4]" />}
            </div>
            <div>
              <h2 className="font-semibold text-[#172b4d] dark:text-white">{template.name}</h2>
              {template.description && (
                <p className="mt-0.5 text-sm text-[#626f86]">{template.description}</p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-3 rounded-lg p-1 text-[#626f86] hover:bg-slate-100 dark:hover:bg-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {renderPreview()}
          {(template.configSchema ?? []).length === 0 ? (
            <div className="flex items-start gap-3 rounded-xl bg-green-50 p-4 dark:bg-green-900/20">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600 dark:text-green-400" />
              <p className="text-sm text-green-700 dark:text-green-300">
   {t('nodes.powerUpInstallModal.tsx.estePowerUpNaoPrecisaDeConfiguracaoCliqueEm')}<strong>Instalar</strong> para ativar.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Progresso de preenchimento */}
              {requiredFields.length > 0 && (
                <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 dark:bg-gray-700/50">
                  <div className="flex items-center gap-2">
                    <Info className="h-3.5 w-3.5 text-[#626f86]" />
                    <span className="text-xs text-[#626f86]">
                      {filledRequired} de {requiredFields.length} {requiredFields.length === 1 ? 'campo obrigatório preenchido' : 'campos obrigatórios preenchidos'}
                    </span>
                  </div>
                  {allRequiredFilled && (
                    <span className="text-xs font-medium text-green-600 dark:text-green-400">Pronto para instalar</span>
                  )}
                </div>
              )}

              {/* Campos obrigatórios */}
              {requiredFields.length > 0 && (
                <div className="space-y-3">
                  {requiredFields.length < (template.configSchema ?? []).length && (
                    <p className="text-xs font-medium uppercase tracking-wide text-[#626f86]">{t('nodes.powerUpInstallModal.tsx.obrigatorio')}</p>
                  )}
                  {requiredFields.map(renderField)}
                </div>
              )}

              {/* Campos opcionais */}
              {optionalFields.length > 0 && (
                <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-gray-700">
                  <p className="text-xs font-medium uppercase tracking-wide text-[#626f86]">Opcional</p>
                  {optionalFields.map(renderField)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-gray-700">
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-[#626f86] hover:bg-slate-50 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            Cancelar
          </button>
          <button
            onClick={handleInstall}
            disabled={loading || (!allRequiredFilled && requiredFields.length > 0)}
            className="flex items-center gap-2 rounded-xl bg-[#0c66e4] px-5 py-2 text-sm font-medium text-white hover:bg-[#0055cc] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Instalando...
              </>
            ) : (
              <>
                <Zap className="h-3.5 w-3.5" />
                Instalar
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
