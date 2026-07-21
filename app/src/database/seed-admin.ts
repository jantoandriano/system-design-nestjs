import dataSource from './data-source';
import { User } from './entities/user.entity';
import * as bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Idempotent bootstrap for the one account needed to log in before any
 * other users exist. Replaces the old AUTH_USERNAME/AUTH_PASSWORD_HASH
 * env vars now that credentials live in the users table.
 */
async function seed() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be set to seed the admin user');
  }

  await dataSource.initialize();
  const repo = dataSource.getRepository(User);

  const existing = await repo.findOne({ where: { username } });
  if (existing) {
    console.log(`User '${username}' already exists, skipping.`);
  } else {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await repo.save(repo.create({ username, passwordHash }));
    console.log(`Created user '${username}'.`);
  }

  await dataSource.destroy();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding admin user failed:', err);
  process.exit(1);
});
