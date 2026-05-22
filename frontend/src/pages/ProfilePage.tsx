import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Save, ArrowLeft, Lock, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import toast from 'react-hot-toast';

interface ProfileForm {
  firstName: string;
  lastName: string;
  email: string;
  avatar: string;
  password: string;
  confirmPassword: string;
}

// Shared field styling — calm dark surfaces, soft hairline borders, gentle blue
// focus. Kept as constants so every input reads identically.
const inputCls =
  'w-full rounded-lg border border-white/[0.08] bg-[#0f0f11] px-3.5 py-2.5 text-sm text-neutral-100 ' +
  'placeholder:text-neutral-600 outline-none transition-all duration-200 ' +
  'focus:border-blue-500/60 focus:bg-[#101218] focus:ring-2 focus:ring-blue-500/15';
const labelCls = 'mb-1.5 block text-[13px] font-medium tracking-wide text-neutral-400';

export const ProfilePage: React.FC = () => {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { user, setUser, token } = useAuthStore();
  const [saving, setSaving] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const [form, setForm] = useState<ProfileForm>({
    firstName: '',
    lastName: '',
    email: '',
    avatar: '',
    password: '',
    confirmPassword: '',
  });

  useEffect(() => {
    if (user) {
      setForm((prev) => ({
        ...prev,
        firstName: (user as any).firstName || '',
        lastName: (user as any).lastName || '',
        email: user.email || '',
        avatar: (user as any).avatar || '',
      }));
    }
  }, [user]);

  const handleSave = async () => {
    if (form.password && form.password !== form.confirmPassword) {
      toast.error(t('profile.passwordsDontMatch', 'Senhas não conferem'));
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      if (form.firstName !== (user as any).firstName) payload.firstName = form.firstName;
      if (form.lastName !== (user as any).lastName) payload.lastName = form.lastName;
      if (form.avatar !== (user as any).avatar) payload.avatar = form.avatar;
      if (form.password) payload.password = form.password;

      if (Object.keys(payload).length > 0) {
        const res = await api.put('/users/me', payload);
        const updated = res.data;

        setUser({
          ...user!,
          ...updated,
          firstName: updated.firstName,
          lastName: updated.lastName,
        });

        toast.success(t('profile.saved', 'Perfil atualizado'));
      }

      setForm((prev) => ({ ...prev, password: '', confirmPassword: '' }));
    } catch (err: any) {
      toast.error(err?.response?.data?.message || t('profile.saveError', 'Erro ao salvar'));
    } finally {
      setSaving(false);
    }
  };

  const initial = (form.firstName || form.email || '?').charAt(0).toUpperCase();
  const showAvatar = !!form.avatar && !avatarError;

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#0d0d0e] text-neutral-100">
      {/* Mount animation + faint atmospheric glow — calm, not flashy. */}
      <style>{`
        @keyframes pf-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        .pf-rise { animation: pf-rise .55s cubic-bezier(.16,1,.3,1) both; }
      `}</style>
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-180px] h-[420px] w-[680px] -translate-x-1/2 rounded-full bg-blue-500/[0.07] blur-[130px]"
      />

      <div className="relative mx-auto max-w-2xl px-5 py-10">
        <button
          type="button"
          onClick={() => navigate('/kanban')}
          className="pf-rise mb-7 inline-flex items-center gap-2 text-sm text-neutral-500 transition-colors duration-200 hover:text-neutral-200"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('profile.backToBoards', 'Voltar aos quadros')}
        </button>

        <div
          className="pf-rise overflow-hidden rounded-2xl border border-white/[0.07] bg-[#161617] shadow-2xl shadow-black/40"
          style={{ animationDelay: '60ms' }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-white/[0.06] px-7 py-5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20">
              <User className="h-[18px] w-[18px]" />
            </span>
            <h1 className="text-[17px] font-semibold tracking-tight text-neutral-50">
              {t('profile.title', 'Meu Perfil')}
            </h1>
          </div>

          <div className="space-y-6 px-7 py-7">
            {/* Avatar */}
            <div className="pf-rise flex items-center gap-5" style={{ animationDelay: '110ms' }}>
              {showAvatar ? (
                <img
                  src={form.avatar}
                  alt={initial}
                  onError={() => setAvatarError(true)}
                  className="h-16 w-16 shrink-0 rounded-full object-cover ring-1 ring-white/10 shadow-lg shadow-black/40"
                />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-2xl font-semibold text-white ring-1 ring-white/10 shadow-lg shadow-blue-900/40">
                  {initial}
                </div>
              )}
              <div className="flex-1">
                <label className={labelCls}>{t('profile.avatar', 'Avatar URL')}</label>
                <input
                  type="text"
                  value={form.avatar}
                  onChange={(e) => {
                    setAvatarError(false);
                    setForm((f) => ({ ...f, avatar: e.target.value }));
                  }}
                  placeholder="https://..."
                  className={inputCls}
                />
              </div>
            </div>

            {/* Name fields */}
            <div className="pf-rise grid grid-cols-2 gap-4" style={{ animationDelay: '150ms' }}>
              <div>
                <label className={labelCls}>{t('profile.firstName', 'Nome')}</label>
                <input
                  type="text"
                  value={form.firstName}
                  onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>{t('profile.lastName', 'Sobrenome')}</label>
                <input
                  type="text"
                  value={form.lastName}
                  onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                  className={inputCls}
                />
              </div>
            </div>

            {/* Email (read-only) */}
            <div className="pf-rise" style={{ animationDelay: '190ms' }}>
              <label className={labelCls}>{t('profile.email', 'Email')}</label>
              <div className="relative">
                <input
                  type="email"
                  value={form.email}
                  readOnly
                  className="w-full cursor-not-allowed rounded-lg border border-white/[0.06] bg-[#0b0b0c] px-3.5 py-2.5 pr-10 text-sm text-neutral-500 outline-none"
                />
                <Lock className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
              </div>
            </div>

            {/* Password */}
            <div className="pf-rise" style={{ animationDelay: '230ms' }}>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>{t('profile.newPassword', 'Nova senha')}</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="••••••••"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>{t('profile.confirmPassword', 'Confirmar senha')}</label>
                  <input
                    type="password"
                    value={form.confirmPassword}
                    onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                    placeholder="••••••••"
                    className={inputCls}
                  />
                </div>
              </div>
              <p className="mt-2 text-xs text-neutral-600">
                {t('profile.passwordHint', 'Deixe em branco para manter a senha atual.')}
              </p>
            </div>

            {/* Save */}
            <div
              className="pf-rise flex justify-end border-t border-white/[0.06] pt-6"
              style={{ animationDelay: '270ms' }}
            >
              <button
                type="button"
                disabled={saving}
                onClick={handleSave}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-600/20 transition-all duration-200 hover:bg-blue-500 hover:shadow-blue-500/30 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {saving ? t('profile.saving', 'Salvando...') : t('profile.save', 'Salvar')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
