import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixAddressBookApp1768100003000 implements MigrationInterface {
  name = 'FixAddressBookApp1768100003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const adminUser = await queryRunner.query(`
      SELECT id, "tenantId" FROM "user" WHERE email = 'admin@zielinski.dev.br' LIMIT 1
    `);
    if (!adminUser || adminUser.length === 0) return;

    const tenantId = adminUser[0].tenantId;

    const estados = [
      'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA',
      'MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN',
      'RS','RO','RR','SC','SP','SE','TO',
    ];

    // ===== PAGINA 1: LISTA =====
    const pageListaComponents = [
      // Título
      {
        id: 'txt_titulo',
        type: 'text',
        position: { x: 20, y: 10, width: 500, height: 45, zIndex: 1 },
        props: { text: 'Agenda de Endereços', fontSize: 28, fontWeight: 'bold' },
      },
      // Botão Novo Endereço
      {
        id: 'btn_novo',
        type: 'button',
        position: { x: 600, y: 12, width: 200, height: 42, zIndex: 2 },
        props: { text: '+ Novo Endereço', variant: 'primary', size: 'md' },
        events: { onClick: { type: 'navigate', url: '/formulario' } },
      },
      // Campo de busca
      {
        id: 'input_busca',
        type: 'input',
        position: { x: 20, y: 70, width: 600, height: 55, zIndex: 3 },
        props: { label: 'Buscar', placeholder: 'Digite nome, cidade ou email...', type: 'text' },
      },
      // Botão Buscar
      {
        id: 'btn_buscar',
        type: 'button',
        position: { x: 640, y: 85, width: 160, height: 40, zIndex: 4 },
        props: { text: 'Buscar', variant: 'secondary', size: 'md' },
        events: { onClick: { type: 'refresh', dataSourceId: 'ds_list' } },
      },
      // Tabela
      {
        id: 'table_enderecos',
        type: 'table',
        position: { x: 20, y: 140, width: 780, height: 500, zIndex: 5 },
        props: {
          columns: [
            { key: 'nome', header: 'Nome', sortable: true },
            { key: 'telefone', header: 'Telefone' },
            { key: 'email', header: 'Email' },
            { key: 'cidade', header: 'Cidade', sortable: true },
            { key: 'estado', header: 'UF', width: 50 },
            { key: 'cep', header: 'CEP', width: 90 },
          ],
          pageSize: 15,
          showPagination: true,
          striped: true,
          hoverable: true,
          emptyMessage: 'Nenhum endereço cadastrado. Clique em "+ Novo Endereço" para começar.',
        },
        dataBinding: {
          sourceId: 'ds_list',
          field: 'variables.postgres_result.rows',
        },
        events: {
          onRowClick: { type: 'navigate', url: '/formulario' },
        },
      },
    ];

    // ===== PAGINA 2: FORMULÁRIO =====
    const pageFormComponents = [
      // Título
      {
        id: 'txt_titulo_form',
        type: 'text',
        position: { x: 20, y: 10, width: 500, height: 45, zIndex: 1 },
        props: { text: 'Cadastro de Endereço', fontSize: 28, fontWeight: 'bold' },
      },
      // Botão Voltar
      {
        id: 'btn_voltar',
        type: 'button',
        position: { x: 620, y: 12, width: 180, height: 42, zIndex: 2 },
        props: { text: 'Voltar para Lista', variant: 'ghost', size: 'md' },
        events: { onClick: { type: 'navigate', url: '/' } },
      },

      // === DADOS PESSOAIS ===
      {
        id: 'txt_secao_pessoal',
        type: 'text',
        position: { x: 20, y: 70, width: 780, height: 30, zIndex: 3 },
        props: { text: 'Dados Pessoais', fontSize: 16, fontWeight: 'bold' },
      },
      // Nome
      {
        id: 'form_nome',
        type: 'input',
        position: { x: 20, y: 105, width: 780, height: 65, zIndex: 4 },
        props: { label: 'Nome Completo *', placeholder: 'Ex: João da Silva', type: 'text', required: true },
      },
      // Telefone + Email (lado a lado)
      {
        id: 'form_telefone',
        type: 'input',
        position: { x: 20, y: 180, width: 380, height: 65, zIndex: 5 },
        props: { label: 'Telefone', placeholder: '(11) 99999-9999', type: 'tel' },
      },
      {
        id: 'form_email',
        type: 'input',
        position: { x: 420, y: 180, width: 380, height: 65, zIndex: 6 },
        props: { label: 'Email', placeholder: 'email@exemplo.com', type: 'email' },
      },

      // === ENDEREÇO ===
      {
        id: 'txt_secao_endereco',
        type: 'text',
        position: { x: 20, y: 265, width: 780, height: 30, zIndex: 7 },
        props: { text: 'Endereço', fontSize: 16, fontWeight: 'bold' },
      },
      // CEP + Botão Buscar CEP
      {
        id: 'form_cep',
        type: 'input',
        position: { x: 20, y: 300, width: 200, height: 65, zIndex: 8 },
        props: { label: 'CEP', placeholder: '00000-000', type: 'text' },
      },
      {
        id: 'btn_buscar_cep',
        type: 'button',
        position: { x: 235, y: 320, width: 160, height: 40, zIndex: 9 },
        props: { text: 'Buscar CEP', variant: 'secondary', size: 'sm' },
        events: {
          onClick: {
            type: 'executeFlow',
            flowId: 'addr-cep',
            params: [
              { name: 'cep', source: 'component', value: 'form_cep', componentField: 'value' },
            ],
            successMessage: 'CEP encontrado!',
          },
        },
      },
      // Logradouro
      {
        id: 'form_logradouro',
        type: 'input',
        position: { x: 20, y: 375, width: 560, height: 65, zIndex: 10 },
        props: { label: 'Logradouro', placeholder: 'Rua, Avenida, Travessa...', type: 'text' },
      },
      // Número
      {
        id: 'form_numero',
        type: 'input',
        position: { x: 600, y: 375, width: 200, height: 65, zIndex: 11 },
        props: { label: 'Número', placeholder: '123', type: 'text' },
      },
      // Complemento
      {
        id: 'form_complemento',
        type: 'input',
        position: { x: 20, y: 450, width: 780, height: 65, zIndex: 12 },
        props: { label: 'Complemento', placeholder: 'Apto 101, Bloco B, Sala 5...', type: 'text' },
      },
      // Bairro + Cidade (lado a lado)
      {
        id: 'form_bairro',
        type: 'input',
        position: { x: 20, y: 525, width: 380, height: 65, zIndex: 13 },
        props: { label: 'Bairro', placeholder: 'Nome do bairro', type: 'text' },
      },
      {
        id: 'form_cidade',
        type: 'input',
        position: { x: 420, y: 525, width: 380, height: 65, zIndex: 14 },
        props: { label: 'Cidade', placeholder: 'Nome da cidade', type: 'text' },
      },
      // Estado + País (lado a lado)
      {
        id: 'form_estado',
        type: 'select',
        position: { x: 20, y: 600, width: 200, height: 65, zIndex: 15 },
        props: {
          label: 'Estado (UF)',
          placeholder: 'Selecione o estado...',
          options: estados.map(uf => ({ label: uf, value: uf })),
        },
      },
      {
        id: 'form_pais',
        type: 'input',
        position: { x: 240, y: 600, width: 200, height: 65, zIndex: 16 },
        props: { label: 'País', placeholder: 'Brasil', type: 'text', defaultValue: 'Brasil' },
      },

      // === OBSERVAÇÕES ===
      {
        id: 'txt_secao_obs',
        type: 'text',
        position: { x: 20, y: 685, width: 780, height: 30, zIndex: 17 },
        props: { text: 'Informações Adicionais', fontSize: 16, fontWeight: 'bold' },
      },
      {
        id: 'form_observacoes',
        type: 'textarea',
        position: { x: 20, y: 720, width: 780, height: 100, zIndex: 18 },
        props: { label: 'Observações', placeholder: 'Notas, referências, informações extras...', rows: 3 },
      },

      // === BOTÕES DE AÇÃO ===
      {
        id: 'btn_cancelar',
        type: 'button',
        position: { x: 500, y: 840, width: 140, height: 45, zIndex: 19 },
        props: { text: 'Cancelar', variant: 'ghost', size: 'md' },
        events: { onClick: { type: 'navigate', url: '/' } },
      },
      {
        id: 'btn_salvar',
        type: 'button',
        position: { x: 660, y: 840, width: 140, height: 45, zIndex: 20 },
        props: { text: 'Salvar Endereço', variant: 'primary', size: 'md' },
        events: {
          onClick: {
            type: 'executeFlow',
            flowId: 'addr-create',
            params: [
              { name: 'nome', source: 'component', value: 'form_nome', componentField: 'value' },
              { name: 'telefone', source: 'component', value: 'form_telefone', componentField: 'value' },
              { name: 'email', source: 'component', value: 'form_email', componentField: 'value' },
              { name: 'cep', source: 'component', value: 'form_cep', componentField: 'value' },
              { name: 'logradouro', source: 'component', value: 'form_logradouro', componentField: 'value' },
              { name: 'numero', source: 'component', value: 'form_numero', componentField: 'value' },
              { name: 'complemento', source: 'component', value: 'form_complemento', componentField: 'value' },
              { name: 'bairro', source: 'component', value: 'form_bairro', componentField: 'value' },
              { name: 'cidade', source: 'component', value: 'form_cidade', componentField: 'value' },
              { name: 'estado', source: 'component', value: 'form_estado', componentField: 'value' },
              { name: 'pais', source: 'component', value: 'form_pais', componentField: 'value' },
              { name: 'observacoes', source: 'component', value: 'form_observacoes', componentField: 'value' },
              { name: 'tenantId', source: 'static', value: '' },
            ],
            successMessage: 'Endereço salvo com sucesso!',
            onSuccess: { type: 'navigate', url: '/' },
          },
        },
      },
    ];

    const pages = [
      {
        id: 'page_lista',
        name: 'enderecos',
        title: 'Endereços',
        icon: 'MapPin',
        route: '/',
        isDefault: true,
        layout: { type: 'full' },
        components: pageListaComponents,
      },
      {
        id: 'page_formulario',
        name: 'formulario',
        title: 'Formulário',
        icon: 'FileEdit',
        route: '/formulario',
        isDefault: false,
        layout: { type: 'full' },
        components: pageFormComponents,
      },
    ];

    const navigation = {
      type: 'sidebar',
      title: 'Agenda',
      position: 'left',
      width: 220,
      collapsible: true,
      showUserMenu: false,
      items: [
        { id: 'nav_enderecos', label: 'Endereços', icon: 'MapPin', pageId: 'page_lista' },
        { id: 'nav_novo', label: 'Novo Endereço', icon: 'Plus', pageId: 'page_formulario' },
      ],
    };

    const themeV2 = {
      primaryColor: '#3b82f6',
      secondaryColor: '#6366f1',
      accentColor: '#8b5cf6',
      backgroundColor: '#ffffff',
      surfaceColor: '#f9fafb',
      textColor: '#1f2937',
      textSecondaryColor: '#6b7280',
      borderColor: '#e5e7eb',
      errorColor: '#ef4444',
      successColor: '#10b981',
      warningColor: '#f59e0b',
      infoColor: '#3b82f6',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSizeBase: 14, fontSizeSmall: 12, fontSizeLarge: 16,
      fontSizeH1: 30, fontSizeH2: 24, fontSizeH3: 20,
      lineHeight: 1.5,
      fontWeightNormal: 400, fontWeightMedium: 500, fontWeightBold: 700,
      spacingUnit: 4, spacingXs: 4, spacingSm: 8, spacingMd: 16, spacingLg: 24, spacingXl: 32,
      borderRadius: 8, borderRadiusSmall: 4, borderRadiusLarge: 12, borderRadiusFull: 9999,
      shadowSmall: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
      shadowMedium: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
      shadowLarge: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
      shadowXl: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
      mode: 'light',
    };

    const dataSourcesV2 = [
      {
        id: 'ds_list', name: 'Listar Endereços', sourceType: 'flow',
        flowId: 'addr-list', method: 'POST', trigger: 'onLoad',
        params: [
          { name: 'search', source: 'component', value: 'input_busca', componentField: 'value' },
          { name: 'limit', source: 'static', value: '20' },
          { name: 'offset', source: 'static', value: '0' },
          { name: 'tenantId', source: 'static', value: '' },
        ],
        responseMapping: { dataField: 'variables.postgres_result.rows', totalField: 'variables.postgres_result.rows.0.total_count' },
      },
      { id: 'ds_create', name: 'Criar Endereço', sourceType: 'flow', flowId: 'addr-create', method: 'POST', trigger: 'manual', params: [], responseMapping: { dataField: 'variables.postgres_result' } },
      { id: 'ds_update', name: 'Atualizar Endereço', sourceType: 'flow', flowId: 'addr-update', method: 'POST', trigger: 'manual', params: [], responseMapping: { dataField: 'variables.postgres_result' } },
      { id: 'ds_delete', name: 'Deletar Endereço', sourceType: 'flow', flowId: 'addr-delete', method: 'POST', trigger: 'manual', params: [], responseMapping: { dataField: 'variables.postgres_result' } },
      { id: 'ds_get', name: 'Buscar Endereço', sourceType: 'flow', flowId: 'addr-get', method: 'POST', trigger: 'manual', params: [], responseMapping: { dataField: 'variables.postgres_result.rows.0' } },
      { id: 'ds_cep', name: 'Buscar CEP', sourceType: 'flow', flowId: 'addr-cep', method: 'POST', trigger: 'manual', params: [], responseMapping: { dataField: 'variables.cep_result' } },
    ];

    // Update existing app
    await queryRunner.query(`
      UPDATE app_templates SET
        pages = $1::jsonb,
        navigation = $2::jsonb,
        "themeV2" = $3::jsonb,
        "dataSourcesV2" = $4::jsonb,
        components = '[]'::jsonb,
        "updatedAt" = NOW()
      WHERE name = 'agenda-enderecos' AND "tenantId" = $5
    `, [
      JSON.stringify(pages),
      JSON.stringify(navigation),
      JSON.stringify(themeV2),
      JSON.stringify(dataSourcesV2),
      tenantId,
    ]);

    console.log('Address book app FIXED - flat layout, no containers, proper labels');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback needed - previous migration has the old version
  }
}
