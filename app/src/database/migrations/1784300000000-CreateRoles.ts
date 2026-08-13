import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableForeignKey,
  TableUnique,
} from 'typeorm';

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

    await queryRunner.createForeignKey(
      'roles',
      new TableForeignKey({
        name: 'FK_roles_tenantId',
        columnNames: ['tenantId'],
        referencedTableName: 'tenants',
        referencedColumnNames: ['id'],
      }),
    );

    // Prevent two roles with the same name in the same tenant.
    await queryRunner.createUniqueConstraint(
      'roles',
      new TableUnique({
        name: 'UQ_roles_tenantId_name',
        columnNames: ['tenantId', 'name'],
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

    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        name: 'FK_users_roleId',
        columnNames: ['roleId'],
        referencedTableName: 'roles',
        referencedColumnNames: ['id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropForeignKey('users', 'FK_users_roleId');
    await queryRunner.dropColumn('users', 'roleId');
    await queryRunner.dropUniqueConstraint('roles', 'UQ_roles_tenantId_name');
    await queryRunner.dropForeignKey('roles', 'FK_roles_tenantId');
    await queryRunner.dropTable('roles');
  }
}
