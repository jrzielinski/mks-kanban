import { MigrationInterface, QueryRunner } from "typeorm";

export class AddApprovalStrategies1761856000000 implements MigrationInterface {
    name = 'AddApprovalStrategies1761856000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add new columns to approvals table
        await queryRunner.query(`
            ALTER TABLE "approvals"
            ADD COLUMN "approvalStrategy" character varying NOT NULL DEFAULT 'first_to_respond'
        `);

        await queryRunner.query(`
            ALTER TABLE "approvals"
            ADD COLUMN "sequentialApprovers" jsonb
        `);

        await queryRunner.query(`
            ALTER TABLE "approvals"
            ADD COLUMN "currentApproverIndex" integer DEFAULT 0
        `);

        // Create approval_votes table
        await queryRunner.query(`
            CREATE TABLE "approval_votes" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "approvalId" uuid NOT NULL,
                "voterId" character varying NOT NULL,
                "decision" character varying NOT NULL,
                "comments" text,
                "responseData" jsonb,
                "votedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_approval_votes" PRIMARY KEY ("id"),
                CONSTRAINT "FK_approval_votes_approval" FOREIGN KEY ("approvalId")
                    REFERENCES "approvals"("id") ON DELETE CASCADE
            )
        `);

        // Create indexes for approval_votes
        await queryRunner.query(`CREATE INDEX "IDX_approval_votes_approvalId" ON "approval_votes" ("approvalId")`);
        await queryRunner.query(`CREATE INDEX "IDX_approval_votes_voterId" ON "approval_votes" ("voterId")`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_approval_votes_approvalId_voterId" ON "approval_votes" ("approvalId", "voterId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop indexes
        await queryRunner.query(`DROP INDEX "public"."IDX_approval_votes_approvalId_voterId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approval_votes_voterId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approval_votes_approvalId"`);

        // Drop approval_votes table
        await queryRunner.query(`DROP TABLE "approval_votes"`);

        // Remove new columns from approvals table
        await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "currentApproverIndex"`);
        await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "sequentialApprovers"`);
        await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "approvalStrategy"`);
    }
}
