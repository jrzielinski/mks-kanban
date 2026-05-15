import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTokenFirebaseToUsers1762279000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if column exists before adding
    const columnExists = await queryRunner.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'user'
        AND column_name = 'token_firebase'
      );
    `);

    if (!columnExists[0].exists) {
      await queryRunner.query(`
        ALTER TABLE "user"
        ADD COLUMN token_firebase VARCHAR NULL;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user"
      DROP COLUMN IF EXISTS token_firebase;
    `);
  }
}
