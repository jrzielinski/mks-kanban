import { MigrationInterface, QueryRunner } from 'typeorm';

export class GrantDatabasePermissions1600000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Grant permissions on public schema
    await queryRunner.query(`
      DO $$
      DECLARE
        db_user TEXT;
      BEGIN
        -- Get current database user
        SELECT current_user INTO db_user;

        -- Only proceed if not running as postgres superuser
        IF db_user != 'postgres' THEN
          -- Grant all privileges on all tables in public schema
          EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO %I', db_user);

          -- Grant all privileges on all sequences in public schema
          EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO %I', db_user);

          -- Set default privileges for future tables
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I', db_user);

          -- Set default privileges for future sequences
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %I', db_user);
        END IF;
      END $$;
    `);

  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback needed - permissions are safe to keep
  }
}
