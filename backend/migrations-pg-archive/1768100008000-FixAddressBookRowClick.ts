import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixAddressBookRowClick1768100008000 implements MigrationInterface {
  name = 'FixAddressBookRowClick1768100008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const apps = await queryRunner.query(
      `SELECT id, pages FROM app_templates WHERE name = 'agenda-enderecos' LIMIT 1`
    );
    if (!apps || apps.length === 0) return;

    const pages = apps[0].pages;

    // Update table onRowClick in page_lista
    const listPage = pages.find((p: any) => p.id === 'page_lista');
    if (listPage) {
      const table = listPage.components.find((c: any) => c.id === 'table_enderecos');
      if (table) {
        table.events.onRowClick = {
          type: 'setFieldValues',
          fieldMappings: [
            { sourceField: 'row.id', targetComponentId: 'form_id' },
            { sourceField: 'row.nome', targetComponentId: 'form_nome' },
            { sourceField: 'row.telefone', targetComponentId: 'form_telefone' },
            { sourceField: 'row.email', targetComponentId: 'form_email' },
            { sourceField: 'row.cep', targetComponentId: 'form_cep' },
            { sourceField: 'row.logradouro', targetComponentId: 'form_logradouro' },
            { sourceField: 'row.numero', targetComponentId: 'form_numero' },
            { sourceField: 'row.complemento', targetComponentId: 'form_complemento' },
            { sourceField: 'row.bairro', targetComponentId: 'form_bairro' },
            { sourceField: 'row.cidade', targetComponentId: 'form_cidade' },
            { sourceField: 'row.estado', targetComponentId: 'form_estado' },
            { sourceField: 'row.pais', targetComponentId: 'form_pais' },
            { sourceField: 'row.observacoes', targetComponentId: 'form_observacoes' },
          ],
          onSuccess: { type: 'navigate', url: '/formulario' },
        };
      }
    }

    // Update save button to send id (for future update support)
    const formPage = pages.find((p: any) => p.id === 'page_formulario');
    if (formPage) {
      const saveBtn = formPage.components.find((c: any) => c.id === 'btn_salvar');
      if (saveBtn) {
        // Add id param to save button
        const params = saveBtn.events.onClick.params || [];
        if (!params.find((p: any) => p.name === 'id')) {
          params.unshift({ name: 'id', source: 'component', value: 'form_id', componentField: 'value' });
          saveBtn.events.onClick.params = params;
        }
      }
    }

    await queryRunner.query(
      `UPDATE app_templates SET pages = $1::jsonb, "updatedAt" = NOW() WHERE id = $2`,
      [JSON.stringify(pages), apps[0].id]
    );

    console.log('Updated table onRowClick to populate form fields');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback needed
  }
}
