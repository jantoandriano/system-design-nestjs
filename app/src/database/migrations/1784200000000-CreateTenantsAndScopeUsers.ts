import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableForeignKey,
} from 'typeorm';

export class CreateTenantsAndScopeUsers1784200000000
  implements MigrationInterface
{
  name = 'CreateTenantsAndScopeUsers1784200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'tenants',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'name',
            type: 'character varying',
            isUnique: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
    );

    // Seed a default tenant so existing users (and existing rows in
    // future tenant-scoped tables) have somewhere to backfill to.
    await queryRunner.query(`INSERT INTO "tenants" ("name") VALUES ('default')`);

    // Add tenantId nullable first - the admin user row from Phase 0's
    // seed script already exists, so a NOT NULL column can't be added
    // in one step. Backfill it to the default tenant, then tighten.
    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'tenantId',
        type: 'uuid',
        isNullable: true,
      }),
    );

    await queryRunner.query(
      `UPDATE "users" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "name" = 'default')`,
    );

    await queryRunner.changeColumn(
      'users',
      'tenantId',
      new TableColumn({
        name: 'tenantId',
        type: 'uuid',
        isNullable: false,
      }),
    );

    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        name: 'FK_users_tenantId',
        columnNames: ['tenantId'],
        referencedTableName: 'tenants',
        referencedColumnNames: ['id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropForeignKey('users', 'FK_users_tenantId');
    await queryRunner.dropColumn('users', 'tenantId');
    await queryRunner.dropTable('tenants');
  }
}
