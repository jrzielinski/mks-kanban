import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateApprovalsSystem1761855565000 implements MigrationInterface {
    name = 'CreateApprovalsSystem1761855565000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create approvals table
        await queryRunner.query(`
            CREATE TABLE "approvals" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "flowExecutionId" character varying NOT NULL,
                "flowId" character varying NOT NULL,
                "nodeId" character varying NOT NULL,
                "status" character varying NOT NULL DEFAULT 'pending',
                "requesterId" character varying,
                "approverId" character varying,
                "approverGroupId" character varying,
                "approvedById" character varying,
                "requestData" jsonb,
                "responseData" jsonb,
                "comments" text,
                "expiresAt" TIMESTAMP,
                "respondedAt" TIMESTAMP,
                "escalationLevel" integer NOT NULL DEFAULT '0',
                "priority" character varying NOT NULL DEFAULT 'medium',
                "title" character varying NOT NULL,
                "description" text,
                "tenantId" character varying,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_approvals" PRIMARY KEY ("id")
            )
        `);

        // Create indexes for approvals
        await queryRunner.query(`CREATE INDEX "IDX_approvals_flowExecutionId" ON "approvals" ("flowExecutionId")`);
        await queryRunner.query(`CREATE INDEX "IDX_approvals_flowId" ON "approvals" ("flowId")`);
        await queryRunner.query(`CREATE INDEX "IDX_approvals_status" ON "approvals" ("status")`);
        await queryRunner.query(`CREATE INDEX "IDX_approvals_approverId_status" ON "approvals" ("approverId", "status")`);
        await queryRunner.query(`CREATE INDEX "IDX_approvals_approverGroupId_status" ON "approvals" ("approverGroupId", "status")`);
        await queryRunner.query(`CREATE INDEX "IDX_approvals_tenantId_status" ON "approvals" ("tenantId", "status")`);
        await queryRunner.query(`CREATE INDEX "IDX_approvals_expiresAt" ON "approvals" ("expiresAt")`);

        // Create approval_history table
        await queryRunner.query(`
            CREATE TABLE "approval_history" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "approvalId" uuid NOT NULL,
                "action" character varying NOT NULL,
                "performedById" character varying,
                "performedByEmail" character varying,
                "performedByName" character varying,
                "previousStatus" character varying,
                "newStatus" character varying,
                "comments" text,
                "metadata" jsonb,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_approval_history" PRIMARY KEY ("id")
            )
        `);

        // Create indexes for approval_history
        await queryRunner.query(`CREATE INDEX "IDX_approval_history_approvalId" ON "approval_history" ("approvalId")`);
        await queryRunner.query(`CREATE INDEX "IDX_approval_history_createdAt" ON "approval_history" ("createdAt")`);

        // Create approval_reminders table
        await queryRunner.query(`
            CREATE TABLE "approval_reminders" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "approvalId" uuid NOT NULL,
                "reminderType" character varying NOT NULL,
                "sentAt" TIMESTAMP NOT NULL DEFAULT now(),
                "recipientId" character varying,
                "recipientEmail" character varying,
                "recipientPhone" character varying,
                "channel" character varying NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_approval_reminders" PRIMARY KEY ("id")
            )
        `);

        // Create index for approval_reminders
        await queryRunner.query(`CREATE INDEX "IDX_approval_reminders_approvalId" ON "approval_reminders" ("approvalId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop indexes
        await queryRunner.query(`DROP INDEX "public"."IDX_approval_reminders_approvalId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approval_history_createdAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approval_history_approvalId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approvals_expiresAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approvals_tenantId_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approvals_approverGroupId_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approvals_approverId_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approvals_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approvals_flowId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_approvals_flowExecutionId"`);

        // Drop tables
        await queryRunner.query(`DROP TABLE "approval_reminders"`);
        await queryRunner.query(`DROP TABLE "approval_history"`);
        await queryRunner.query(`DROP TABLE "approvals"`);
    }
}
