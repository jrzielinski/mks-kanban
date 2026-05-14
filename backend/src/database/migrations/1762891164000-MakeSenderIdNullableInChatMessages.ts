import { MigrationInterface, QueryRunner } from "typeorm";

export class MakeSenderIdNullableInChatMessages1762891164000 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Make sender_id nullable to allow system messages
        await queryRunner.query(`
            ALTER TABLE "consultation_chat_messages"
            ALTER COLUMN "sender_id" DROP NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Revert: make sender_id NOT NULL again
        // Note: This will fail if there are system messages with null sender_id
        await queryRunner.query(`
            ALTER TABLE "consultation_chat_messages"
            ALTER COLUMN "sender_id" SET NOT NULL
        `);
    }

}
