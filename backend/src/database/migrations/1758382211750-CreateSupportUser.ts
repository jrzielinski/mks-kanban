import { MigrationInterface, QueryRunner } from "typeorm";
import * as bcrypt from 'bcryptjs';

export class CreateSupportUser1758382211750 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash('password@123', salt);

        // Create support user in the user table
        await queryRunner.query(`
            INSERT INTO "user" (
                "email",
                "password",
                "provider",
                "firstName",
                "lastName",
                "statusId",
                "roleId",
                "tenantId",
                "createdAt",
                "updatedAt"
            ) VALUES (
                'admin@zielinski.dev.br',
                '${hashedPassword}',
                'email',
                'Admin',
                'Zielinski',
                (SELECT id FROM status WHERE name = 'Active' LIMIT 1),
                (SELECT id FROM role WHERE name = 'Admin' LIMIT 1),
                'staff',
                NOW(),
                NOW()
            )
            ON CONFLICT (email) DO UPDATE SET
                password = EXCLUDED.password,
                "firstName" = EXCLUDED."firstName",
                "lastName" = EXCLUDED."lastName",
                "tenantId" = 'staff',
                "updatedAt" = NOW()
        `);

        console.log('Support user created: admin@zielinski.dev.br with admin role');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Remove the support user
        await queryRunner.query(`
            DELETE FROM "user" WHERE email = 'admin@zielinski.dev.br'
        `);
    }

}
