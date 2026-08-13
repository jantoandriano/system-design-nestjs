import dataSource from './data-source';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import * as bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Idempotent bootstrap for the one account needed to log in before any
 * other users exist. Replaces the old AUTH_USERNAME/AUTH_PASSWORD_HASH
 * env vars now that credentials live in the users table.
 *
 * Since Phase 1 (multi-tenancy), also bootstraps the tenant that account
 * belongs to: finds-or-creates a Tenant by ADMIN_TENANT_NAME (defaults to
 * 'default') before creating the user, since User.tenantId is required.
 */
async function seed() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const tenantName = process.env.ADMIN_TENANT_NAME ?? 'default';

  if (!username || !password) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be set to seed the admin user');
  }

  await dataSource.initialize();
  const userRepo = dataSource.getRepository(User);
  const tenantRepo = dataSource.getRepository(Tenant);

  let tenant = await tenantRepo.findOne({ where: { name: tenantName } });
  if (!tenant) {
    tenant = await tenantRepo.save(tenantRepo.create({ name: tenantName }));
    console.log(`Created tenant '${tenantName}'.`);
  }

  const existing = await userRepo.findOne({ where: { username } });
  if (existing) {
    console.log(`User '${username}' already exists, skipping.`);
  } else {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await userRepo.save(userRepo.create({ username, passwordHash, tenantId: tenant.id }));
    console.log(`Created user '${username}' in tenant '${tenantName}'.`);
  }

  await dataSource.destroy();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding admin user failed:', err);
  process.exit(1);
});
