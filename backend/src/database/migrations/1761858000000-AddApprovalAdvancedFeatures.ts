import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApprovalAdvancedFeatures1761858000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Timeout Action - Ação automática quando expirar
    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "timeoutAction" character varying
      CHECK ("timeoutAction" IN ('auto-reject', 'escalate', 'notify'))
    `);

    // 2. Escalation Rules - Regras de escalação
    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "escalationRules" jsonb
    `);

    // 3. Reassignment - Campos para reatribuição
    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "reassignedFromId" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "reassignmentReason" text
    `);

    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "reassignedAt" TIMESTAMP
    `);

    // 4. Delegation - Campos para delegação
    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "delegatedToId" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "delegatedById" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "delegatedAt" TIMESTAMP
    `);

    // 5. Escalation Tracking - Rastreio de escalações
    // escalationLevel já existe - não precisa adicionar

    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "lastEscalatedAt" TIMESTAMP
    `);

    // 6. Notification Tracking - Rastreio de notificações
    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "lastNotifiedAt" TIMESTAMP
    `);

    await queryRunner.query(`
      ALTER TABLE "approvals"
      ADD COLUMN "notificationCount" integer DEFAULT 0
    `);

    // Criar índices para performance
    await queryRunner.query(`
      CREATE INDEX "IDX_approvals_expiresAt_status"
      ON "approvals" ("expiresAt", "status")
      WHERE "status" = 'pending'
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_approvals_escalationLevel"
      ON "approvals" ("escalationLevel")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_approvals_escalationLevel"`);
    await queryRunner.query(`DROP INDEX "IDX_approvals_expiresAt_status"`);

    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "notificationCount"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "lastNotifiedAt"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "lastEscalatedAt"`);
    // escalationLevel já existia - não remover
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "delegatedAt"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "delegatedById"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "delegatedToId"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "reassignedAt"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "reassignmentReason"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "reassignedFromId"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "escalationRules"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "timeoutAction"`);
  }
}
