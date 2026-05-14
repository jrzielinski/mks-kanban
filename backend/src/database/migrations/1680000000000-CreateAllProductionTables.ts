import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAllProductionTables1680000000000 implements MigrationInterface {
  name = 'CreateAllProductionTables1680000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Helper function to create table only if it doesn't exist
    const createTableIfNotExists = async (tableName: string, createSQL: string) => {
      const tableExists = await queryRunner.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '${tableName}'
      `);

      if (!tableExists || tableExists.length === 0) {
        await queryRunner.query(createSQL);
        console.log(`Table ${tableName} created`);
      } else {
        console.log(`Table ${tableName} already exists, skipping`);
      }
    };

    // Create enums first (with existence check)
    const enumExists = await queryRunner.query(`
      SELECT 1 FROM pg_type WHERE typname = 'user_role_enum'
    `);

    if (!enumExists || enumExists.length === 0) {
      await queryRunner.query(`CREATE TYPE "user_role_enum" AS ENUM('user', 'admin', 'doctor', 'patient', 'moderator')`);
    }

    // Create all essential tables from production

    // 1. STATUS table
    await createTableIfNotExists('status', `
      CREATE TABLE "status" (
        "id" SERIAL NOT NULL,
        "name" character varying NOT NULL,
        CONSTRAINT "PK_status" PRIMARY KEY ("id")
      )
    `);

    // 2. ROLE table
    await createTableIfNotExists('role', `
      CREATE TABLE "role" (
        "id" SERIAL NOT NULL,
        "name" character varying NOT NULL,
        CONSTRAINT "PK_role" PRIMARY KEY ("id")
      )
    `);

    // 3. FILE table
    await createTableIfNotExists('file', `
      CREATE TABLE "file" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "path" character varying NOT NULL,
        CONSTRAINT "PK_file" PRIMARY KEY ("id")
      )
    `);

    // 4. USER table
    await createTableIfNotExists('user', `
      CREATE TABLE "user" (
        "id" SERIAL NOT NULL,
        "email" character varying,
        "password" character varying,
        "provider" character varying NOT NULL DEFAULT 'email',
        "socialId" character varying,
        "firstName" character varying,
        "lastName" character varying,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        "deletedAt" timestamp,
        "photoId" uuid,
        "roleId" integer,
        "statusId" integer,
        "phone" character varying,
        "role" "user_role_enum" NOT NULL DEFAULT 'user',
        "professional_id" character varying,
        "department" character varying,
        "specialization" character varying,
        "is_active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_cace4a159ff9f2512dd42373760" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_e12875dfb3b1d92d7d7c5377e22" UNIQUE ("email"),
        CONSTRAINT "UQ_user_phone_unique" UNIQUE ("phone"),
        CONSTRAINT "REL_75e2be4ce11d447ef43be0e374" UNIQUE ("photoId"),
        CONSTRAINT "FK_75e2be4ce11d447ef43be0e374f" FOREIGN KEY ("photoId") REFERENCES "file"("id"),
        CONSTRAINT "FK_c28e52f758e7bbc53828db92194" FOREIGN KEY ("roleId") REFERENCES "role"("id"),
        CONSTRAINT "FK_dc18daa696860586ba4667a9d31" FOREIGN KEY ("statusId") REFERENCES "status"("id")
      )
    `);

    // 5. SESSION table
    await createTableIfNotExists('session', `
      CREATE TABLE "session" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" integer,
        "hash" character varying NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        "deletedAt" timestamp,
        CONSTRAINT "PK_session" PRIMARY KEY ("id"),
        CONSTRAINT "FK_3d2f174ef04fb312fdebd0ddc53" FOREIGN KEY ("userId") REFERENCES "user"("id")
      )
    `);

    // 6. PHONE_SERVICES table
    await createTableIfNotExists('phone_services', `
      CREATE TABLE "phone_services" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" text,
        "phone_number" character varying NOT NULL,
        "webhook_url" character varying,
        "api_key" character varying,
        "status" character varying NOT NULL DEFAULT 'active',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        "user_id" integer,
        CONSTRAINT "PK_phone_services" PRIMARY KEY ("id"),
        CONSTRAINT "FK_phone_services_user" FOREIGN KEY ("user_id") REFERENCES "user"("id")
      )
    `);

    // 7. USER_PHONE_PERMISSIONS table
    await createTableIfNotExists('user_phone_permissions', `
      CREATE TABLE "user_phone_permissions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" integer NOT NULL,
        "phoneServiceId" uuid NOT NULL,
        "canRead" boolean NOT NULL DEFAULT false,
        "canWrite" boolean NOT NULL DEFAULT false,
        "canDelete" boolean NOT NULL DEFAULT false,
        "canManage" boolean NOT NULL DEFAULT false,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_phone_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_4e54cf5151e1449ff3e6eff25c2" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_phone_permissions_phone_service" FOREIGN KEY ("phoneServiceId") REFERENCES "phone_services"("id") ON DELETE CASCADE
      )
    `);

    // 8. USER_SETTING table
    await createTableIfNotExists('user_setting', `
      CREATE TABLE "user_setting" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" integer NOT NULL,
        "setting_key" character varying NOT NULL,
        "setting_value" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_setting" PRIMARY KEY ("id"),
        CONSTRAINT "FK_4b46d4a3adec99377740b0bafa0" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
      )
    `);

    // 9. AUTH_CODES table
    await createTableIfNotExists('auth_codes', `
      CREATE TABLE "auth_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" integer NOT NULL,
        "code" character varying NOT NULL,
        "type" character varying NOT NULL,
        "expires_at" timestamp NOT NULL,
        "used" boolean NOT NULL DEFAULT false,
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_auth_codes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_b88499d54679a1b26ff47e71072" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
      )
    `);

    // 10. PROMPT table
    await createTableIfNotExists('prompt', `
      CREATE TABLE "prompt" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "content" text NOT NULL,
        "category" character varying,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        "user_id" integer,
        CONSTRAINT "PK_prompt" PRIMARY KEY ("id"),
        CONSTRAINT "FK_prompt_user" FOREIGN KEY ("user_id") REFERENCES "user"("id")
      )
    `);

    // 11. CONTACT table
    await createTableIfNotExists('contact', `
      CREATE TABLE "contact" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "phone" character varying NOT NULL,
        "email" character varying,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_contact" PRIMARY KEY ("id")
      )
    `);

    // 12. MESSAGE table
    await createTableIfNotExists('message', `
      CREATE TABLE "message" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "content" text NOT NULL,
        "from_phone" character varying NOT NULL,
        "to_phone" character varying NOT NULL,
        "message_type" character varying NOT NULL DEFAULT 'text',
        "status" character varying NOT NULL DEFAULT 'sent',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "phone_service_id" uuid,
        CONSTRAINT "PK_message" PRIMARY KEY ("id"),
        CONSTRAINT "FK_message_phone_service" FOREIGN KEY ("phone_service_id") REFERENCES "phone_services"("id")
      )
    `);

    // Insert default data
    await queryRunner.query(`
      INSERT INTO "status" ("id", "name") VALUES (1, 'Active'), (2, 'Inactive')
      ON CONFLICT (id) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "role" ("id", "name") VALUES (1, 'Admin'), (2, 'User'), (3, 'Doctor'), (4, 'Patient'), (5, 'Moderator')
      ON CONFLICT (id) DO NOTHING
    `);

    // Create indexes
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_58e4dbff0e1a32a9bdc861bb29" ON "user" ("firstName")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_9bd2fe7a8e694dedc4ec2f666f" ON "user" ("socialId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_f0e1b4ecdca13b177e2e3a0613" ON "user" ("lastName")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_is_active" ON "user" ("is_active")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_professional_id" ON "user" ("professional_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_role" ON "user" ("role")`);

    console.log('All production tables created successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse order
    const tables = [
      'message', 'contact', 'prompt', 'auth_codes', 'user_setting',
      'user_phone_permissions', 'phone_services', 'session', 'user',
      'file', 'role', 'status'
    ];

    for (const table of tables) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    await queryRunner.query(`DROP TYPE IF EXISTS "user_role_enum"`);
  }
}