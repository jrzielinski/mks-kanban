import { MigrationInterface, QueryRunner } from 'typeorm';

export class SeedAddressBookApp1768100002000 implements MigrationInterface {
  name = 'SeedAddressBookApp1768100002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Get admin user
    const adminUser = await queryRunner.query(`
      SELECT id, "tenantId" FROM "user" WHERE email = 'admin@zielinski.dev.br' LIMIT 1
    `);

    if (!adminUser || adminUser.length === 0) {
      console.log('Admin user not found, skipping address book app seed');
      return;
    }

    const tenantId = adminUser[0].tenantId;

    // Check if app already exists
    const existing = await queryRunner.query(`
      SELECT id FROM app_templates WHERE name = 'agenda-enderecos' AND "tenantId" = $1 LIMIT 1
    `, [tenantId]);

    if (existing && existing.length > 0) {
      console.log('Address book app already exists, skipping');
      return;
    }

    const estados = [
      'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
      'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN',
      'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
    ];

    // App definition V2
    const pages = [
      // ===== PAGE 1: Lista de Endereços =====
      {
        id: 'page_lista',
        name: 'enderecos',
        title: 'Endereços',
        icon: 'MapPin',
        route: '/',
        isDefault: true,
        layout: { type: 'full' },
        components: [
          // Header
          {
            id: 'header_lista',
            type: 'container',
            position: { x: 0, y: 0, width: 100, height: 60, zIndex: 1 },
            props: {
              direction: 'row',
              justify: 'space-between',
              align: 'center',
              padding: '16px',
              gap: '16px',
            },
            children: ['title_lista', 'btn_novo'],
          },
          {
            id: 'title_lista',
            type: 'text',
            position: { x: 0, y: 0, width: 50, height: 40, zIndex: 1 },
            props: {
              content: 'Agenda de Endereços',
              variant: 'h2',
              fontWeight: 'bold',
              fontSize: 24,
            },
          },
          {
            id: 'btn_novo',
            type: 'button',
            position: { x: 70, y: 0, width: 20, height: 40, zIndex: 1 },
            props: {
              label: '+ Novo Endereço',
              variant: 'primary',
              size: 'md',
            },
            events: {
              onClick: {
                type: 'navigate',
                url: '/formulario',
              },
            },
          },
          // Search bar
          {
            id: 'container_busca',
            type: 'container',
            position: { x: 0, y: 60, width: 100, height: 50, zIndex: 1 },
            props: {
              direction: 'row',
              gap: '8px',
              padding: '0 16px 16px',
              align: 'center',
            },
            children: ['input_busca', 'btn_buscar'],
          },
          {
            id: 'input_busca',
            type: 'input',
            position: { x: 0, y: 60, width: 70, height: 40, zIndex: 1 },
            props: {
              placeholder: 'Buscar por nome, cidade ou email...',
              type: 'text',
            },
          },
          {
            id: 'btn_buscar',
            type: 'button',
            position: { x: 75, y: 60, width: 15, height: 40, zIndex: 1 },
            props: {
              label: 'Buscar',
              variant: 'secondary',
              size: 'md',
            },
            events: {
              onClick: {
                type: 'refresh',
                dataSourceId: 'ds_list',
              },
            },
          },
          // Data Table
          {
            id: 'table_enderecos',
            type: 'table',
            position: { x: 0, y: 120, width: 100, height: 500, zIndex: 1 },
            props: {
              columns: [
                { key: 'nome', header: 'Nome', sortable: true },
                { key: 'telefone', header: 'Telefone' },
                { key: 'email', header: 'Email' },
                { key: 'cidade', header: 'Cidade', sortable: true },
                { key: 'estado', header: 'UF', width: 60 },
                { key: 'cep', header: 'CEP' },
              ],
              pageSize: 20,
              showPagination: true,
              striped: true,
              hoverable: true,
              emptyMessage: 'Nenhum endereço cadastrado',
            },
            dataBinding: {
              sourceId: 'ds_list',
              field: 'variables.postgres_result.rows',
            },
            events: {
              onRowClick: {
                type: 'navigate',
                url: '/formulario',
              },
            },
          },
        ],
      },
      // ===== PAGE 2: Formulário =====
      {
        id: 'page_formulario',
        name: 'formulario',
        title: 'Formulário',
        icon: 'FileEdit',
        route: '/formulario',
        isDefault: false,
        layout: { type: 'full' },
        components: [
          // Header
          {
            id: 'header_form',
            type: 'container',
            position: { x: 0, y: 0, width: 100, height: 60, zIndex: 1 },
            props: {
              direction: 'row',
              justify: 'space-between',
              align: 'center',
              padding: '16px',
            },
            children: ['title_form', 'btn_voltar'],
          },
          {
            id: 'title_form',
            type: 'text',
            position: { x: 0, y: 0, width: 60, height: 40, zIndex: 1 },
            props: {
              content: 'Cadastro de Endereço',
              variant: 'h2',
              fontWeight: 'bold',
              fontSize: 24,
            },
          },
          {
            id: 'btn_voltar',
            type: 'button',
            position: { x: 80, y: 0, width: 15, height: 40, zIndex: 1 },
            props: {
              label: 'Voltar',
              variant: 'secondary',
              size: 'md',
            },
            events: {
              onClick: {
                type: 'navigate',
                url: '/',
              },
            },
          },
          // Form container
          {
            id: 'form_container',
            type: 'container',
            position: { x: 0, y: 70, width: 100, height: 800, zIndex: 1 },
            props: {
              direction: 'column',
              gap: '16px',
              padding: '16px',
              maxWidth: '800px',
            },
            children: [
              'form_nome', 'form_row_contato',
              'form_divider_endereco', 'form_row_cep',
              'form_logradouro', 'form_row_numero',
              'form_row_bairro_cidade', 'form_row_estado',
              'form_observacoes', 'form_actions',
            ],
          },
          // Nome
          {
            id: 'form_nome',
            type: 'input',
            position: { x: 0, y: 80, width: 100, height: 60, zIndex: 1 },
            props: {
              label: 'Nome Completo',
              placeholder: 'Digite o nome completo',
              type: 'text',
              required: true,
            },
          },
          // Contato row
          {
            id: 'form_row_contato',
            type: 'container',
            position: { x: 0, y: 150, width: 100, height: 60, zIndex: 1 },
            props: { direction: 'row', gap: '16px' },
            children: ['form_telefone', 'form_email'],
          },
          {
            id: 'form_telefone',
            type: 'input',
            position: { x: 0, y: 150, width: 45, height: 60, zIndex: 1 },
            props: {
              label: 'Telefone',
              placeholder: '(11) 99999-9999',
              type: 'tel',
            },
          },
          {
            id: 'form_email',
            type: 'input',
            position: { x: 50, y: 150, width: 45, height: 60, zIndex: 1 },
            props: {
              label: 'Email',
              placeholder: 'email@exemplo.com',
              type: 'email',
            },
          },
          // Divider endereço
          {
            id: 'form_divider_endereco',
            type: 'divider',
            position: { x: 0, y: 220, width: 100, height: 20, zIndex: 1 },
            props: { label: 'Endereço' },
          },
          // CEP row
          {
            id: 'form_row_cep',
            type: 'container',
            position: { x: 0, y: 250, width: 100, height: 60, zIndex: 1 },
            props: { direction: 'row', gap: '16px', align: 'flex-end' },
            children: ['form_cep', 'btn_buscar_cep'],
          },
          {
            id: 'form_cep',
            type: 'input',
            position: { x: 0, y: 250, width: 30, height: 60, zIndex: 1 },
            props: {
              label: 'CEP',
              placeholder: '00000-000',
              type: 'text',
              maxLength: 9,
            },
          },
          {
            id: 'btn_buscar_cep',
            type: 'button',
            position: { x: 35, y: 250, width: 20, height: 40, zIndex: 1 },
            props: {
              label: 'Buscar CEP',
              variant: 'secondary',
              size: 'sm',
            },
            events: {
              onClick: {
                type: 'executeFlow',
                flowId: 'addr-cep',
                params: [
                  { name: 'cep', source: 'component', value: 'form_cep', componentField: 'value' },
                ],
                successMessage: 'CEP encontrado!',
                onSuccess: {
                  type: 'setValue',
                  targetComponentId: 'form_logradouro',
                  value: '{{response.variables.cep_result.logradouro}}',
                },
              },
            },
          },
          // Logradouro
          {
            id: 'form_logradouro',
            type: 'input',
            position: { x: 0, y: 320, width: 100, height: 60, zIndex: 1 },
            props: {
              label: 'Logradouro',
              placeholder: 'Rua, Avenida...',
              type: 'text',
            },
          },
          // Número + Complemento
          {
            id: 'form_row_numero',
            type: 'container',
            position: { x: 0, y: 390, width: 100, height: 60, zIndex: 1 },
            props: { direction: 'row', gap: '16px' },
            children: ['form_numero', 'form_complemento'],
          },
          {
            id: 'form_numero',
            type: 'input',
            position: { x: 0, y: 390, width: 25, height: 60, zIndex: 1 },
            props: {
              label: 'Número',
              placeholder: '123',
              type: 'text',
            },
          },
          {
            id: 'form_complemento',
            type: 'input',
            position: { x: 30, y: 390, width: 65, height: 60, zIndex: 1 },
            props: {
              label: 'Complemento',
              placeholder: 'Apto, Sala, etc.',
              type: 'text',
            },
          },
          // Bairro + Cidade
          {
            id: 'form_row_bairro_cidade',
            type: 'container',
            position: { x: 0, y: 460, width: 100, height: 60, zIndex: 1 },
            props: { direction: 'row', gap: '16px' },
            children: ['form_bairro', 'form_cidade'],
          },
          {
            id: 'form_bairro',
            type: 'input',
            position: { x: 0, y: 460, width: 45, height: 60, zIndex: 1 },
            props: {
              label: 'Bairro',
              placeholder: 'Nome do bairro',
              type: 'text',
            },
          },
          {
            id: 'form_cidade',
            type: 'input',
            position: { x: 50, y: 460, width: 45, height: 60, zIndex: 1 },
            props: {
              label: 'Cidade',
              placeholder: 'Nome da cidade',
              type: 'text',
            },
          },
          // Estado + País
          {
            id: 'form_row_estado',
            type: 'container',
            position: { x: 0, y: 530, width: 100, height: 60, zIndex: 1 },
            props: { direction: 'row', gap: '16px' },
            children: ['form_estado', 'form_pais'],
          },
          {
            id: 'form_estado',
            type: 'select',
            position: { x: 0, y: 530, width: 25, height: 60, zIndex: 1 },
            props: {
              label: 'Estado (UF)',
              placeholder: 'Selecione...',
              options: estados.map(uf => ({ label: uf, value: uf })),
            },
          },
          {
            id: 'form_pais',
            type: 'input',
            position: { x: 30, y: 530, width: 30, height: 60, zIndex: 1 },
            props: {
              label: 'País',
              placeholder: 'Brasil',
              type: 'text',
              defaultValue: 'Brasil',
            },
          },
          // Observações
          {
            id: 'form_observacoes',
            type: 'textarea',
            position: { x: 0, y: 600, width: 100, height: 100, zIndex: 1 },
            props: {
              label: 'Observações',
              placeholder: 'Observações adicionais...',
              rows: 3,
            },
          },
          // Actions
          {
            id: 'form_actions',
            type: 'container',
            position: { x: 0, y: 710, width: 100, height: 50, zIndex: 1 },
            props: {
              direction: 'row',
              gap: '12px',
              justify: 'flex-end',
              padding: '16px 0',
            },
            children: ['btn_cancelar', 'btn_salvar'],
          },
          {
            id: 'btn_cancelar',
            type: 'button',
            position: { x: 60, y: 710, width: 15, height: 40, zIndex: 1 },
            props: {
              label: 'Cancelar',
              variant: 'secondary',
              size: 'md',
            },
            events: {
              onClick: {
                type: 'navigate',
                url: '/',
              },
            },
          },
          {
            id: 'btn_salvar',
            type: 'button',
            position: { x: 80, y: 710, width: 15, height: 40, zIndex: 1 },
            props: {
              label: 'Salvar',
              variant: 'primary',
              size: 'md',
            },
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
                  { name: 'tenantId', source: 'static', value: '' }, // Will be filled by runtime
                ],
                successMessage: 'Endereço salvo com sucesso!',
                onSuccess: {
                  type: 'navigate',
                  url: '/',
                },
              },
            },
          },
        ],
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
        {
          id: 'nav_enderecos',
          label: 'Endereços',
          icon: 'MapPin',
          pageId: 'page_lista',
        },
        {
          id: 'nav_novo',
          label: 'Novo Endereço',
          icon: 'Plus',
          pageId: 'page_formulario',
        },
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
      fontSizeBase: 14,
      fontSizeSmall: 12,
      fontSizeLarge: 16,
      fontSizeH1: 30,
      fontSizeH2: 24,
      fontSizeH3: 20,
      lineHeight: 1.5,
      fontWeightNormal: 400,
      fontWeightMedium: 500,
      fontWeightBold: 700,
      spacingUnit: 4,
      spacingXs: 4,
      spacingSm: 8,
      spacingMd: 16,
      spacingLg: 24,
      spacingXl: 32,
      borderRadius: 8,
      borderRadiusSmall: 4,
      borderRadiusLarge: 12,
      borderRadiusFull: 9999,
      shadowSmall: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
      shadowMedium: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
      shadowLarge: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
      shadowXl: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
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
          { name: 'tenantId', source: 'static', value: '' },
        ],
        responseMapping: {
          dataField: 'variables.postgres_result.rows',
          totalField: 'variables.postgres_result.rows.0.total_count',
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
        responseMapping: { dataField: 'variables.postgres_result.rows.0' },
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

    await queryRunner.query(`
      INSERT INTO app_templates (
        name, title, description,
        components, layout, theme,
        "dataSources", variables,
        "isActive", "isPublic",
        "tenantId", "ownerId",
        pages, navigation, "themeV2", "dataSourcesV2",
        version,
        "createdAt", "updatedAt"
      ) VALUES (
        'agenda-enderecos',
        'Agenda de Endereços',
        'Aplicativo de gerenciamento de endereços com CRUD completo, busca de CEP e DataTable.',
        '[]'::jsonb,
        NULL,
        NULL,
        '[]'::jsonb,
        '[]'::jsonb,
        true,
        true,
        $1,
        $2,
        $3::jsonb,
        $4::jsonb,
        $5::jsonb,
        $6::jsonb,
        1,
        NOW(),
        NOW()
      )
    `, [
      tenantId,
      adminUser[0].id,
      JSON.stringify(pages),
      JSON.stringify(navigation),
      JSON.stringify(themeV2),
      JSON.stringify(dataSourcesV2),
    ]);

    console.log('Address book app seeded successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM app_templates WHERE name = 'agenda-enderecos'
    `);
  }
}
