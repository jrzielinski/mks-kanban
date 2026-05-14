import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';

interface LocationSectionProps {
  lat: string;
  lng: string;
  address: string;
  onSave: (lat: string, lng: string, address: string) => Promise<void>;
}

export function LocationSection({ lat, lng, address, onSave }: LocationSectionProps) {
  const { t } = useTranslation();
  const [localLat, setLocalLat] = useState(lat);
  const [localLng, setLocalLng] = useState(lng);
  const [localAddress, setLocalAddress] = useState(address);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 flex-shrink-0 text-[#44546f] dark:text-[#8c9bab]" />
        <input
          value={localAddress}
          onChange={e => setLocalAddress(e.target.value)}
          placeholder={t('kanbanCardDetailModal.placeholders.address')}
          className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf] placeholder-[#8590a2]"
        />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <p className="mb-1 text-[11px] font-medium text-[#44546f] dark:text-[#8c9bab]">
            {t('kanbanCardDetailModal.placeholders.latitude')}
          </p>
          <input
            type="number" step="any"
            value={localLat}
            onChange={e => setLocalLat(e.target.value)}
            placeholder="-23.5505"
            className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf] placeholder-[#8590a2]"
          />
        </div>
        <div className="flex-1">
          <p className="mb-1 text-[11px] font-medium text-[#44546f] dark:text-[#8c9bab]">
            {t('kanbanCardDetailModal.placeholders.longitude')}
          </p>
          <input
            type="number" step="any"
            value={localLng}
            onChange={e => setLocalLng(e.target.value)}
            placeholder="-46.6333"
            className="w-full rounded-lg border border-[#cfd3d8] bg-white px-2.5 py-1.5 text-sm text-[#172b4d] outline-none dark:border-[#3b4754] dark:bg-[#1d2125] dark:text-[#b6c2cf] placeholder-[#8590a2]"
          />
        </div>
      </div>
      <button
        onClick={() => void onSave(localLat, localLng, localAddress)}
        disabled={!localAddress && !localLat && !localLng}
        className="w-full rounded-lg bg-[#579dff] py-1.5 text-sm font-medium text-white hover:bg-[#4c8fe8] disabled:opacity-50"
      >
        {t('kanbanCardDetailModal.actions.save')}
      </button>
    </div>
  );
}
