import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';
import {
  CID10_CHAPTERS,
  CID10_GROUPS,
  CID10_CATEGORIES,
  CID10_SUBCATEGORIES,
} from './cid10-data';

export class CreateCid10Table1762783607441 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    console.log('[CID-10] Creating tables...');

    // Tabela de Capítulos
    await queryRunner.createTable(
      new Table({
        name: 'cid10_chapters',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'chapter_number',
            type: 'int',
            isUnique: true,
          },
          {
            name: 'code_start',
            type: 'varchar',
            length: '10',
          },
          {
            name: 'code_end',
            type: 'varchar',
            length: '10',
          },
          {
            name: 'description',
            type: 'text',
          },
          {
            name: 'short_description',
            type: 'varchar',
            length: '255',
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    );

    // Tabela de Grupos
    await queryRunner.createTable(
      new Table({
        name: 'cid10_groups',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'code_start',
            type: 'varchar',
            length: '10',
          },
          {
            name: 'code_end',
            type: 'varchar',
            length: '10',
          },
          {
            name: 'description',
            type: 'text',
          },
          {
            name: 'short_description',
            type: 'varchar',
            length: '255',
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    );

    // Tabela de Categorias
    await queryRunner.createTable(
      new Table({
        name: 'cid10_categories',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'code',
            type: 'varchar',
            length: '10',
            isUnique: true,
          },
          {
            name: 'classification',
            type: 'varchar',
            length: '50',
            isNullable: true,
          },
          {
            name: 'description',
            type: 'text',
          },
          {
            name: 'short_description',
            type: 'varchar',
            length: '255',
          },
          {
            name: 'reference',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'excluded',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    );

    // Tabela de Subcategorias
    await queryRunner.createTable(
      new Table({
        name: 'cid10_subcategories',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'code',
            type: 'varchar',
            length: '10',
            isUnique: true,
          },
          {
            name: 'classification',
            type: 'varchar',
            length: '50',
            isNullable: true,
          },
          {
            name: 'sex_restriction',
            type: 'varchar',
            length: '1',
            isNullable: true,
          },
          {
            name: 'death_cause',
            type: 'varchar',
            length: '1',
            isNullable: true,
          },
          {
            name: 'description',
            type: 'text',
          },
          {
            name: 'short_description',
            type: 'varchar',
            length: '255',
          },
          {
            name: 'reference',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'excluded',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'now()',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
      true,
    );

    console.log('[CID-10] Creating indexes...');

    // Criar índices para busca rápida
    await queryRunner.createIndex(
      'cid10_chapters',
      new TableIndex({
        name: 'IDX_cid10_chapters_code_start',
        columnNames: ['code_start'],
      }),
    );

    await queryRunner.createIndex(
      'cid10_groups',
      new TableIndex({
        name: 'IDX_cid10_groups_code_start',
        columnNames: ['code_start'],
      }),
    );

    await queryRunner.createIndex(
      'cid10_categories',
      new TableIndex({
        name: 'IDX_cid10_categories_code',
        columnNames: ['code'],
      }),
    );

    await queryRunner.createIndex(
      'cid10_categories',
      new TableIndex({
        name: 'IDX_cid10_categories_description',
        columnNames: ['description'],
      }),
    );

    await queryRunner.createIndex(
      'cid10_subcategories',
      new TableIndex({
        name: 'IDX_cid10_subcategories_code',
        columnNames: ['code'],
      }),
    );

    await queryRunner.createIndex(
      'cid10_subcategories',
      new TableIndex({
        name: 'IDX_cid10_subcategories_description',
        columnNames: ['description'],
      }),
    );

    console.log('[CID-10] Tables and indexes created!');
    console.log('[CID-10] Importing data...');

    // Importar Capítulos
    console.log(`[CID-10] Importing ${CID10_CHAPTERS.length} chapters...`);
    for (const chapter of CID10_CHAPTERS) {
      await queryRunner.query(
        `INSERT INTO cid10_chapters (chapter_number, code_start, code_end, description, short_description)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          chapter.chapterNumber,
          chapter.codeStart,
          chapter.codeEnd,
          chapter.description,
          chapter.shortDescription,
        ],
      );
    }

    // Importar Grupos
    console.log(`[CID-10] Importing ${CID10_GROUPS.length} groups...`);
    for (const group of CID10_GROUPS) {
      await queryRunner.query(
        `INSERT INTO cid10_groups (code_start, code_end, description, short_description)
         VALUES ($1, $2, $3, $4)`,
        [group.codeStart, group.codeEnd, group.description, group.shortDescription],
      );
    }

    // Importar Categorias
    console.log(`[CID-10] Importing ${CID10_CATEGORIES.length} categories...`);
    let count = 0;
    for (const category of CID10_CATEGORIES) {
      await queryRunner.query(
        `INSERT INTO cid10_categories (code, classification, description, short_description, reference, excluded)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          category.code,
          category.classification,
          category.description,
          category.shortDescription,
          category.reference,
          category.excluded,
        ],
      );
      count++;
      if (count % 500 === 0) {
        console.log(`[CID-10] Imported ${count}/${CID10_CATEGORIES.length} categories...`);
      }
    }

    // Importar Subcategorias
    console.log(`[CID-10] Importing ${CID10_SUBCATEGORIES.length} subcategories...`);
    count = 0;
    for (const subcategory of CID10_SUBCATEGORIES) {
      await queryRunner.query(
        `INSERT INTO cid10_subcategories (code, classification, sex_restriction, death_cause, description, short_description, reference, excluded)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          subcategory.code,
          subcategory.classification,
          subcategory.sexRestriction,
          subcategory.deathCause,
          subcategory.description,
          subcategory.shortDescription,
          subcategory.reference,
          subcategory.excluded,
        ],
      );
      count++;
      if (count % 1000 === 0) {
        console.log(
          `[CID-10] Imported ${count}/${CID10_SUBCATEGORIES.length} subcategories...`,
        );
      }
    }

    console.log('[CID-10] Migration completed successfully!');
    console.log(`[CID-10] Total records: ${CID10_CHAPTERS.length + CID10_GROUPS.length + CID10_CATEGORIES.length + CID10_SUBCATEGORIES.length}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('[CID-10] Rolling back...');

    // Remover índices
    await queryRunner.dropIndex('cid10_subcategories', 'IDX_cid10_subcategories_description');
    await queryRunner.dropIndex('cid10_subcategories', 'IDX_cid10_subcategories_code');
    await queryRunner.dropIndex('cid10_categories', 'IDX_cid10_categories_description');
    await queryRunner.dropIndex('cid10_categories', 'IDX_cid10_categories_code');
    await queryRunner.dropIndex('cid10_groups', 'IDX_cid10_groups_code_start');
    await queryRunner.dropIndex('cid10_chapters', 'IDX_cid10_chapters_code_start');

    // Remover tabelas
    await queryRunner.dropTable('cid10_subcategories');
    await queryRunner.dropTable('cid10_categories');
    await queryRunner.dropTable('cid10_groups');
    await queryRunner.dropTable('cid10_chapters');

    console.log('[CID-10] Rollback completed');
  }
}
