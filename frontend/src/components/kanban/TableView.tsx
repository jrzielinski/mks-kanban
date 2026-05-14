// flowbuilder/src/components/kanban/TableView.tsx
import React, { useMemo, useRef } from 'react';
import DataTable from 'datatables.net-react';
import DT from 'datatables.net-dt';
import 'datatables.net-dt/css/dataTables.dataTables.min.css';
import 'datatables.net-select-dt';
import 'datatables.net-select-dt/css/select.dataTables.min.css';
import 'datatables.net-responsive-dt';
import { LayoutGrid } from 'lucide-react';
import { KanbanList, KanbanCard, KanbanBoardMember } from '@/services/kanban.service';

DataTable.use(DT);

interface Props {
  lists: KanbanList[];
  boardMembers: KanbanBoardMember[];
  onCardClick: (card: KanbanCard) => void;
}

type CardRow = KanbanCard & {
  listTitle: string;
  _listId: string;
};

function dueBadgeHtml(dueDate: string): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(dueDate);
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((dDay.getTime() - today.getTime()) / 86400000);
  const label = diff === 0 ? 'Hoje' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  const cls = diff < 0
    ? 'background:#ffeceb;color:#ae2a19'
    : diff === 0
      ? 'background:#fff7d6;color:#7f5f01'
      : 'background:#e9eef5;color:#626f86';
  return `<span style="display:inline-flex;align-items:center;gap:3px;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:500;${cls}">📅 ${label}</span>`;
}

export const TableView: React.FC<Props> = ({ lists, boardMembers, onCardClick }) => {
  const cardMapRef = useRef<Map<string, KanbanCard>>(new Map());

  const tableData = useMemo(() => {
    const map = new Map<string, KanbanCard>();
    const rows: CardRow[] = [];
    for (const list of lists) {
      for (const card of list.cards) {
        map.set(card.id, card);
        rows.push({ ...card, listTitle: list.title, _listId: list.id });
      }
    }
    cardMapRef.current = map;
    return rows;
  }, [lists]);

  const columns = useMemo(() => [
    {
      title: 'Card',
      data: 'title',
      render: (data: string, _type: string, row: CardRow) => {
        const cover = row.coverColor && row.coverColor !== '#ffffff'
          ? `<span style="display:inline-block;width:4px;height:16px;border-radius:2px;background:${row.coverColor};margin-right:6px;flex-shrink:0;vertical-align:middle"></span>`
          : '';
        const stickers = row.stickers?.slice(0, 2).join('') ?? '';
        return `<span style="display:flex;align-items:center;gap:4px">${cover}<span style="font-weight:500;color:#172b4d">${data}</span>${stickers ? `<span>${stickers}</span>` : ''}</span>`;
      },
    },
    {
      title: 'Lista',
      data: 'listTitle',
      render: (data: string) =>
        `<span style="background:#f1f2f4;color:#44546f;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;white-space:nowrap">${data}</span>`,
    },
    {
      title: 'Membros',
      data: 'memberIds',
      orderable: false,
      render: (ids: string[] | null) => {
        if (!ids?.length) return '';
        const avatars = ids.slice(0, 4).map((id) => {
          const m = boardMembers.find(bm => bm.id === id);
          const color = m?.avatarColor || '#579dff';
          const initials = m ? m.name.slice(0, 2).toUpperCase() : '?';
          return `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;border:2px solid #fff;background:${color};color:#fff;font-size:9px;font-weight:700;margin-right:-4px" title="${m?.name ?? id}">${initials}</span>`;
        }).join('');
        const extra = ids.length > 4 ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;border:2px solid #fff;background:#e9eef5;color:#626f86;font-size:9px;font-weight:700">+${ids.length - 4}</span>` : '';
        return `<span style="display:flex;align-items:center">${avatars}${extra}</span>`;
      },
    },
    {
      title: 'Etiquetas',
      data: 'labels',
      orderable: false,
      render: (labels: Array<{ color: string; text?: string }> | null) => {
        if (!labels?.length) return '';
        const chips = labels.slice(0, 4).map(l => {
          const text = l.text && l.text.length < 14 ? l.text : '';
          return `<span style="display:inline-flex;align-items:center;background:${l.color};color:#fff;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:600;margin-right:3px;white-space:nowrap">${text || '&nbsp;&nbsp;&nbsp;&nbsp;'}</span>`;
        }).join('');
        const more = labels.length > 4 ? `<span style="font-size:10px;color:#626f86">+${labels.length - 4}</span>` : '';
        return `<span style="display:flex;align-items:center;flex-wrap:wrap;gap:2px">${chips}${more}</span>`;
      },
    },
    {
      title: 'Vencimento',
      data: 'dueDate',
      render: (val: string | null) => val ? dueBadgeHtml(val) : '',
      type: 'date',
    },
    {
      title: 'Checklist',
      data: null,
      orderable: true,
      render: (_val: null, _type: string, row: CardRow) => {
        const items = row.checklists?.flatMap(g => g.items) ?? row.checklist ?? [];
        if (!items.length) return '';
        const done = items.filter(i => i.done).length;
        const allDone = done === items.length;
        const cls = allDone ? 'background:#1f845a;color:#fff' : 'background:#f1f2f4;color:#626f86';
        return `<span style="display:inline-flex;align-items:center;gap:3px;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:500;${cls}">✓ ${done}/${items.length}</span>`;
      },
    },
    {
      title: 'Extras',
      data: null,
      orderable: false,
      render: (_val: null, _type: string, row: CardRow) => {
        const parts: string[] = [];
        if ((row.commentCount ?? 0) > 0) parts.push(`<span style="font-size:11px;color:#8590a2">💬 ${row.commentCount}</span>`);
        if (row.attachments?.length) parts.push(`<span style="font-size:11px;color:#8590a2">📎 ${row.attachments.length}</span>`);
        if ((row.votes?.length ?? 0) > 0) parts.push(`<span style="font-size:11px;color:#8590a2">👍 ${row.votes!.length}</span>`);
        return `<span style="display:flex;align-items:center;gap:8px">${parts.join('')}</span>`;
      },
    },
  ], [boardMembers]);

  return (
    <div className="flex w-full flex-col overflow-visible">
      {/* View header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4 text-[#626f86] dark:text-gray-400" />
          <h2 className="text-sm font-semibold text-[#172b4d] dark:text-gray-100">Tabela</h2>
        </div>
        <span className="text-xs text-[#626f86] dark:text-gray-400">{tableData.length} cards</span>
      </div>

      {/* DataTables — a view de tabela cresce com o conteúdo; a página externa faz o scroll */}
      <div className="kanban-table-view overflow-visible p-4">
        <style>{`
          .kanban-table-view table.dataTable {
            border-collapse: collapse !important;
            width: 100% !important;
          }
          .kanban-table-view table.dataTable thead th {
            background: #f8fafc;
            color: #626f86;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            font-weight: 600;
            border-bottom: 2px solid #e2e6ea !important;
            padding: 10px 12px !important;
            white-space: nowrap;
          }
          .kanban-table-view table.dataTable thead th:hover {
            color: #172b4d;
          }
          .kanban-table-view table.dataTable tbody tr {
            cursor: pointer;
            transition: background 0.1s;
          }
          .kanban-table-view table.dataTable tbody tr:hover {
            background: #f0f4ff !important;
          }
          .kanban-table-view table.dataTable tbody td {
            color: #172b4d;
            border-bottom: 1px solid #f1f2f4 !important;
            padding: 9px 12px !important;
            vertical-align: middle;
          }
          .kanban-table-view .dataTables_wrapper .dataTables_length,
          .kanban-table-view .dataTables_wrapper .dataTables_filter,
          .kanban-table-view .dataTables_wrapper .dataTables_info,
          .kanban-table-view .dataTables_wrapper .dataTables_paginate {
            font-size: 13px;
            color: #626f86;
            padding: 8px 0;
          }
          .kanban-table-view .dataTables_wrapper .dataTables_filter input {
            border: 1px solid #cfd3d8;
            border-radius: 8px;
            padding: 6px 12px;
            outline: none;
            margin-left: 6px;
            font-size: 13px;
          }
          .kanban-table-view .dataTables_wrapper .dataTables_filter input:focus {
            border-color: #0c66e4;
            box-shadow: 0 0 0 2px rgba(12,102,228,0.12);
          }
          .kanban-table-view .dataTables_wrapper .dataTables_paginate .paginate_button {
            border: 1px solid #cfd3d8 !important;
            border-radius: 6px !important;
            margin: 0 2px;
            color: #44546f !important;
            background: #fff !important;
            padding: 4px 10px !important;
          }
          .kanban-table-view .dataTables_wrapper .dataTables_paginate .paginate_button.current {
            background: #0c66e4 !important;
            color: #fff !important;
            border-color: #0c66e4 !important;
          }
          .kanban-table-view .dataTables_wrapper .dataTables_paginate .paginate_button:hover {
            background: #e9f2ff !important;
            color: #0c66e4 !important;
          }
          .kanban-table-view .dataTables_wrapper .dataTables_paginate .paginate_button.current:hover {
            background: #0055cc !important;
            color: #fff !important;
          }
          .kanban-table-view .dataTables_wrapper {
            height: auto !important;
            min-height: 0 !important;
          }
          .kanban-table-view .dataTables_wrapper .dataTables_scroll,
          .kanban-table-view .dataTables_wrapper .dataTables_scrollBody {
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
          }
          .kanban-table-view .dataTables_wrapper table.dataTable.no-footer {
            margin-bottom: 0 !important;
          }
          .kanban-table-view .dataTables_wrapper .dataTables_length select {
            border: 1px solid #cfd3d8;
            border-radius: 6px;
            padding: 4px 8px;
            margin: 0 4px;
            outline: none;
            font-size: 13px;
          }
          .kanban-table-view table.dataTable tbody tr.selected > * {
            box-shadow: inset 0 0 0 9999px rgba(12, 102, 228, 0.08) !important;
          }
        `}</style>

        <DataTable
          key={`kanban-table-${lists.map(l => l.id).join('-')}`}
          data={tableData}
          columns={columns}
          className="display stripe"
          options={{
            paging: true,
            searching: true,
            pageLength: 25,
            lengthMenu: [[10, 25, 50, 100, -1], ['10', '25', '50', '100', 'Todos']],
            lengthChange: true,
            ordering: true,
            order: [[1, 'asc']],
            info: true,
            autoWidth: false,
            responsive: false,
            deferRender: true,
            scrollX: false,
            select: { style: 'multi' as any },
            language: {
              search: 'Buscar:',
              lengthMenu: 'Mostrar _MENU_ por página',
              info: 'Mostrando _START_ a _END_ de _TOTAL_ cards',
              infoEmpty: 'Mostrando 0 a 0 de 0 cards',
              infoFiltered: '(filtrado de _MAX_ cards)',
              paginate: {
                first: '«',
                last: '»',
                next: '›',
                previous: '‹',
              },
              zeroRecords: 'Nenhum card encontrado',
              emptyTable: 'Nenhum card disponível',
              select: {
                rows: { _: '%d cards selecionados', 0: '', 1: '1 card selecionado' },
              } as any,
            },
            // @ts-ignore
            createdRow: (row: HTMLElement, rowData: CardRow) => {
              row.addEventListener('click', (e) => {
                // Ignore clicks on the select checkbox area only
                const target = e.target as HTMLElement;
                if (target.tagName === 'INPUT' && target.getAttribute('type') === 'checkbox') return;
                const card = cardMapRef.current.get(rowData.id);
                if (card) onCardClick(card);
              });
            },
            columnDefs: [
              { targets: [2, 3, 6], orderable: false },
              { targets: 0, width: '35%' },
            ],
          }}
        />
      </div>
    </div>
  );
};
