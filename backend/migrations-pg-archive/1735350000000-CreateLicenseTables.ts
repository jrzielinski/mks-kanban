import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLicenseTables1735350000000 implements MigrationInterface {
  name = 'CreateLicenseTables1735350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create licenses table
    await queryRunner.query(`
      CREATE TABLE licenses (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        license_key VARCHAR(255) UNIQUE NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        customer_cnpj VARCHAR(18),
        plan_type VARCHAR(50) NOT NULL,
        features JSONB NOT NULL DEFAULT '{}',
        limits JSONB NOT NULL DEFAULT '{}',
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        last_heartbeat TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        installation_id VARCHAR(255),
        max_installations INT DEFAULT 1,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await queryRunner.query(`CREATE INDEX idx_licenses_license_key ON licenses(license_key)`);
    await queryRunner.query(`CREATE INDEX idx_licenses_installation_id ON licenses(installation_id)`);
    await queryRunner.query(`CREATE INDEX idx_licenses_status ON licenses(status)`);

    // Create license_heartbeats table
    await queryRunner.query(`
      CREATE TABLE license_heartbeats (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        license_key VARCHAR(255) NOT NULL,
        installation_id VARCHAR(255) NOT NULL,
        ip_address INET,
        version VARCHAR(50),
        system_info JSONB,
        heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for heartbeats
    await queryRunner.query(`CREATE INDEX idx_heartbeats_license_key ON license_heartbeats(license_key)`);
    await queryRunner.query(`CREATE INDEX idx_heartbeats_installation_id ON license_heartbeats(installation_id)`);
    await queryRunner.query(`CREATE INDEX idx_heartbeats_heartbeat_at ON license_heartbeats(heartbeat_at)`);

    // Create license_audit_logs table
    await queryRunner.query(`
      CREATE TABLE license_audit_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        license_key VARCHAR(255) NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        event_data JSONB,
        ip_address INET,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for audit logs
    await queryRunner.query(`CREATE INDEX idx_audit_license_key ON license_audit_logs(license_key)`);
    await queryRunner.query(`CREATE INDEX idx_audit_event_type ON license_audit_logs(event_type)`);
    await queryRunner.query(`CREATE INDEX idx_audit_created_at ON license_audit_logs(created_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS license_audit_logs CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS license_heartbeats CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS licenses CASCADE`);
  }
}
