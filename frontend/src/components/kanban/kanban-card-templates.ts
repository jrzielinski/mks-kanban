export const CARD_TEMPLATES = [
  {
    label: 'Bug',
    title: '🐛 Bug: ',
    color: '#f87168',
    labels: [{ text: 'Bug', color: '#f87168' }],
    checklist: [{ id: 'c1', title: 'Checklist', items: [
      { id: 'i1', text: 'Reproduzir o bug', done: false },
      { id: 'i2', text: 'Identificar causa raiz', done: false },
      { id: 'i3', text: 'Aplicar correção', done: false },
      { id: 'i4', text: 'Testar fix', done: false },
    ] }],
  },
  {
    label: 'Feature',
    title: '✨ Feature: ',
    color: '#579dff',
    labels: [{ text: 'Feature', color: '#579dff' }],
    checklist: [{ id: 'c1', title: 'Checklist', items: [
      { id: 'i1', text: 'Definir requisitos', done: false },
      { id: 'i2', text: 'Implementar', done: false },
      { id: 'i3', text: 'Testes', done: false },
      { id: 'i4', text: 'Code review', done: false },
    ] }],
  },
  {
    label: 'Tarefa',
    title: '',
    color: '#36b37e',
    labels: [{ text: 'Tarefa', color: '#36b37e' }],
    checklist: [],
  },
  {
    label: 'Historia',
    title: 'Como usuário, ',
    color: '#9f8fef',
    labels: [{ text: 'Story', color: '#9f8fef' }],
    checklist: [{ id: 'c1', title: 'Critérios de aceite', items: [
      { id: 'i1', text: 'Critério 1', done: false },
    ] }],
  },
];

