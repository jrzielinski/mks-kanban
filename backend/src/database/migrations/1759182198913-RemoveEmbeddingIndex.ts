import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveEmbeddingIndex1759182198913 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Remove the problematic B-tree index on embedding column
        // This index causes "index row requires 20976 bytes, maximum size is 8191" error
        // because embedding vectors are too large (1536 dimensions for OpenAI ada-002)
        await queryRunner.query(`DROP INDEX IF EXISTS "embedding_idx"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Do not recreate the index as it causes errors
        // If needed in the future, use a specialized vector index type (e.g., pgvector HNSW/IVFFlat)
        // await queryRunner.query(`CREATE INDEX "embedding_idx" ON "document_chunks" ("embedding")`);
    }

}
