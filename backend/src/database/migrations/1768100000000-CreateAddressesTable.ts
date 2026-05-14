import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAddressesTable1768100000000 implements MigrationInterface {
  name = 'CreateAddressesTable1768100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await queryRunner.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'addresses'
    `);

    if (tableExists && tableExists.length > 0) {
      console.log('Table addresses already exists, skipping');
      return;
    }

    await queryRunner.query(`
      CREATE TABLE addresses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id VARCHAR NOT NULL,
        nome VARCHAR(200) NOT NULL,
        telefone VARCHAR(20),
        email VARCHAR(200),
        cep VARCHAR(10),
        logradouro VARCHAR(300),
        numero VARCHAR(20),
        complemento VARCHAR(200),
        bairro VARCHAR(200),
        cidade VARCHAR(200),
        estado CHAR(2),
        pais VARCHAR(100) DEFAULT 'Brasil',
        observacoes TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await queryRunner.query(`CREATE INDEX idx_addresses_tenant ON addresses(tenant_id)`);
    await queryRunner.query(`CREATE INDEX idx_addresses_nome ON addresses(nome)`);
    await queryRunner.query(`CREATE INDEX idx_addresses_cidade ON addresses(cidade)`);
    await queryRunner.query(`CREATE INDEX idx_addresses_cep ON addresses(cep)`);
    await queryRunner.query(`CREATE INDEX idx_addresses_active ON addresses(is_active)`);

    console.log('Table addresses created with indexes');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_addresses_active`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_addresses_cep`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_addresses_cidade`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_addresses_nome`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_addresses_tenant`);
    await queryRunner.query(`DROP TABLE IF EXISTS addresses`);
  }
}
