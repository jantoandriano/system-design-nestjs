# ERP Phase 4: Idempotency Keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable `@Idempotent()` interceptor for financial writes: same `Idempotency-Key` + same request body replays the cached response; same key + different body is rejected; a brand-new key proceeds and gets cached on success.

**Architecture:** One Postgres table, `idempotency_keys`, unique on `(tenantId, key)`. The interceptor hashes the request body (SHA-256), checks/creates a row before calling the handler, and updates it after. Concurrency is handled by letting the unique constraint do the work: a duplicate insert throws, which the interceptor turns into `409`.

A row can be left in `status: 'pending'` forever if the process crashes between inserting it and either completing or erroring the request (the happy-path completion and the error-path delete both require the process to still be alive to run them). Without a bound on how long `pending` is trusted, that key is dead for every future retry, indefinitely. `IdempotencyInterceptor` bounds this with a `PENDING_TIMEOUT_MS` (30s): a `pending` row older than that is treated as abandoned — the interceptor deletes it and proceeds as though the key were new, rather than 409ing forever. 30s is deliberately generous relative to any real request in this stack; it only ever matters after an actual crash, not under normal latency.

**Tech Stack:** NestJS interceptors, TypeORM, Node's built-in `crypto` (no new dependency for hashing).

## Global Constraints

- `synchronize` stays off — migrations only, from `app/`.
- Depends on **erp-plan-1-tenancy.md** (`TenantContext.getTenantId()`) — every idempotency row is tenant-scoped, so a key collision across tenants is impossible by construction.
- This module is generic: it doesn't know what "purchase order" or any other business concept is. It's proven with a throwaway test controller in this plan, then actually applied to `POST /purchase-orders` in **erp-plan-6-purchase-orders.md**.

---

### Task 1: `IdempotencyKey` entity + migration

**Files:**
- Create: `app/src/database/entities/idempotency-key.entity.ts`
- Modify: `app/src/database/database.module.ts`
- Modify: `app/src/database/data-source.ts`
- Create: `app/src/database/migrations/<timestamp>-CreateIdempotencyKeys.ts`

**Interfaces:**
- Produces: `IdempotencyKey` class — `{ id: string; tenantId: string; key: string; requestHash: string; status: 'pending' | 'completed'; statusCode: number | null; responseBody: unknown; createdAt: Date }`.

- [ ] **Step 1: Write the entity**

```typescript
// app/src/database/entities/idempotency-key.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('idempotency_keys')
@Index(['tenantId', 'key'], { unique: true })
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  key: string;

  @Column()
  requestHash: string;

  @Column({ default: 'pending' })
  status: 'pending' | 'completed';

  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  @Column({ type: 'jsonb', nullable: true })
  responseBody: unknown;

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 2: Register the entity on both connections**

```typescript
import { IdempotencyKey } from './entities/idempotency-key.entity';
// ...
const ENTITIES = [Task, ProcessedEvent, User, Tenant, Role, IdempotencyKey];
```
(same in `data-source.ts`)

- [ ] **Step 3: Generate and run the migration**

```bash
npm run migration:generate -- src/database/migrations/CreateIdempotencyKeys
```
Expected: `CREATE TABLE "idempotency_keys" (...)` plus a unique index on `("tenantId", "key")`. Review, then:

```bash
npm run migration:run
```

- [ ] **Step 4: Commit**

```bash
git add app/src/database/entities/idempotency-key.entity.ts app/src/database/database.module.ts app/src/database/data-source.ts app/src/database/migrations/
git commit -m "feat(database): add idempotency_keys table"
```

---

### Task 2: `@Idempotent()` decorator + `IdempotencyInterceptor`

**Files:**
- Create: `app/src/idempotency/idempotent.decorator.ts`
- Create: `app/src/idempotency/idempotency.interceptor.ts`
- Test: `app/src/idempotency/idempotency.interceptor.spec.ts`

**Interfaces:**
- Consumes: `TenantContext.getTenantId()` from **erp-plan-1-tenancy.md**.
- Produces: `Idempotent()` decorator (marks a route); `IdempotencyInterceptor` — behavior:
  - Route not decorated → pass through untouched.
  - Decorated, missing `Idempotency-Key` header → `400`.
  - New `(tenantId, key)` → insert `pending` row, call handler, on success update to `completed` with the response cached, on handler error delete the row (so a retry with the same key can proceed cleanly).
  - Existing row, same `requestHash`, `status = completed` → return the cached `responseBody`/`statusCode`, handler never runs.
  - Existing row, same `requestHash`, `status = pending`, younger than `PENDING_TIMEOUT_MS` (30s) → `409` (another request with this exact key is still in flight).
  - Existing row, `status = pending`, **older than `PENDING_TIMEOUT_MS`** → treated as abandoned (the process that owned it crashed before completing or erroring it): delete the row, proceed as if the key were new.
  - Existing row, different `requestHash` → `409`.
  - Concurrent insert race (two requests, same new key, both miss the lookup) → the loser's unique-constraint violation on insert is caught and turned into `409`.

- [ ] **Step 1: Write the decorator**

```typescript
// app/src/idempotency/idempotent.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
```

- [ ] **Step 2: Write the failing tests**

```typescript
// app/src/idempotency/idempotency.interceptor.spec.ts
import { of } from 'rxjs';
import { CallHandler, ConflictException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { TenantContext } from '../tenancy/tenant-context';

function makeContext(headers: Record<string, string>, body: unknown) {
  const req: any = { headers, body };
  const res: any = { statusCode: 201 };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => {},
    getClass: () => {},
  } as unknown as ExecutionContext;
}

describe('IdempotencyInterceptor', () => {
  const repo = { findOne: jest.fn(), save: jest.fn(), delete: jest.fn(), create: jest.fn((d) => d) };

  beforeEach(() => jest.clearAllMocks());

  function makeInterceptor(decorated = true) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(decorated) };
    return new IdempotencyInterceptor(reflector as unknown as Reflector, repo as any);
  }

  it('passes through untouched when the route is not decorated', (done) => {
    const interceptor = makeInterceptor(false);
    const handler: CallHandler = { handle: () => of('untouched') };
    interceptor.intercept(makeContext({}, {}), handler).subscribe((result) => {
      expect(result).toBe('untouched');
      expect(repo.findOne).not.toHaveBeenCalled();
      done();
    });
  });

  it('rejects a decorated route missing the Idempotency-Key header', (done) => {
    const interceptor = makeInterceptor(true);
    const handler: CallHandler = { handle: () => of('unused') };
    TenantContext.run('tenant-1', () => {
      interceptor.intercept(makeContext({}, { a: 1 }), handler).subscribe({
        error: (err) => {
          expect(err.status).toBe(400);
          done();
        },
      });
    });
  });

  it('runs the handler and caches the response on a new key', (done) => {
    repo.findOne.mockResolvedValue(null);
    const interceptor = makeInterceptor(true);
    const handler: CallHandler = { handle: () => of({ id: 'po-1' }) };
    TenantContext.run('tenant-1', () => {
      interceptor
        .intercept(makeContext({ 'idempotency-key': 'key-1' }, { a: 1 }), handler)
        .subscribe((result) => {
          expect(result).toEqual({ id: 'po-1' });
          expect(repo.save).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'completed', responseBody: { id: 'po-1' } }),
          );
          done();
        });
    });
  });

  it('replays the cached response for a matching key + hash', (done) => {
    repo.findOne.mockResolvedValue({
      status: 'completed',
      requestHash: require('crypto').createHash('sha256').update(JSON.stringify({ a: 1 })).digest('hex'),
      responseBody: { id: 'po-1' },
      statusCode: 201,
    });
    const interceptor = makeInterceptor(true);
    const handler: CallHandler = { handle: jest.fn() };
    TenantContext.run('tenant-1', () => {
      interceptor
        .intercept(makeContext({ 'idempotency-key': 'key-1' }, { a: 1 }), handler)
        .subscribe((result) => {
          expect(result).toEqual({ id: 'po-1' });
          expect(handler.handle).not.toHaveBeenCalled();
          done();
        });
    });
  });

  it('rejects a matching key with a different request body', (done) => {
    repo.findOne.mockResolvedValue({
      status: 'completed',
      requestHash: 'some-other-hash',
      responseBody: { id: 'po-1' },
      statusCode: 201,
    });
    const interceptor = makeInterceptor(true);
    const handler: CallHandler = { handle: jest.fn() };
    TenantContext.run('tenant-1', () => {
      interceptor.intercept(makeContext({ 'idempotency-key': 'key-1' }, { a: 2 }), handler).subscribe({
        error: (err) => {
          expect(err).toBeInstanceOf(ConflictException);
          done();
        },
      });
    });
  });

  it('rejects a key that is still pending and recent (concurrent in-flight request)', (done) => {
    repo.findOne.mockResolvedValue({
      status: 'pending',
      requestHash: require('crypto').createHash('sha256').update(JSON.stringify({ a: 1 })).digest('hex'),
      createdAt: new Date(), // just created — well inside PENDING_TIMEOUT_MS
    });
    const interceptor = makeInterceptor(true);
    const handler: CallHandler = { handle: jest.fn() };
    TenantContext.run('tenant-1', () => {
      interceptor.intercept(makeContext({ 'idempotency-key': 'key-1' }, { a: 1 }), handler).subscribe({
        error: (err) => {
          expect(err).toBeInstanceOf(ConflictException);
          done();
        },
      });
    });
  });

  it('reclaims a pending key older than PENDING_TIMEOUT_MS as abandoned and runs the handler', (done) => {
    repo.findOne.mockResolvedValue({
      status: 'pending',
      requestHash: require('crypto').createHash('sha256').update(JSON.stringify({ a: 1 })).digest('hex'),
      createdAt: new Date(Date.now() - 60_000), // 60s old — a crashed request, not a slow one
    });
    const interceptor = makeInterceptor(true);
    const handler: CallHandler = { handle: () => of({ id: 'po-1' }) };
    TenantContext.run('tenant-1', () => {
      interceptor
        .intercept(makeContext({ 'idempotency-key': 'key-1' }, { a: 1 }), handler)
        .subscribe((result) => {
          expect(repo.delete).toHaveBeenCalledWith({ tenantId: 'tenant-1', key: 'key-1' });
          expect(result).toEqual({ id: 'po-1' });
          done();
        });
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx jest idempotency/idempotency.interceptor.spec.ts
```
Expected: FAIL — `Cannot find module './idempotency.interceptor'`.

- [ ] **Step 4: Write the implementation**

```typescript
// app/src/idempotency/idempotency.interceptor.ts
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Observable, from, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { Repository } from 'typeorm';
import { IDEMPOTENT_KEY } from './idempotent.decorator';
import { IdempotencyKey } from '../database/entities/idempotency-key.entity';
import { TenantContext } from '../tenancy/tenant-context';

const PENDING_TIMEOUT_MS = 30_000;

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(IdempotencyKey, 'default')
    private readonly repo: Repository<IdempotencyKey>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isIdempotent) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const key = request.headers['idempotency-key'];
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const tenantId = TenantContext.getTenantId();
    const requestHash = hashBody(request.body);

    return from(this.repo.findOne({ where: { tenantId, key } })).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('Idempotency-Key reused with a different request body');
          }
          if (existing.status === 'completed') {
            return of(existing.responseBody);
          }
          // status === 'pending': still in flight, or abandoned by a crash.
          const ageMs = Date.now() - existing.createdAt.getTime();
          if (ageMs < PENDING_TIMEOUT_MS) {
            throw new ConflictException('A request with this Idempotency-Key is already in flight');
          }
          // Older than the timeout — no live request is going to complete or
          // error this row, so reclaim it and proceed as a fresh key.
          return from(this.repo.delete({ tenantId, key })).pipe(
            switchMap(() => this.runAndCache(tenantId, key, requestHash, next)),
          );
        }

        return this.runAndCache(tenantId, key, requestHash, next);
      }),
    );
  }

  private runAndCache(
    tenantId: string,
    key: string,
    requestHash: string,
    next: CallHandler,
  ): Observable<unknown> {
    return from(
      this.repo.save(this.repo.create({ tenantId, key, requestHash, status: 'pending' })),
    ).pipe(
      catchError(() => {
        throw new ConflictException('A request with this Idempotency-Key is already in flight');
      }),
      switchMap(() =>
        next.handle().pipe(
          tap({
            next: async (response) => {
              await this.repo.save(
                this.repo.create({ tenantId, key, requestHash, status: 'completed', responseBody: response }),
              );
            },
            error: async () => {
              await this.repo.delete({ tenantId, key });
            },
          }),
        ),
      ),
    );
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest idempotency/idempotency.interceptor.spec.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add app/src/idempotency/idempotent.decorator.ts app/src/idempotency/idempotency.interceptor.ts app/src/idempotency/idempotency.interceptor.spec.ts
git commit -m "feat(idempotency): add Idempotent decorator and IdempotencyInterceptor"
```

---

### Task 3: `IdempotencyModule`

**Files:**
- Create: `app/src/idempotency/idempotency.module.ts`
- Modify: `app/src/app.module.ts`

**Interfaces:**
- Produces: `IdempotencyModule`, exporting `IdempotencyInterceptor` for any controller (Phase 6's `PurchaseOrdersController`, and this phase's own proof controller) to apply via `@UseInterceptors()`.

- [ ] **Step 1: Write the module**

```typescript
// app/src/idempotency/idempotency.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKey } from '../database/entities/idempotency-key.entity';
import { IdempotencyInterceptor } from './idempotency.interceptor';

@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyKey], 'default')],
  providers: [IdempotencyInterceptor],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule {}
```

- [ ] **Step 2: Register it in `AppModule`**

```typescript
import { IdempotencyModule } from './idempotency/idempotency.module';
// ...
imports: [
  // ...existing imports...
  IdempotencyModule,
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
git add app/src/idempotency/idempotency.module.ts app/src/app.module.ts
git commit -m "feat(idempotency): wire IdempotencyModule into AppModule"
```

---

### Task 4: Prove it end-to-end with a throwaway test controller

**Files:**
- Create: `app/src/idempotency/idempotency-demo.controller.ts` (temporary — deleted in this same task's last step once the integration test passes; exists only to prove the interceptor works over real HTTP before Phase 6 wires it to something real)
- Test: `app/test/idempotency.e2e-spec.ts` (uses the demo controller while it exists — this test is also deleted at the end of this task, since it verifies the interceptor generically and Phase 6 adds an equivalent test against `PurchaseOrdersController`)

**Interfaces:**
- Consumes: `IdempotencyInterceptor` + `Idempotent()` from Task 2/3.

- [ ] **Step 1: Write the demo controller**

```typescript
// app/src/idempotency/idempotency-demo.controller.ts
import { Body, Controller, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Idempotent } from './idempotent.decorator';
import { IdempotencyInterceptor } from './idempotency.interceptor';

@Controller('idempotency-demo')
export class IdempotencyDemoController {
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  @Post()
  echo(@Body() body: unknown) {
    return { received: body, at: new Date().toISOString() };
  }
}
```

Add it to `IdempotencyModule`'s `controllers: [IdempotencyDemoController]` temporarily.

- [ ] **Step 2: Write the e2e test**

```typescript
// app/test/idempotency.e2e-spec.ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Idempotency (e2e)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('replays the same response for a repeated key + body', async () => {
    const first = await request(app.getHttpServer())
      .post('/idempotency-demo')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'demo-key-1')
      .send({ a: 1 });

    const second = await request(app.getHttpServer())
      .post('/idempotency-demo')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'demo-key-1')
      .send({ a: 1 });

    expect(first.body.at).toEqual(second.body.at); // same cached timestamp, handler didn't re-run
  });

  it('rejects the same key with a different body', async () => {
    await request(app.getHttpServer())
      .post('/idempotency-demo')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'demo-key-2')
      .send({ a: 1 });

    const conflict = await request(app.getHttpServer())
      .post('/idempotency-demo')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'demo-key-2')
      .send({ a: 2 });

    expect(conflict.status).toBe(409);
  });
});
```

- [ ] **Step 3: Run it against a running dev database**

This is an e2e test hitting a real Postgres connection (`AppModule`'s real `DatabaseModule`), not a unit test — run it with the dev stack up and the admin seeded:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=change-me npx jest --config ./test/jest-e2e.json idempotency.e2e-spec.ts
```

If no `test/jest-e2e.json` exists yet in this repo, add one following Nest's standard e2e config (`rootDir: '.'`, `testRegex: '.e2e-spec.ts$'`, same `transform`/`moduleFileExtensions` as `package.json`'s `jest` block). Expected: both tests PASS against the real database — this is the proof that the interceptor's SQL (unique constraint, save/delete) behaves correctly outside of mocks.

- [ ] **Step 4: Delete the demo controller and its e2e test**

```bash
git rm app/src/idempotency/idempotency-demo.controller.ts app/test/idempotency.e2e-spec.ts
```
Remove `IdempotencyDemoController` from `IdempotencyModule`'s `controllers` array. This was scaffolding to prove the interceptor works over real HTTP before Phase 6 attaches it to `PurchaseOrdersController` for real — Phase 6 writes its own e2e test against the real endpoint, so this one would just be dead weight afterward.

- [ ] **Step 5: Confirm the app still builds after removal, then commit**

```bash
npm run build
git add app/src/idempotency/idempotency.module.ts
git commit -m "test(idempotency): prove IdempotencyInterceptor against real Postgres, then remove demo scaffolding"
```

---

## Definition of Done

- `idempotency_keys` table exists, unique on `(tenantId, key)`.
- `IdempotencyInterceptor` unit-tested for: pass-through when undecorated, missing-header rejection, new-key success + caching, replay on match, conflict on hash mismatch, conflict on a recent pending key, reclaim + successful run on a pending key older than `PENDING_TIMEOUT_MS`.
- Proven once against a real Postgres connection via a throwaway controller/e2e test, then that scaffolding removed — the module is ready to attach to a real endpoint in Phase 6 with no unit-test-only blind spots.
- `npm run build` and `npm test` both pass in `app/`.
