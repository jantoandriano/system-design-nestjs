import dataSource from './data-source';

/**
 * Runs pending migrations against the primary database and exits.
 * Used as the entrypoint for the one-off `migrate` service in
 * docker-compose.yml - it runs to completion before app1/app2 start,
 * so nobody ever boots against a schema mid-migration.
 */
async function run() {
  await dataSource.initialize();
  const applied = await dataSource.runMigrations();

  if (applied.length === 0) {
    console.log('No pending migrations.');
  } else {
    console.log(`Applied ${applied.length} migration(s):`);
    applied.forEach((m) => console.log(`  - ${m.name}`));
  }

  await dataSource.destroy();
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration run failed:', err);
  process.exit(1);
});
