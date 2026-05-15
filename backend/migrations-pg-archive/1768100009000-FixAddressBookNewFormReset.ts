import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixAddressBookNewFormReset1768100009000 implements MigrationInterface {
  name = 'FixAddressBookNewFormReset1768100009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const apps = await queryRunner.query(
      `SELECT id, pages, navigation FROM app_templates WHERE name = 'agenda-enderecos' LIMIT 1`
    );
    if (!apps || apps.length === 0) return;

    const pages = apps[0].pages;
    const navigation = apps[0].navigation;

    // 1. Update "+ Novo Endereço" button in page_lista to reset before navigate
    const listPage = pages.find((p: any) => p.id === 'page_lista');
    if (listPage) {
      const newBtn = listPage.components.find((c: any) => c.id === 'btn_novo');
      if (newBtn) {
        newBtn.events.onClick = {
          type: 'reset',
          onSuccess: { type: 'navigate', url: '/formulario' },
        };
      }
    }

    // 2. Update "Novo Endereço" sidebar nav item to use action with reset
    if (navigation && navigation.items) {
      for (const item of navigation.items) {
        if (item.pageId === 'page_formulario') {
          item.action = {
            type: 'reset',
            onSuccess: { type: 'navigate', url: '/formulario' },
          };
          // Keep pageId for active state highlighting
        }
      }
    }

    await queryRunner.query(
      `UPDATE app_templates SET pages = $1::jsonb, navigation = $2::jsonb, "updatedAt" = NOW() WHERE id = $3`,
      [JSON.stringify(pages), JSON.stringify(navigation), apps[0].id]
    );

    console.log('Updated Novo Endereço button and nav to reset form before navigating');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback needed
  }
}
