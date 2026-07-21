# ERP Phase 2: RBAC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tenant-scoped roles with a flat permission list, a guard that checks a required permission against the caller's role, and a decorator to declare that requirement per-route.

**Architecture:** One `Role` entity per tenant with a `permissions: string[]` column (no separate `Permission`/`RolePermission` join tables — there's no admin UI to manage a permissions catalog dynamically, so a flat string list on the role is sufficient and avoids three tables' worth of ceremony for zero behavioral gain). A user has at most one role, via a nullable `roleId` column directly on `User` (no separate `UserRole` join table, same reasoning). `RbacGuard` reads the required permission off route metadata (`@RequirePermission('po.create')`) and checks it against the caller's role.

**Tech Stack:** NestJS guards, `Reflector`-based metadata, TypeORM.

## Global Constraints

- `synchronize` stays off — migrations only, from `app/`.
- Depends on **erp-plan-0-users.md** and **erp-plan-1-tenancy.md** being complete (`User.tenantId`, `TenantContext`).
- Permission strings used in this plan's seed data (`po.create`, `po.approve`, `po.read`) are forward references to the Purchase Orders module (**erp-plan-6-purchase-orders.md**) — RBAC itself has no knowledge of what a permission string means, it just compares strings. This is intentional: RBAC shouldn't need to change when a new business module adds new permission strings.

---

### Task 1: `Role` entity + `roleId` on `User` + migration

**Files:**
- Create: `app/src/database/entities/role.entity.ts`
- Modify: `app/src/database/entities/user.entity.ts`
- Modify: `app/src/database/database.module.ts`
- Modify: `app/src/database/data-source.ts`
- Create: `app/src/database/migrations/<timestamp>-CreateRoles.ts`

**Interfaces:**
- Produces: `Role` class — `{ id: string; tenantId: string; name: string; permissions: string[]; createdAt: Date }`.
- Produces: `User.roleId: string | null` (nullable — a brand-new user has no role until assigned one).

- [ ] **Step 1: Write the `Role` entity**

```typescript
// app/src/database/entities/role.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  name: string;

  @Column('simple-array')
  permissions: string[];

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 2: Add `roleId` to `User`**

In `app/src/database/entities/user.entity.ts`, add:

```typescript
@Column({ nullable: true })
roleId: string | null;
```

- [ ] **Step 3: Register `Role` on both connections**

```typescript
import { Role } from './entities/role.entity';
// ...
const ENTITIES = [Task, ProcessedEvent, User, Tenant, Role];
```
(same addition in `data-source.ts`'s `entities` array)

- [ ] **Step 4: Generate and run the migration**

```bash
npm run migration:generate -- src/database/migrations/CreateRoles
```
Expected: `CREATE TABLE "roles" (...)` plus `ALTER TABLE "users" ADD "roleId" uuid` (nullable, so no backfill needed this time — existing users simply start with no role). Review the generated file, then:

```bash
npm run migration:run
```

- [ ] **Step 5: Commit**

```bash
git add app/src/database/entities/role.entity.ts app/src/database/entities/user.entity.ts app/src/database/database.module.ts app/src/database/data-source.ts app/src/database/migrations/
git commit -m "feat(database): add roles table and roleId on users"
```

---

### Task 2: `RolesService`

**Files:**
- Create: `app/src/rbac/roles.service.ts`
- Test: `app/src/rbac/roles.service.spec.ts`

**Interfaces:**
- Consumes: `Role` entity from Task 1.
- Produces: `RolesService` with:
  - `create(tenantId: string, name: string, permissions: string[]): Promise<Role>`
  - `findById(id: string): Promise<Role | null>`
  - `hasPermission(role: Role, permission: string): boolean`

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/rbac/roles.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RolesService } from './roles.service';
import { Role } from '../database/entities/role.entity';

describe('RolesService', () => {
  let service: RolesService;
  const repo = {
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'role-1', createdAt: new Date(), ...data })),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [RolesService, { provide: getRepositoryToken(Role, 'default'), useValue: repo }],
    }).compile();
    service = module.get(RolesService);
  });

  it('creates a role scoped to a tenant with a permission list', async () => {
    const role = await service.create('tenant-1', 'manager', ['po.approve', 'po.read']);
    expect(role.tenantId).toBe('tenant-1');
    expect(role.permissions).toEqual(['po.approve', 'po.read']);
  });

  it('finds a role by id', async () => {
    repo.findOne.mockResolvedValue({ id: 'role-1', tenantId: 'tenant-1', permissions: ['po.read'] });
    const role = await service.findById('role-1');
    expect(role?.id).toBe('role-1');
  });

  it('returns null for an unknown role id', async () => {
    repo.findOne.mockResolvedValue(null);
    expect(await service.findById('missing')).toBeNull();
  });

  it('hasPermission is true when the permission is in the list', () => {
    const role = { id: 'r1', tenantId: 't1', name: 'clerk', permissions: ['po.create'], createdAt: new Date() } as Role;
    expect(service.hasPermission(role, 'po.create')).toBe(true);
  });

  it('hasPermission is false when the permission is not in the list', () => {
    const role = { id: 'r1', tenantId: 't1', name: 'clerk', permissions: ['po.create'], createdAt: new Date() } as Role;
    expect(service.hasPermission(role, 'po.approve')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest rbac/roles.service.spec.ts
```
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/rbac/roles.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../database/entities/role.entity';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role, 'default')
    private readonly repo: Repository<Role>,
  ) {}

  async create(tenantId: string, name: string, permissions: string[]): Promise<Role> {
    const role = this.repo.create({ tenantId, name, permissions });
    return this.repo.save(role);
  }

  async findById(id: string): Promise<Role | null> {
    return this.repo.findOne({ where: { id } });
  }

  hasPermission(role: Role, permission: string): boolean {
    return role.permissions.includes(permission);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest rbac/roles.service.spec.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/rbac/roles.service.ts app/src/rbac/roles.service.spec.ts
git commit -m "feat(rbac): add RolesService"
```

---

### Task 3: `@RequirePermission()` decorator + `RbacGuard`

**Files:**
- Create: `app/src/rbac/require-permission.decorator.ts`
- Create: `app/src/rbac/rbac.guard.ts`
- Test: `app/src/rbac/rbac.guard.spec.ts`

**Interfaces:**
- Consumes: `RolesService` from Task 2, `req.user` shape `{ userId, username, tenantId }` from **erp-plan-1-tenancy.md**.
- Produces: `RequirePermission(permission: string)` decorator; `RbacGuard` — a `CanActivate` that 403s if the caller has no role, the role's `tenantId` doesn't match `req.user.tenantId`, or the role lacks the required permission. Needs `req.user.userId` to look up the user's `roleId`, so it needs a `UsersService`-shaped lookup too — reuses `UsersService.findByUsername`-adjacent capability by adding a `findById` method to `UsersService` in this task (small addition to an existing service from Phase 0, not a new module).

- [ ] **Step 1: Add `UsersService.findById`**

In `app/src/users/users.service.ts`, add:

```typescript
async findById(id: string): Promise<User | null> {
  return this.repo.findOne({ where: { id } });
}
```

Add the corresponding unit test to `app/src/users/users.service.spec.ts`:

```typescript
it('finds a user by id', async () => {
  repo.findOne.mockResolvedValue({ id: 'user-1', username: 'alice' });
  const user = await service.findById('user-1');
  expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'user-1' } });
  expect(user?.id).toBe('user-1');
});
```

Run `npx jest users/users.service.spec.ts` — expect PASS, 6 tests now.

- [ ] **Step 2: Write the decorator**

```typescript
// app/src/rbac/require-permission.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'permission';
export const RequirePermission = (permission: string) =>
  SetMetadata(PERMISSION_KEY, permission);
```

- [ ] **Step 3: Write the failing guard tests**

```typescript
// app/src/rbac/rbac.guard.spec.ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacGuard } from './rbac.guard';
import { RolesService } from './roles.service';
import { UsersService } from '../users/users.service';

function makeContext(user: unknown, permission: string | undefined) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(permission) };
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => {},
    getClass: () => {},
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe('RbacGuard', () => {
  const usersService = { findById: jest.fn() };
  const rolesService = { findById: jest.fn(), hasPermission: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('allows access when no permission is required on the route', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    const context = { switchToHttp: () => ({ getRequest: () => ({ user: undefined }) }), getHandler: () => {}, getClass: () => {} } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies access when the user has no role', async () => {
    usersService.findById.mockResolvedValue({ id: 'u1', tenantId: 't1', roleId: null });
    const { context, reflector } = makeContext({ userId: 'u1', tenantId: 't1' }, 'po.create');
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('denies access when the role belongs to a different tenant', async () => {
    usersService.findById.mockResolvedValue({ id: 'u1', tenantId: 't1', roleId: 'r1' });
    rolesService.findById.mockResolvedValue({ id: 'r1', tenantId: 't2', permissions: ['po.create'] });
    const { context, reflector } = makeContext({ userId: 'u1', tenantId: 't1' }, 'po.create');
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('denies access when the role lacks the required permission', async () => {
    usersService.findById.mockResolvedValue({ id: 'u1', tenantId: 't1', roleId: 'r1' });
    rolesService.findById.mockResolvedValue({ id: 'r1', tenantId: 't1', permissions: ['po.read'] });
    rolesService.hasPermission.mockReturnValue(false);
    const { context, reflector } = makeContext({ userId: 'u1', tenantId: 't1' }, 'po.create');
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('allows access when the role has the required permission', async () => {
    usersService.findById.mockResolvedValue({ id: 'u1', tenantId: 't1', roleId: 'r1' });
    rolesService.findById.mockResolvedValue({ id: 'r1', tenantId: 't1', permissions: ['po.create'] });
    rolesService.hasPermission.mockReturnValue(true);
    const { context, reflector } = makeContext({ userId: 'u1', tenantId: 't1' }, 'po.create');
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
npx jest rbac/rbac.guard.spec.ts
```
Expected: FAIL — `Cannot find module './rbac.guard'`.

- [ ] **Step 5: Write the implementation**

```typescript
// app/src/rbac/rbac.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from './require-permission.decorator';
import { RolesService } from './roles.service';
import { UsersService } from '../users/users.service';

interface RequestUser {
  userId: string;
  username: string;
  tenantId: string;
}

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
    private readonly rolesService: RolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const requestUser = request.user as RequestUser;

    const user = await this.usersService.findById(requestUser.userId);
    if (!user?.roleId) {
      throw new ForbiddenException('No role assigned');
    }

    const role = await this.rolesService.findById(user.roleId);
    if (!role || role.tenantId !== requestUser.tenantId) {
      throw new ForbiddenException('Role not valid for this tenant');
    }

    if (!this.rolesService.hasPermission(role, requiredPermission)) {
      throw new ForbiddenException(`Missing permission: ${requiredPermission}`);
    }

    return true;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx jest rbac/rbac.guard.spec.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add app/src/rbac/require-permission.decorator.ts app/src/rbac/rbac.guard.ts app/src/rbac/rbac.guard.spec.ts app/src/users/users.service.ts app/src/users/users.service.spec.ts
git commit -m "feat(rbac): add RequirePermission decorator and RbacGuard"
```

---

### Task 4: `RbacModule`

**Files:**
- Create: `app/src/rbac/rbac.module.ts`
- Modify: `app/src/app.module.ts`

**Interfaces:**
- Consumes: `RolesService` (Task 2), `RbacGuard` (Task 3), `UsersModule` (Phase 0).
- Produces: `RbacModule`, exporting `RolesService` and `RbacGuard` for future modules (Phase 5's `WorkflowModule`, Phase 6's `PurchaseOrdersModule`) to consume.

- [ ] **Step 1: Write the module**

```typescript
// app/src/rbac/rbac.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from '../database/entities/role.entity';
import { RolesService } from './roles.service';
import { RbacGuard } from './rbac.guard';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([Role], 'default'), UsersModule],
  providers: [RolesService, RbacGuard],
  exports: [RolesService, RbacGuard],
})
export class RbacModule {}
```

- [ ] **Step 2: Register it in `AppModule`**

```typescript
import { RbacModule } from './rbac/rbac.module';
// ...
imports: [
  // ...existing imports...
  RbacModule,
  TasksModule,
  HealthModule,
  AuthModule,
  MetricsModule,
],
```

- [ ] **Step 3: Verify the app still boots**

```bash
npm run build
npm test
```
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/src/rbac/rbac.module.ts app/src/app.module.ts
git commit -m "feat(rbac): wire RbacModule into AppModule"
```

---

### Task 5: Seed demo roles — requester + approver, two accounts

**Files:**
- Modify: `app/src/database/seed-admin.ts`

**Interfaces:**
- Consumes: `Role` entity from Task 1.
- Produces: seed script now creates two roles (`admin` — `po.create`, `po.read`; `approver` — `po.approve`, `po.read`) and two accounts (`ADMIN_USERNAME`/`ADMIN_PASSWORD`, `APPROVER_USERNAME`/`APPROVER_PASSWORD`).

**Note — why two accounts, not one:** Phase 5 blocks self-approval (`approverId === instance.requestedBy` → `403`). A single account holding both `po.create` and `po.approve` could never approve its own PO under that rule, so the old "one account, fully testable via curl" shortcut no longer works — and shouldn't, since letting one account both request and approve is exactly the control gap self-approval-blocking exists to close. Two accounts is the realistic minimum for a working demo, not extra ceremony.

- [ ] **Step 1: Update the script**

```typescript
// app/src/database/seed-admin.ts
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
```

- [ ] **Step 2: Run it**

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=change-me \
APPROVER_USERNAME=approver APPROVER_PASSWORD=change-me-too \
npm run seed:admin
```
Expected: on a fresh database, creates tenant + both roles + both users. On a database from Phase 0/1's seed already run, creates the `approver` role/account alongside the existing admin (idempotent either way).

- [ ] **Step 3: Commit**

```bash
git add app/src/database/seed-admin.ts
git commit -m "feat(database): seed separate requester and approver demo accounts"
```

---

## Definition of Done

- `roles` table exists, tenant-scoped; `users.roleId` links a user to at most one role.
- `RolesService` and `RbacGuard` covered by unit tests, including the tenant-mismatch case.
- `@RequirePermission()` is available for any future controller route to declare its required permission.
- Seed script creates two working demo accounts — `admin` (requester: `po.create`, `po.read`) and `approver` (`po.approve`, `po.read`) — so Phase 6's walkthrough can exercise a real create → approve flow without one account approving its own request.
- `npm run build` and `npm test` both pass in `app/`.
