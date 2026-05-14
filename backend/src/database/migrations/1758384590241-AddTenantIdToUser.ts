import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTenantIdToUser1758384590241 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Check if tenantId column already exists
        const checkColumn = await queryRunner.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='user' AND column_name='tenantId'
        `);

        if (checkColumn.length === 0) {
            // Add tenantId column to user table
            await queryRunner.query(`
                ALTER TABLE "user"
                ADD COLUMN "tenantId" character varying(50) NOT NULL DEFAULT 'staff'
            `);

            // Create index on tenantId column
            await queryRunner.query(`
                CREATE INDEX "IDX_user_tenantId" ON "user" ("tenantId")
            `);
        } else {
            console.log('Column tenantId already exists in user table, skipping...');
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop index
        await queryRunner.query(`DROP INDEX "IDX_user_tenantId"`);

        // Drop tenantId column
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "tenantId"`);
    }

}
