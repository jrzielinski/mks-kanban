import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDepartmentsTable1760987493378 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE departments (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR NOT NULL,
                description VARCHAR,
                icon VARCHAR,
                color VARCHAR DEFAULT '#3B82F6',
                active BOOLEAN DEFAULT true,
                "sortOrder" INTEGER DEFAULT 0,
                "tenantId" VARCHAR,
                "createdAt" TIMESTAMP DEFAULT NOW(),
                "updatedAt" TIMESTAMP DEFAULT NOW()
            );
        `);

        await queryRunner.query(`
            CREATE INDEX "IDX_departments_tenantId_active" ON departments("tenantId", active);
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_departments_tenantId_active";`);
        await queryRunner.query(`DROP TABLE IF EXISTS departments;`);
    }

}
