import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeFlowIdNullableInFlowExecutions1761599290000 implements MigrationInterface {
  name = 'MakeFlowIdNullableInFlowExecutions1761599290000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Make flow_id nullable to support test executions without saved flows
    await queryRunner.query(
      `ALTER TABLE "flow_executions" ALTER COLUMN "flow_id" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore NOT NULL constraint
    await queryRunner.query(
      `ALTER TABLE "flow_executions" ALTER COLUMN "flow_id" SET NOT NULL`,
    );
  }
}
