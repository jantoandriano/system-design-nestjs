import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';

export class CreateRoles1784300000000 implements MigrationInterface {
  name = 'CreateRoles1784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'roles',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'tenantId',
            type: 'uuid',
          },
          {
            name: 'name',
            type: 'character varying',
          },
          {
            name: 'permissions',
            type: 'text',
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'now()',
          },
        ],
      }),
    );

    // Nullable, no backfill needed - a brand-new user has no role until
    // one is assigned. Unlike Phase 1's tenantId, there's no existing
    // data that needs a default value here.
    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'roleId',
        type: 'uuid',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('users', 'roleId');
    await queryRunner.dropTable('roles');
  }
}
