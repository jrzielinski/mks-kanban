import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProfessionalAddressBookApp1768100004000 implements MigrationInterface {
  name = 'ProfessionalAddressBookApp1768100004000';

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

    // =============================================
    // PÁGINA 1: LISTA DE ENDEREÇOS
    // =============================================
    // AppRuntime já renderiza <h1>Endereços</h1> automaticamente.
    // Os componentes usam posição absoluta no canvas.
    // Largura total útil: ~1100px (cabe em telas 1366+)

    const W = 1100;     // largura padrão
    const PAD = 20;     // padding interno dos cards
    const FIELD_H = 65; // altura de campo com label
    const GAP = 7;      // gap entre campos
    const CARD_HEADER = 48; // altura do header do card
    const SECTION_GAP = 20; // gap entre cards/seções

    const pageListaComponents = [
      // ── Card de busca (fundo branco com sombra) ──
      {
        id: 'card_busca',
        type: 'card',
        position: { x: 0, y: 0, width: W, height: 66, zIndex: 1 },
        props: { showHeader: false, showFooter: false },
        style: { borderRadius: 12, boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)' },
      },
      // Input de busca (sem label, apenas placeholder)
      {
        id: 'input_busca',
        type: 'input',
        position: { x: 16, y: 13, width: 640, height: 40, zIndex: 2 },
        props: { placeholder: 'Buscar por nome, cidade ou email...', type: 'text' },
      },
      // Botão Buscar
      {
        id: 'btn_buscar',
        type: 'button',
        position: { x: 670, y: 13, width: 120, height: 40, zIndex: 2 },
        props: { text: 'Buscar', variant: 'secondary', size: 'md' },
        events: { onClick: { type: 'refresh', dataSourceId: 'ds_list' } },
      },
      // Botão Novo Endereço
      {
        id: 'btn_novo',
        type: 'button',
        position: { x: 810, y: 13, width: W - 810, height: 40, zIndex: 2 },
        props: { text: '+ Novo Endereço', variant: 'primary', size: 'md' },
        events: { onClick: { type: 'navigate', url: '/formulario' } },
      },

      // ── Tabela de endereços ──
      {
        id: 'table_enderecos',
        type: 'table',
        position: { x: 0, y: 86, width: W, height: 550, zIndex: 1 },
        props: {
          columns: [
            { key: 'nome', header: 'Nome', width: '30%' },
            { key: 'telefone', header: 'Telefone', width: '15%' },
            { key: 'email', header: 'E-mail', width: '22%' },
            { key: 'cidade', header: 'Cidade', width: '18%' },
            { key: 'estado', header: 'UF', width: '5%' },
            { key: 'cep', header: 'CEP', width: '10%' },
          ],
          pageSize: 15,
          showPagination: true,
          rowClickable: true,
        },
        style: { borderRadius: 12, boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1)' },
        dataBinding: {
          sourceId: 'ds_list',
          field: 'rows',
        },
        events: {
          onRowClick: {
            type: 'navigate',
            url: '/formulario',
          },
        },
      },
    ];

    // =============================================
    // PÁGINA 2: FORMULÁRIO DE ENDEREÇO
    // =============================================

    let y = 0;

    // ── Botão Voltar ──
    const btnVoltar = {
      id: 'btn_voltar',
      type: 'button',
      position: { x: 0, y, width: 180, height: 38, zIndex: 1 },
      props: { text: '← Voltar para Lista', variant: 'ghost', size: 'sm' },
      events: { onClick: { type: 'navigate', url: '/' } },
    };
    y += 38 + SECTION_GAP;

    // ── Card: Dados Pessoais ──
    const cardDadosY = y;
    const cardDadosContentY = cardDadosY + CARD_HEADER + GAP;
    const row1Y = cardDadosContentY;
    const row2Y = row1Y + FIELD_H + GAP;
    const cardDadosH = CARD_HEADER + GAP + FIELD_H + GAP + FIELD_H + PAD;

    const cardDadosPessoais = {
      id: 'card_dados_pessoais',
      type: 'card',
      position: { x: 0, y: cardDadosY, width: W, height: cardDadosH, zIndex: 1 },
      props: { showHeader: true, title: 'Dados Pessoais', showFooter: false },
      style: { borderRadius: 12, boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)' },
    };
    const inputNome = {
      id: 'form_nome',
      type: 'input',
      position: { x: PAD, y: row1Y, width: W - PAD * 2, height: FIELD_H, zIndex: 2 },
      props: { label: 'Nome Completo', placeholder: 'Ex: João da Silva', type: 'text', required: true },
    };
    const halfW = Math.floor((W - PAD * 2 - GAP * 2) / 2);
    const inputTelefone = {
      id: 'form_telefone',
      type: 'input',
      position: { x: PAD, y: row2Y, width: halfW, height: FIELD_H, zIndex: 2 },
      props: { label: 'Telefone', placeholder: '(11) 99999-9999', type: 'tel' },
    };
    const inputEmail = {
      id: 'form_email',
      type: 'input',
      position: { x: PAD + halfW + GAP * 2, y: row2Y, width: halfW, height: FIELD_H, zIndex: 2 },
      props: { label: 'E-mail', placeholder: 'email@exemplo.com', type: 'email' },
    };

    y = cardDadosY + cardDadosH + SECTION_GAP;

    // ── Card: Endereço ──
    const cardEndY = y;
    const cardEndContentY = cardEndY + CARD_HEADER + GAP;
    const endRow1Y = cardEndContentY;                          // CEP + botão
    const endRow2Y = endRow1Y + FIELD_H + GAP;                 // Logradouro + Número
    const endRow3Y = endRow2Y + FIELD_H + GAP;                 // Complemento + Bairro
    const endRow4Y = endRow3Y + FIELD_H + GAP;                 // Cidade + Estado + País
    const cardEndH = CARD_HEADER + GAP + (FIELD_H + GAP) * 4 + PAD;

    const cardEndereco = {
      id: 'card_endereco',
      type: 'card',
      position: { x: 0, y: cardEndY, width: W, height: cardEndH, zIndex: 1 },
      props: { showHeader: true, title: 'Endereço', showFooter: false },
      style: { borderRadius: 12, boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)' },
    };
    const inputCep = {
      id: 'form_cep',
      type: 'input',
      position: { x: PAD, y: endRow1Y, width: 220, height: FIELD_H, zIndex: 2 },
      props: { label: 'CEP', placeholder: '00000-000', type: 'text' },
    };
    const btnCep = {
      id: 'btn_buscar_cep',
      type: 'button',
      position: { x: PAD + 220 + GAP * 2, y: endRow1Y + 22, width: 150, height: 40, zIndex: 2 },
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
    };

    const colLargura = Math.floor((W - PAD * 2 - GAP * 2) * 0.7);
    const colNumero = W - PAD * 2 - colLargura - GAP * 2;
    const inputLogradouro = {
      id: 'form_logradouro',
      type: 'input',
      position: { x: PAD, y: endRow2Y, width: colLargura, height: FIELD_H, zIndex: 2 },
      props: { label: 'Logradouro', placeholder: 'Rua, Avenida, Travessa...', type: 'text' },
    };
    const inputNumero = {
      id: 'form_numero',
      type: 'input',
      position: { x: PAD + colLargura + GAP * 2, y: endRow2Y, width: colNumero, height: FIELD_H, zIndex: 2 },
      props: { label: 'Número', placeholder: '123', type: 'text' },
    };

    const inputComplemento = {
      id: 'form_complemento',
      type: 'input',
      position: { x: PAD, y: endRow3Y, width: halfW, height: FIELD_H, zIndex: 2 },
      props: { label: 'Complemento', placeholder: 'Apto 101, Bloco B...', type: 'text' },
    };
    const inputBairro = {
      id: 'form_bairro',
      type: 'input',
      position: { x: PAD + halfW + GAP * 2, y: endRow3Y, width: halfW, height: FIELD_H, zIndex: 2 },
      props: { label: 'Bairro', placeholder: 'Nome do bairro', type: 'text' },
    };

    const col3W = Math.floor((W - PAD * 2 - GAP * 4) / 3);
    const inputCidade = {
      id: 'form_cidade',
      type: 'input',
      position: { x: PAD, y: endRow4Y, width: col3W + 100, height: FIELD_H, zIndex: 2 },
      props: { label: 'Cidade', placeholder: 'Nome da cidade', type: 'text' },
    };
    const inputEstado = {
      id: 'form_estado',
      type: 'select',
      position: { x: PAD + col3W + 100 + GAP * 2, y: endRow4Y, width: 180, height: FIELD_H, zIndex: 2 },
      props: {
        label: 'Estado (UF)',
        placeholder: 'Selecione...',
        options: estados.map(uf => ({ label: uf, value: uf })),
      },
    };
    const inputPais = {
      id: 'form_pais',
      type: 'input',
      position: {
        x: PAD + col3W + 100 + GAP * 2 + 180 + GAP * 2,
        y: endRow4Y,
        width: W - (PAD + col3W + 100 + GAP * 2 + 180 + GAP * 2) - PAD,
        height: FIELD_H,
        zIndex: 2,
      },
      props: { label: 'País', placeholder: 'Brasil', type: 'text', defaultValue: 'Brasil' },
    };

    y = cardEndY + cardEndH + SECTION_GAP;

    // ── Card: Observações ──
    const cardObsY = y;
    const cardObsContentY = cardObsY + CARD_HEADER + GAP;
    const cardObsH = CARD_HEADER + GAP + 100 + PAD;

    const cardObs = {
      id: 'card_observacoes',
      type: 'card',
      position: { x: 0, y: cardObsY, width: W, height: cardObsH, zIndex: 1 },
      props: { showHeader: true, title: 'Observações', showFooter: false },
      style: { borderRadius: 12, boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)' },
    };
    const inputObs = {
      id: 'form_observacoes',
      type: 'textarea',
      position: { x: PAD, y: cardObsContentY, width: W - PAD * 2, height: 100, zIndex: 2 },
      props: { label: 'Notas e observações', placeholder: 'Informações adicionais, referências, pontos de referência...' },
    };

    y = cardObsY + cardObsH + SECTION_GAP;

    // ── Botões de Ação ──
    const btnCancelar = {
      id: 'btn_cancelar',
      type: 'button',
      position: { x: W - 330, y, width: 150, height: 46, zIndex: 1 },
      props: { text: 'Cancelar', variant: 'ghost', size: 'md' },
      events: { onClick: { type: 'navigate', url: '/' } },
    };
    const btnSalvar = {
      id: 'btn_salvar',
      type: 'button',
      position: { x: W - 165, y, width: 165, height: 46, zIndex: 1 },
      props: { text: 'Salvar Endereço', variant: 'primary', size: 'lg' },
      events: {
        onClick: {
          type: 'executeFlow',
          flowId: 'addr-create',
          showLoading: true,
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
          ],
          successMessage: 'Endereço salvo com sucesso!',
          onSuccess: { type: 'navigate', url: '/' },
          errorMessage: 'Erro ao salvar endereço',
        },
      },
    };

    const pageFormComponents = [
      btnVoltar,
      cardDadosPessoais, inputNome, inputTelefone, inputEmail,
      cardEndereco, inputCep, btnCep, inputLogradouro, inputNumero,
      inputComplemento, inputBairro, inputCidade, inputEstado, inputPais,
      cardObs, inputObs,
      btnCancelar, btnSalvar,
    ];

    // =============================================
    // CONFIGURAÇÃO DO APP
    // =============================================

    const pages = [
      {
        id: 'page_lista',
        name: 'enderecos',
        title: 'Endereços',
        icon: 'Home',
        route: '/',
        isDefault: true,
        layout: { type: 'full' },
        components: pageListaComponents,
      },
      {
        id: 'page_formulario',
        name: 'formulario',
        title: 'Cadastro de Endereço',
        icon: 'FileText',
        route: '/formulario',
        isDefault: false,
        layout: { type: 'full' },
        components: pageFormComponents,
      },
    ];

    const navigation = {
      type: 'sidebar',
      title: 'Agenda de Endereços',
      position: 'left',
      width: 260,
      collapsible: true,
      showUserMenu: false,
      items: [
        { id: 'nav_enderecos', label: 'Endereços', icon: 'Home', pageId: 'page_lista' },
        { id: 'nav_novo', label: 'Novo Endereço', icon: 'FileText', pageId: 'page_formulario', dividerAfter: true },
      ],
    };

    const themeV2 = {
      primaryColor: '#2563eb',
      secondaryColor: '#4f46e5',
      accentColor: '#7c3aed',
      backgroundColor: '#f8fafc',
      surfaceColor: '#ffffff',
      textColor: '#0f172a',
      textSecondaryColor: '#64748b',
      borderColor: '#e2e8f0',
      errorColor: '#dc2626',
      successColor: '#16a34a',
      warningColor: '#d97706',
      infoColor: '#2563eb',
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      fontSizeBase: 14,
      fontSizeSmall: 12,
      fontSizeLarge: 16,
      fontSizeH1: 28,
      fontSizeH2: 22,
      fontSizeH3: 18,
      lineHeight: 1.6,
      fontWeightNormal: 400,
      fontWeightMedium: 500,
      fontWeightBold: 600,
      spacingUnit: 4,
      spacingXs: 4,
      spacingSm: 8,
      spacingMd: 16,
      spacingLg: 24,
      spacingXl: 32,
      borderRadius: 8,
      borderRadiusSmall: 6,
      borderRadiusLarge: 12,
      borderRadiusFull: 9999,
      shadowSmall: '0 1px 2px 0 rgba(0,0,0,0.05)',
      shadowMedium: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
      shadowLarge: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
      shadowXl: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
      mode: 'light',
    };

    const dataSourcesV2 = [
      {
        id: 'ds_list',
        name: 'Listar Endereços',
        sourceType: 'flow',
        flowId: 'addr-list',
        method: 'POST',
        trigger: 'onLoad',
        params: [
          { name: 'search', source: 'component', value: 'input_busca', componentField: 'value' },
          { name: 'limit', source: 'static', value: '20' },
          { name: 'offset', source: 'static', value: '0' },
        ],
        responseMapping: {
          dataField: 'variables.postgres_result',
        },
      },
      {
        id: 'ds_create',
        name: 'Criar Endereço',
        sourceType: 'flow',
        flowId: 'addr-create',
        method: 'POST',
        trigger: 'manual',
        params: [],
        responseMapping: { dataField: 'variables.postgres_result' },
      },
      {
        id: 'ds_update',
        name: 'Atualizar Endereço',
        sourceType: 'flow',
        flowId: 'addr-update',
        method: 'POST',
        trigger: 'manual',
        params: [],
        responseMapping: { dataField: 'variables.postgres_result' },
      },
      {
        id: 'ds_delete',
        name: 'Deletar Endereço',
        sourceType: 'flow',
        flowId: 'addr-delete',
        method: 'POST',
        trigger: 'manual',
        params: [],
        responseMapping: { dataField: 'variables.postgres_result' },
      },
      {
        id: 'ds_get',
        name: 'Buscar Endereço',
        sourceType: 'flow',
        flowId: 'addr-get',
        method: 'POST',
        trigger: 'manual',
        params: [],
        responseMapping: { dataField: 'variables.postgres_result' },
      },
      {
        id: 'ds_cep',
        name: 'Buscar CEP',
        sourceType: 'flow',
        flowId: 'addr-cep',
        method: 'POST',
        trigger: 'manual',
        params: [],
        responseMapping: { dataField: 'variables.cep_result' },
      },
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

    console.log('Address book app updated to professional layout with cards and proper spacing');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Previous migration has the old version
  }
}
