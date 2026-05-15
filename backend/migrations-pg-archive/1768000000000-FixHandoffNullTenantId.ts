import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixHandoffNullTenantId1768000000000 implements MigrationInterface {
  name = 'FixHandoffNullTenantId1768000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fix existing handoff records that have NULL tenantId
    await queryRunner.query(`
      UPDATE agent_handoff_queue
      SET "tenantId" = 'staff'
      WHERE "tenantId" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback needed
  }
}
