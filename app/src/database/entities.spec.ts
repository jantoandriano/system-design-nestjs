import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ENTITIES } from './database.module';

/**
 * DB-less smoke test: builds TypeORM entity metadata (column types, FKs,
 * etc.) for every entity registered in DatabaseModule, without ever opening
 * a socket to Postgres.
 *
 * `DataSource.initialize()` connects the driver *before* building metadata,
 * so it can't be used here without a live database. `buildMetadatas()` is
 * the internal step `initialize()` calls afterward - it only inspects
 * `this.driver` (constructed, but not connected) to validate column types
 * against what the target database supports, then runs
 * `EntityMetadataValidator`. That's exactly the check that would have
 * caught `User.roleId` being typed `string | null` (design:type `Object`,
 * unsupported by the Postgres driver) before it ever reached a real
 * `DataSource.initialize()` call in the app, a migration command, or the
 * seed script.
 *
 * `buildMetadatas` is declared `protected` in TypeORM's public .d.ts (it's
 * an internal implementation detail meant to be called from `initialize()`),
 * so it's accessed here via a narrow cast rather than `as any`.
 */
describe('TypeORM entity metadata', () => {
  it('builds valid metadata for every registered entity (no live DB needed)', async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'test',
      password: 'test',
      database: 'test',
      entities: ENTITIES,
      synchronize: false,
    });

    const buildMetadatas = (
      dataSource as unknown as { buildMetadatas: () => Promise<void> }
    ).buildMetadatas.bind(dataSource);

    await expect(buildMetadatas()).resolves.not.toThrow();
    expect(dataSource.isInitialized).toBe(false);
    expect(dataSource.entityMetadatas.length).toBe(ENTITIES.length);
  });
});
