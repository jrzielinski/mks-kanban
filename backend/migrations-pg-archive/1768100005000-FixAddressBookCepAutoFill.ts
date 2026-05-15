import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixAddressBookCepAutoFill1768100005000 implements MigrationInterface {
  name = 'FixAddressBookCepAutoFill1768100005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Read the current app
    const apps = await queryRunner.query(
      `SELECT id, pages FROM app_templates WHERE name = 'agenda-enderecos' LIMIT 1`
    );
    if (!apps || apps.length === 0) return;

    const pages = apps[0].pages;

    // Find page_formulario
    const formPage = pages.find((p: any) => p.id === 'page_formulario');
    if (!formPage) return;

    // Update CEP button with onSuccess field mappings
    const cepButton = formPage.components.find((c: any) => c.id === 'btn_buscar_cep');
    if (cepButton) {
      cepButton.events = {
        onClick: {
          type: 'executeFlow',
          flowId: 'addr-cep',
          params: [
            { name: 'cep', source: 'component', value: 'form_cep', componentField: 'value' },
          ],
          successMessage: 'CEP encontrado!',
          onSuccess: {
            type: 'setFieldValues',
            fieldMappings: [
              { sourceField: 'variables.cep_result.logradouro', targetComponentId: 'form_logradouro' },
              { sourceField: 'variables.cep_result.bairro', targetComponentId: 'form_bairro' },
              { sourceField: 'variables.cep_result.localidade', targetComponentId: 'form_cidade' },
              { sourceField: 'variables.cep_result.uf', targetComponentId: 'form_estado' },
            ],
          },
        },
      };
    }

    // Write back
    await queryRunner.query(
      `UPDATE app_templates SET pages = $1::jsonb, "updatedAt" = NOW() WHERE id = $2`,
      [JSON.stringify(pages), apps[0].id]
    );

    console.log('Address book CEP button updated with auto-fill field mappings');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Previous migration has the old version
  }
}
