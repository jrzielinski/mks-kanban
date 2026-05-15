import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateShortUrls1762520046772 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "short_urls" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "original_url" character varying NOT NULL,
                "short_code" character varying(8) NOT NULL,
                "flow_id" uuid,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_short_urls" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_short_code" UNIQUE ("short_code")
            )
        `);

        await queryRunner.query(`
            CREATE INDEX "IDX_short_urls_short_code" ON "short_urls" ("short_code")
        `);

        await queryRunner.query(`
            CREATE INDEX "IDX_short_urls_flow_id" ON "short_urls" ("flow_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_short_urls_flow_id"`);
        await queryRunner.query(`DROP INDEX "IDX_short_urls_short_code"`);
        await queryRunner.query(`DROP TABLE "short_urls"`);
    }

}
