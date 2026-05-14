// flowbuilder/src/components/kanban/MapView.tsx
import React, { useState, useEffect } from 'react';
import { MapPin } from 'lucide-react';
import { KanbanCard, KanbanList } from '@/services/kanban.service';
import 'leaflet/dist/leaflet.css';

interface MapViewProps {
  lists: KanbanList[];
  onCardClick: (card: KanbanCard) => void;
}

const MapView: React.FC<MapViewProps> = ({ lists, onCardClick }) => {
  const [mapId] = useState(() => `kanban-map-${Math.random().toString(36).slice(2)}`);

  const cards = lists.flatMap((l) => l.cards ?? []).filter((c) => c.location?.lat && c.location?.lng);

  useEffect(() => {
    let mapInstance: any = null;

    const initMap = async () => {
      const L = (await import('leaflet')).default;

      // Fix default icon paths
      (L.Icon.Default.prototype as any)._getIconUrl = undefined;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
        iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
      });

      const container = document.getElementById(mapId);
      if (!container) return;

      // Clean up existing instance
      if ((container as any)._leaflet_id) {
        (container as any)._leaflet_id = null;
        container.innerHTML = '';
      }

      mapInstance = L.map(container).setView([-14.235, -51.9253], 4);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(mapInstance);

      if (cards.length > 0) {
        const bounds: [number, number][] = [];
        for (const card of cards) {
          const { lat, lng, address } = card.location!;
          const list = lists.find((l) => l.id === card.listId);
          const listColor = list?.color ?? '#579dff';

          const icon = L.divIcon({
            html: `<div style="background:${listColor};width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
                     <div style="transform:rotate(45deg);color:white;font-size:12px;font-weight:bold;line-height:1;">${card.title[0]}</div>
                   </div>`,
            className: '',
            iconSize: [28, 28],
            iconAnchor: [14, 28],
            popupAnchor: [0, -30],
          });

          const marker = L.marker([lat, lng], { icon }).addTo(mapInstance);
          marker.bindPopup(`
            <div style="min-width:160px;font-family:sans-serif;">
              <div style="font-weight:600;font-size:13px;margin-bottom:4px;">${card.title}</div>
              ${address ? `<div style="font-size:11px;color:#666;margin-bottom:6px;">${address}</div>` : ''}
              <div style="font-size:11px;color:#999;">${list?.title ?? ''}</div>
            </div>
          `);
          marker.on('click', () => onCardClick(card));
          bounds.push([lat, lng]);
        }

        if (bounds.length > 1) {
          mapInstance.fitBounds(bounds, { padding: [40, 40] });
        } else if (bounds.length === 1) {
          mapInstance.setView(bounds[0], 13);
        }
      }
    };

    if (cards.length > 0) {
      initMap();
    }

    return () => {
      if (mapInstance) {
        mapInstance.remove();
      }
    };
  }, [mapId, cards.length]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* View header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-[#626f86] dark:text-gray-400" />
          <h2 className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">Mapa</h2>
        </div>
        <span className="text-xs text-[#626f86] dark:text-gray-400">{cards.length} cards</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden p-4">
        {cards.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-[#8590a2] dark:text-gray-500">
            <MapPin className="mb-2 h-8 w-8 opacity-40" />
            <p className="text-sm font-medium">{'Nenhum card com localizacao'}</p>
            <p className="mt-1 text-xs">{'Adicione localizacao aos cards para ve los no mapa'}</p>
          </div>
        ) : (
          <div
            id={mapId}
            className="w-full h-full rounded-xl border border-slate-200 dark:border-gray-700 overflow-hidden"
            style={{ minHeight: '600px' }}
          />
        )}
      </div>
    </div>
  );
};

export default MapView;

