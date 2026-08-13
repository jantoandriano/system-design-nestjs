import dataSource from './data-source';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { Role } from './entities/role.entity';
import * as bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;
const REQUESTER_PERMISSIONS = ['po.create', 'po.read'];
const APPROVER_PERMISSIONS = ['po.approve', 'po.read'];

// Upsert, not create-once: a later phase (e.g. master-data) extends this
// same seed script's permission constants for an already-existing role, and
// a re-run must actually apply that — a create-if-missing-only version would
// silently leave an already-seeded role's permissions stale forever.
async function ensureRole(
  roleRepo: ReturnType<typeof dataSource.getRepository<Role>>,
  tenantId: string,
  name: string,
  permissions: string[],
): Promise<Role> {
  let role = await roleRepo.findOne({ where: { tenantId, name } });
  if (!role) {
    role = await roleRepo.save(roleRepo.create({ tenantId, name, permissions }));
    console.log(`Created role '${name}'.`);
  } else if (JSON.stringify([...role.permissions].sort()) !== JSON.stringify([...permissions].sort())) {
    role = await roleRepo.save({ ...role, permissions });
    console.log(`Updated permissions for role '${name}'.`);
  }
  return role;
}

async function ensureUser(
  userRepo: ReturnType<typeof dataSource.getRepository<User>>,
  tenantId: string,
  username: string,
  password: string,
  roleId: string,
): Promise<void> {
  const existing = await userRepo.findOne({ where: { username } });
  if (existing) {
    if (!existing.roleId) {
      await userRepo.update({ id: existing.id }, { roleId });
      console.log(`Assigned role to existing user '${username}'.`);
    } else {
      console.log(`User '${username}' already exists, skipping.`);
    }
    return;
  }
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await userRepo.save(userRepo.create({ username, passwordHash, tenantId, roleId }));
  console.log(`Created user '${username}'.`);
}

async function seed() {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const approverUsername = process.env.APPROVER_USERNAME;
  const approverPassword = process.env.APPROVER_PASSWORD;
  const tenantName = process.env.ADMIN_TENANT_NAME ?? 'default';

  if (!adminUsername || !adminPassword) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be set to seed the requester user');
  }
  if (!approverUsername || !approverPassword) {
    throw new Error('APPROVER_USERNAME and APPROVER_PASSWORD must be set to seed the approver user');
  }

  await dataSource.initialize();
  const userRepo = dataSource.getRepository(User);
  const tenantRepo = dataSource.getRepository(Tenant);
  const roleRepo = dataSource.getRepository(Role);

  let tenant = await tenantRepo.findOne({ where: { name: tenantName } });
  if (!tenant) {
    tenant = await tenantRepo.save(tenantRepo.create({ name: tenantName }));
    console.log(`Created tenant '${tenantName}'.`);
  }

  const adminRole = await ensureRole(roleRepo, tenant.id, 'admin', REQUESTER_PERMISSIONS);
  const approverRole = await ensureRole(roleRepo, tenant.id, 'approver', APPROVER_PERMISSIONS);

  await ensureUser(userRepo, tenant.id, adminUsername, adminPassword, adminRole.id);
  await ensureUser(userRepo, tenant.id, approverUsername, approverPassword, approverRole.id);

  await dataSource.destroy();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding demo users failed:', err);
  process.exit(1);
});
