# ERP Phase 1: Multi-Tenancy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Tenant` entity, scope `User` (and, from Phase 5 on, `PurchaseOrder`) by `tenantId`, and enforce that scoping at both the request boundary (JWT claim → request-scoped context) and the ORM boundary (a subscriber that throws on a cross-tenant load).

**Architecture:** `tenantId` flows in on the JWT payload, gets bound into an `AsyncLocalStorage`-backed `TenantContext` by a global interceptor, and every tenant-scoped repository call is expected to filter by it explicitly. A TypeORM subscriber is the safety net: it doesn't filter queries (subscribers can't), it asserts on load that nothing outside the current tenant context slipped through. `Task` is deliberately **not** touched — `GET /tasks` is intentionally unauthenticated (see `CLAUDE.md`), so there's no tenant context to scope it by, and adding `tenant_id` there would just create a silent leak on an unauthenticated route.

**Tech Stack:** NestJS interceptors/guards, Node's `AsyncLocalStorage`, TypeORM `EntitySubscriberInterface`.

## Global Constraints

- `synchronize` stays off — schema changes are migrations only, generated from `app/` via `npm run migration:generate -- src/database/migrations/<Name>`.
- Every new/changed entity goes in both `ENTITIES` (`database.module.ts`) and `entities` (`data-source.ts`).
- This phase depends on **erp-plan-0-users.md** being complete — `User` entity, `UsersService`, and JWT login against real accounts must exist first.
- Backfilling existing rows to a "default" tenant happens inside the migration itself (add nullable column → backfill → set `NOT NULL`), not as a separate manual step — this repo's existing rows (if any) must not break.

---

### Task 1: `Tenant` entity + migration (with backfill)

**Files:**
- Create: `app/src/database/entities/tenant.entity.ts`
- Modify: `app/src/database/entities/user.entity.ts`
- Modify: `app/src/database/database.module.ts`
- Modify: `app/src/database/data-source.ts`
- Create: `app/src/database/migrations/<timestamp>-CreateTenantsAndScopeUsers.ts`

**Interfaces:**
- Produces: `Tenant` class — `{ id: string; name: string; createdAt: Date }`.
- Produces: `User.tenantId: string` (new column on the existing entity from Phase 0).

- [ ] **Step 1: Write the `Tenant` entity**

```typescript
// app/src/database/entities/tenant.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 2: Add `tenantId` to `User`**

In `app/src/database/entities/user.entity.ts`, add:

```typescript
@Column()
tenantId: string;
```

- [ ] **Step 3: Register `Tenant` on both connections**

Same pattern as Phase 0 Task 1 — add the import and extend `ENTITIES` in `database.module.ts` and `entities` in `data-source.ts`:

```typescript
import { Tenant } from './entities/tenant.entity';
// ...
const ENTITIES = [Task, ProcessedEvent, User, Tenant];
```

- [ ] **Step 4: Generate the migration, then hand-edit it for the backfill**

```bash
npm run migration:generate -- src/database/migrations/CreateTenantsAndScopeUsers
```

TypeORM's generator will produce a `CREATE TABLE "tenants"` plus an `ALTER TABLE "users" ADD "tenantId" uuid NOT NULL` — the `NOT NULL` on a table that may already have rows (the admin user from Phase 0's seed script) will fail. Edit the generated `up()` to backfill between column-add and constraint:

```typescript
// app/src/database/migrations/<timestamp>-CreateTenantsAndScopeUsers.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTenantsAndScopeUsers<timestamp> implements MigrationInterface {
    name = 'CreateTenantsAndScopeUsers<timestamp>'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tenants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_tenants_name" UNIQUE ("name"), CONSTRAINT "PK_tenants_id" PRIMARY KEY ("id"))`);

        // Seed a default tenant so existing users (and existing rows in
        // future tenant-scoped tables) have somewhere to backfill to.
        await queryRunner.query(`INSERT INTO "tenants" ("name") VALUES ('default')`);

        await queryRunner.query(`ALTER TABLE "users" ADD "tenantId" uuid`);
        await queryRunner.query(`UPDATE "users" SET "tenantId" = (SELECT "id" FROM "tenants" WHERE "name" = 'default')`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "tenantId" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_users_tenantId" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_users_tenantId"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tenantId"`);
        await queryRunner.query(`DROP TABLE "tenants"`);
    }
}
```

- [ ] **Step 5: Run the migration**

```bash
npm run migration:run
```
Expected: applies cleanly even with the existing admin user row from Phase 0 — verify with `SELECT username, "tenantId" FROM users;` that the admin row now has the default tenant's id.

- [ ] **Step 6: Commit**

```bash
git add app/src/database/entities/tenant.entity.ts app/src/database/entities/user.entity.ts app/src/database/database.module.ts app/src/database/data-source.ts app/src/database/migrations/
git commit -m "feat(database): add tenants table, scope users by tenant"
```

---

### Task 2: `TenantContext` (AsyncLocalStorage wrapper)

**Files:**
- Create: `app/src/tenancy/tenant-context.ts`
- Test: `app/src/tenancy/tenant-context.spec.ts`

**Interfaces:**
- Produces:
  - `TenantContext.run<T>(tenantId: string, fn: () => T): T`
  - `TenantContext.getTenantId(): string` — throws if called outside a bound context
  - `TenantContext.tryGetTenantId(): string | undefined` — returns `undefined` outside a bound context, used by the subscriber (Task 4) which must not throw for requests that never had a tenant (e.g. `GET /tasks`)

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/tenancy/tenant-context.spec.ts
import { TenantContext } from './tenant-context';

describe('TenantContext', () => {
  it('returns the bound tenantId inside run()', () => {
    TenantContext.run('tenant-1', () => {
      expect(TenantContext.getTenantId()).toBe('tenant-1');
      expect(TenantContext.tryGetTenantId()).toBe('tenant-1');
    });
  });

  it('throws from getTenantId() outside any run()', () => {
    expect(() => TenantContext.getTenantId()).toThrow();
  });

  it('returns undefined from tryGetTenantId() outside any run()', () => {
    expect(TenantContext.tryGetTenantId()).toBeUndefined();
  });

  it('isolates concurrent contexts', async () => {
    const results: string[] = [];
    await Promise.all([
      TenantContext.run('tenant-a', async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(TenantContext.getTenantId());
      }),
      TenantContext.run('tenant-b', async () => {
        results.push(TenantContext.getTenantId());
      }),
    ]);
    expect(results.sort()).toEqual(['tenant-a', 'tenant-b']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest tenancy/tenant-context.spec.ts
```
Expected: FAIL — `Cannot find module './tenant-context'`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/tenancy/tenant-context.ts
import { AsyncLocalStorage } from 'async_hooks';

interface TenantStore {
  tenantId: string;
}

const als = new AsyncLocalStorage<TenantStore>();

export class TenantContext {
  static run<T>(tenantId: string, fn: () => T): T {
    return als.run({ tenantId }, fn);
  }

  static getTenantId(): string {
    const store = als.getStore();
    if (!store) {
      throw new Error('TenantContext.getTenantId() called outside of a bound request context');
    }
    return store.tenantId;
  }

  static tryGetTenantId(): string | undefined {
    return als.getStore()?.tenantId;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tenancy/tenant-context.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/tenancy/tenant-context.ts app/src/tenancy/tenant-context.spec.ts
git commit -m "feat(tenancy): add AsyncLocalStorage-backed TenantContext"
```

---

### Task 3: JWT payload carries `tenantId`

**Files:**
- Modify: `app/src/auth/jwt-payload.interface.ts`
- Modify: `app/src/auth/jwt.strategy.ts`
- Modify: `app/src/auth/auth.service.ts`
- Modify: `app/src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `User.tenantId` from Task 1.
- Produces: `JwtPayload = { sub: string; username: string; tenantId: string }`; `JwtStrategy.validate()` returns `{ userId: string; username: string; tenantId: string }`, which becomes `req.user` — this is what Task 5's interceptor reads.

- [ ] **Step 1: Update the payload interface**

```typescript
// app/src/auth/jwt-payload.interface.ts
export interface JwtPayload {
  sub: string;
  username: string;
  tenantId: string;
}
```

- [ ] **Step 2: Update `JwtStrategy.validate`**

```typescript
// app/src/auth/jwt.strategy.ts (validate method only)
validate(payload: JwtPayload) {
  return { userId: payload.sub, username: payload.username, tenantId: payload.tenantId };
}
```

- [ ] **Step 3: Update the failing test in `auth.service.spec.ts`**

Update the existing `'issues an access token for valid credentials'` test from Phase 0 Task 4 to include `tenantId` on the mocked user and assert it's in the signed payload:

```typescript
it('issues an access token for valid credentials', async () => {
  usersService.findByUsername.mockResolvedValue({
    id: 'user-1',
    username: 'alice',
    passwordHash: 'hash',
    tenantId: 'tenant-1',
  });
  usersService.validatePassword.mockResolvedValue(true);

  const result = await service.login('alice', 'correct-horse');

  expect(result).toEqual({ accessToken: 'signed.jwt.token' });
  expect(jwtService.signAsync).toHaveBeenCalledWith({
    sub: 'user-1',
    username: 'alice',
    tenantId: 'tenant-1',
  });
});
```

- [ ] **Step 4: Run tests to verify this one now fails**

```bash
npx jest auth/auth.service.spec.ts
```
Expected: FAIL on the updated test — `signAsync` was called without `tenantId`.

- [ ] **Step 5: Update `AuthService.login`**

```typescript
// app/src/auth/auth.service.ts (login method only)
async login(username: string, password: string) {
  const user = await this.usersService.findByUsername(username);
  const passwordMatches =
    user != null && (await this.usersService.validatePassword(user, password));

  if (!passwordMatches) {
    throw new UnauthorizedException('Invalid credentials');
  }

  const payload = { sub: user.id, username: user.username, tenantId: user.tenantId };
  return {
    accessToken: await this.jwtService.signAsync(payload),
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx jest auth/auth.service.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add app/src/auth/jwt-payload.interface.ts app/src/auth/jwt.strategy.ts app/src/auth/auth.service.ts app/src/auth/auth.service.spec.ts
git commit -m "feat(auth): carry tenantId through the JWT payload"
```

---

### Task 4: `TenantScopedSubscriber` (defense-in-depth on read)

**Files:**
- Create: `app/src/tenancy/tenant-scoped.subscriber.ts`
- Test: `app/src/tenancy/tenant-scoped.subscriber.spec.ts`

**Interfaces:**
- Consumes: `TenantContext.tryGetTenantId()` from Task 2.
- Produces: `TenantScopedSubscriber` — a TypeORM `EntitySubscriberInterface` registered on both the `default` and `replica` connections; throws `ForbiddenException` from `afterLoad` if a loaded entity has a `tenantId` field that doesn't match the currently-bound `TenantContext` (and does nothing if no context is bound, so unauthenticated routes like `GET /tasks` are unaffected).

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/tenancy/tenant-scoped.subscriber.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { TenantScopedSubscriber } from './tenant-scoped.subscriber';
import { TenantContext } from './tenant-context';

describe('TenantScopedSubscriber', () => {
  const dataSourceStub = { subscribers: [] as unknown[] };
  let subscriber: TenantScopedSubscriber;

  beforeEach(() => {
    dataSourceStub.subscribers = [];
    subscriber = new TenantScopedSubscriber(dataSourceStub as any, dataSourceStub as any);
  });

  it('registers itself on both datasources passed in', () => {
    expect(dataSourceStub.subscribers).toContain(subscriber);
  });

  it('allows a load matching the current tenant context', () => {
    TenantContext.run('tenant-1', () => {
      expect(() => subscriber.afterLoad({ tenantId: 'tenant-1' })).not.toThrow();
    });
  });

  it('throws on a load that does not match the current tenant context', () => {
    TenantContext.run('tenant-1', () => {
      expect(() => subscriber.afterLoad({ tenantId: 'tenant-2' })).toThrow(ForbiddenException);
    });
  });

  it('does nothing when no tenant context is bound', () => {
    expect(() => subscriber.afterLoad({ tenantId: 'tenant-2' })).not.toThrow();
  });

  it('does nothing for entities without a tenantId field', () => {
    TenantContext.run('tenant-1', () => {
      expect(() => subscriber.afterLoad({ id: 'task-1', title: 'unrelated' })).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest tenancy/tenant-scoped.subscriber.spec.ts
```
Expected: FAIL — `Cannot find module './tenant-scoped.subscriber'`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/tenancy/tenant-scoped.subscriber.ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, EventSubscriber } from 'typeorm';
import { TenantContext } from './tenant-context';

@Injectable()
@EventSubscriber()
export class TenantScopedSubscriber implements EntitySubscriberInterface {
  constructor(
    @InjectDataSource('default') defaultDataSource: DataSource,
    @InjectDataSource('replica') replicaDataSource: DataSource,
  ) {
    defaultDataSource.subscribers.push(this);
    replicaDataSource.subscribers.push(this);
  }

  afterLoad(entity: unknown): void {
    if (
      entity != null &&
      typeof entity === 'object' &&
      'tenantId' in entity &&
      typeof (entity as { tenantId: unknown }).tenantId === 'string'
    ) {
      const currentTenantId = TenantContext.tryGetTenantId();
      if (currentTenantId && (entity as { tenantId: string }).tenantId !== currentTenantId) {
        throw new ForbiddenException('Cross-tenant access blocked');
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tenancy/tenant-scoped.subscriber.spec.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/tenancy/tenant-scoped.subscriber.ts app/src/tenancy/tenant-scoped.subscriber.spec.ts
git commit -m "feat(tenancy): add defense-in-depth subscriber blocking cross-tenant loads"
```

---

### Task 5: `TenantContextInterceptor` + `TenancyModule`

**Files:**
- Create: `app/src/tenancy/tenant-context.interceptor.ts`
- Create: `app/src/tenancy/tenancy.module.ts`
- Test: `app/src/tenancy/tenant-context.interceptor.spec.ts`
- Modify: `app/src/app.module.ts`

**Interfaces:**
- Consumes: `TenantContext.run` from Task 2, `TenantScopedSubscriber` from Task 4, `req.user.tenantId` shape from Task 3.
- Produces: `TenantContextInterceptor` — registered globally via `APP_INTERCEPTOR`; `TenancyModule`, importable by any future module needing tenant scoping.

- [ ] **Step 1: Write the failing test**

```typescript
// app/src/tenancy/tenant-context.interceptor.spec.ts
import { of } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantContext } from './tenant-context';

function makeContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TenantContextInterceptor', () => {
  const interceptor = new TenantContextInterceptor();

  it('binds TenantContext from req.user.tenantId when present', (done) => {
    const handler: CallHandler = {
      handle: () => {
        expect(TenantContext.getTenantId()).toBe('tenant-1');
        return of('result');
      },
    };
    interceptor
      .intercept(makeContext({ userId: 'u1', tenantId: 'tenant-1' }), handler)
      .subscribe(() => done());
  });

  it('passes through without binding when req.user is absent', (done) => {
    const handler: CallHandler = {
      handle: () => {
        expect(TenantContext.tryGetTenantId()).toBeUndefined();
        return of('result');
      },
    };
    interceptor.intercept(makeContext(undefined), handler).subscribe(() => done());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest tenancy/tenant-context.interceptor.spec.ts
```
Expected: FAIL — `Cannot find module './tenant-context.interceptor'`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/tenancy/tenant-context.interceptor.ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContext } from './tenant-context';

interface RequestUser {
  userId: string;
  username: string;
  tenantId: string;
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as RequestUser | undefined;

    if (!user?.tenantId) {
      return next.handle();
    }

    let result$!: Observable<unknown>;
    TenantContext.run(user.tenantId, () => {
      result$ = next.handle();
    });
    return result$;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tenancy/tenant-context.interceptor.spec.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Write `TenancyModule` and register the interceptor + subscriber globally**

```typescript
// app/src/tenancy/tenancy.module.ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantScopedSubscriber } from './tenant-scoped.subscriber';

@Module({
  providers: [
    TenantScopedSubscriber,
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class TenancyModule {}
```

In `app/src/app.module.ts`, import it:

```typescript
import { TenancyModule } from './tenancy/tenancy.module';
// ...
imports: [
  // ...existing imports...
  TenancyModule,
  UsersModule,
  TasksModule,
  HealthModule,
  AuthModule,
  MetricsModule,
],
```

- [ ] **Step 6: Verify the app still boots and existing tests still pass**

```bash
npm run build
npm test
```
Expected: both exit 0 — this confirms the global interceptor doesn't break the unauthenticated `GET /tasks` path or `POST /auth/login`.

- [ ] **Step 7: Commit**

```bash
git add app/src/tenancy/tenant-context.interceptor.ts app/src/tenancy/tenant-context.interceptor.spec.ts app/src/tenancy/tenancy.module.ts app/src/app.module.ts
git commit -m "feat(tenancy): bind TenantContext globally from the JWT claim"
```

---

### Task 6: Update seed script to create tenant-scoped admin

**Files:**
- Modify: `app/src/database/seed-admin.ts`

**Interfaces:**
- Consumes: `Tenant` entity from Task 1.
- Produces: seed script now also ensures a tenant exists and assigns the admin user's `tenantId`.

- [ ] **Step 1: Update the script**

```typescript
// app/src/database/seed-admin.ts
import dataSource from './data-source';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import * as bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

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
```

- [ ] **Step 2: Run it against a local/dev database**

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=change-me npm run seed:admin
```
Expected: since the migration in Task 1 already created a `default` tenant and backfilled the existing admin row, this either finds the existing admin (skips) or, on a fresh database, creates both the `default` tenant and the admin user.

- [ ] **Step 3: Manually verify the JWT now carries `tenantId`**

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me"}'
```
Decode the returned `accessToken` (e.g. paste into jwt.io) and confirm the payload includes `tenantId`.

- [ ] **Step 4: Commit**

```bash
git add app/src/database/seed-admin.ts
git commit -m "feat(database): seed script creates/assigns a tenant for the admin user"
```

---

## Definition of Done

- `tenants` table exists; `users` rows are all tenant-scoped, backfilled by migration (no manual data-fixing step required).
- JWT payload and `req.user` carry `tenantId`.
- `TenantContext` is bound globally from the JWT claim on every authenticated request, no-ops on unauthenticated ones.
- `TenantScopedSubscriber` throws on any cross-tenant entity load while a context is bound, registered on both `default` and `replica` connections.
- `Task` and its unauthenticated `GET /tasks` route are unchanged.
- `npm run build` and `npm test` both pass in `app/`.
