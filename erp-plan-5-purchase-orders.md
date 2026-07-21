# ERP Phase 5: Purchase Orders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The real ERP business module that proves the four platform capabilities work together: create a purchase order (idempotent, RBAC-gated, tenant-scoped) → it sits `pending` as a `WorkflowInstance` → an approver (RBAC-gated) approves or rejects it → on approval, the actual `PurchaseOrder` row gets written.

**Architecture:** `PurchaseOrdersModule` owns the `PurchaseOrder` entity and registers a `purchase-order.create` handler with `WorkflowService` (Phase 4) at startup. `PurchaseOrdersController.create` never writes a `PurchaseOrder` row directly — it calls `WorkflowService.create`, which returns a pending instance; the actual insert happens inside the handler, invoked by `WorkflowService.approve` (Phase 4) when `po.approve` clears. Follows `TasksService`'s write-repo/read-repo split (`app/src/tasks/tasks.service.ts`).

**Tech Stack:** NestJS, TypeORM, class-validator (DTO validation, already a dependency).

## Global Constraints

- `synchronize` stays off — migrations only, from `app/`.
- Depends on all four prior plans: **erp-plan-0-users.md**, **erp-plan-1-tenancy.md**, **erp-plan-2-rbac.md**, **erp-plan-3-idempotency.md**, **erp-plan-4-workflow.md**.
- Permission strings used here (`po.create`, `po.approve`, `po.read`) must match exactly what Phase 2's seed script assigned to the `admin` role — no new seed changes needed in this phase, they were already forward-declared there.

---

### Task 1: `PurchaseOrder` entity + migration

**Files:**
- Create: `app/src/database/entities/purchase-order.entity.ts`
- Modify: `app/src/database/database.module.ts`
- Modify: `app/src/database/data-source.ts`
- Create: `app/src/database/migrations/<timestamp>-CreatePurchaseOrders.ts`

**Interfaces:**
- Produces: `PurchaseOrder` — `{ id: string; tenantId: string; vendorName: string; amount: string; currency: string; status: 'approved'; requestedBy: string; approvedBy: string; createdAt: Date; approvedAt: Date }`. (`amount` is `string` because TypeORM returns `decimal` columns as strings to avoid float precision loss — callers must not do arithmetic on it without an explicit parse, same caution as any money column.)

- [ ] **Step 1: Write the entity**

```typescript
// app/src/database/entities/purchase-order.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('purchase_orders')
export class PurchaseOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  vendorName: string;

  @Column('decimal', { precision: 12, scale: 2 })
  amount: string;

  @Column({ length: 3 })
  currency: string;

  @Column({ default: 'approved' })
  status: 'approved';

  @Column()
  requestedBy: string;

  @Column()
  approvedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp' })
  approvedAt: Date;
}
```

- [ ] **Step 2: Register the entity on both connections**

```typescript
import { PurchaseOrder } from './entities/purchase-order.entity';
// ...
const ENTITIES = [Task, ProcessedEvent, User, Tenant, Role, IdempotencyKey, WorkflowInstance, ApprovalStep, PurchaseOrder];
```
(same in `data-source.ts`)

- [ ] **Step 3: Generate and run the migration**

```bash
npm run migration:generate -- src/database/migrations/CreatePurchaseOrders
```
Review the generated `CREATE TABLE "purchase_orders" (...)`, then:

```bash
npm run migration:run
```

- [ ] **Step 4: Commit**

```bash
git add app/src/database/entities/purchase-order.entity.ts app/src/database/database.module.ts app/src/database/data-source.ts app/src/database/migrations/
git commit -m "feat(database): add purchase_orders table"
```

---

### Task 2: `CreatePurchaseOrderDto`

**Files:**
- Create: `app/src/purchase-orders/dto/create-purchase-order.dto.ts`

**Interfaces:**
- Produces: `CreatePurchaseOrderDto` — `{ vendorName: string; amount: string; currency: string }`, validated. `amount` is a **string**, not `number` — money must never round-trip through a JS float. `"19.10"` parsed as a `number` can already carry IEEE-754 rounding error before it ever reaches the `decimal(12,2)` column; validating the string shape directly and passing it straight through (DTO → workflow payload → `PurchaseOrder.amount`, itself a `decimal` column TypeORM also returns as a string) means no arithmetic and no float ever touches the value on this path.

- [ ] **Step 1: Write the DTO**

```typescript
// app/src/purchase-orders/dto/create-purchase-order.dto.ts
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class CreatePurchaseOrderDto {
  @IsString()
  @IsNotEmpty()
  vendorName: string;

  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string with up to 2 decimal places, e.g. "4200.00"',
  })
  amount: string;

  @IsString()
  @Length(3, 3)
  currency: string;
}
```

- [ ] **Step 2: Confirm global validation is active**

Check `app/src/main.ts` for a `ValidationPipe`. If `app.useGlobalPipes(new ValidationPipe())` (or similar) is already registered, this DTO is enforced automatically on any controller using it — no further action. If it's missing, add it in `main.ts`:

```typescript
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
```

(`CreateTaskDto` on the existing `POST /tasks` route already relies on this — if it wasn't there, that route's validation would already be broken, so this is almost certainly a no-op check, not a real change.)

- [ ] **Step 3: Commit**

```bash
git add app/src/purchase-orders/dto/create-purchase-order.dto.ts
git commit -m "feat(purchase-orders): add CreatePurchaseOrderDto"
```

---

### Task 3: `PurchaseOrdersService`

**Files:**
- Create: `app/src/purchase-orders/purchase-orders.service.ts`
- Test: `app/src/purchase-orders/purchase-orders.service.spec.ts`

**Interfaces:**
- Consumes: `WorkflowService.registerHandler`/`create` (Phase 4 — the handler signature already carries `{ requestedBy, approvedBy }` context and the transaction `EntityManager`, fixed there from the start), `PurchaseOrder` entity from Task 1.
- Produces: `PurchaseOrdersService` with:
  - `onModuleInit()` — registers the `purchase-order.create` handler with `WorkflowService`. The handler writes the `PurchaseOrder` row through the `EntityManager` `WorkflowService.approve` passes it, **not** a directly-injected repository — this is what makes the row insert and the workflow instance's `approved` transition commit as one atomic transaction (see Phase 4's Architecture note). Consequently this service has no `default`-connection repository at all, only `replica` for reads.
  - `requestCreate(dto: CreatePurchaseOrderDto, tenantId: string, requestedBy: string): Promise<WorkflowInstance>`
  - `findAll(tenantId: string): Promise<PurchaseOrder[]>`

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/purchase-orders/purchase-orders.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrder } from '../database/entities/purchase-order.entity';
import { WorkflowService } from '../workflow/workflow.service';

describe('PurchaseOrdersService', () => {
  let service: PurchaseOrdersService;
  const readRepo = { find: jest.fn() };
  const workflowService = { registerHandler: jest.fn(), create: jest.fn() };
  // Stands in for the transactional EntityManager the registered handler
  // receives from WorkflowService.approve() — see Phase 4.
  const manager = {
    create: jest.fn((_entity: unknown, d: unknown) => d),
    save: jest.fn(async (_entity: unknown, d: any) => ({ id: 'po-1', ...d })),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: getRepositoryToken(PurchaseOrder, 'replica'), useValue: readRepo },
        { provide: WorkflowService, useValue: workflowService },
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);
  });

  it('registers a purchase-order.create handler on module init', () => {
    service.onModuleInit();
    expect(workflowService.registerHandler).toHaveBeenCalledWith(
      'purchase-order.create',
      'po.approve',
      expect.any(Function),
    );
  });

  it('requestCreate delegates to WorkflowService.create', async () => {
    workflowService.create.mockResolvedValue({ id: 'wf-1', status: 'pending' });
    const dto = { vendorName: 'Acme', amount: '100.00', currency: 'USD' };
    const result = await service.requestCreate(dto, 'tenant-1', 'user-1');
    expect(workflowService.create).toHaveBeenCalledWith('purchase-order.create', dto, 'tenant-1', 'user-1');
    expect(result.status).toBe('pending');
  });

  it('findAll reads from the replica repo, scoped by tenant', async () => {
    readRepo.find.mockResolvedValue([{ id: 'po-1', tenantId: 'tenant-1' }]);
    const result = await service.findAll('tenant-1');
    expect(readRepo.find).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
    expect(result).toHaveLength(1);
  });

  it('the registered handler writes a PurchaseOrder row via the transaction manager it is given', async () => {
    service.onModuleInit();
    const [, , handler] = workflowService.registerHandler.mock.calls[0];
    await handler(
      { vendorName: 'Acme', amount: '100.00', currency: 'USD' },
      'tenant-1',
      { requestedBy: 'user-1', approvedBy: 'approver-1' },
      manager,
    );
    expect(manager.save).toHaveBeenCalledWith(
      PurchaseOrder,
      expect.objectContaining({
        vendorName: 'Acme', amount: '100.00', currency: 'USD', tenantId: 'tenant-1',
        status: 'approved', requestedBy: 'user-1', approvedBy: 'approver-1',
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest purchase-orders/purchase-orders.service.spec.ts
```
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/purchase-orders/purchase-orders.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PurchaseOrder } from '../database/entities/purchase-order.entity';
import { WorkflowService } from '../workflow/workflow.service';
import { WorkflowInstance } from '../database/entities/workflow-instance.entity';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';

@Injectable()
export class PurchaseOrdersService implements OnModuleInit {
  constructor(
    @InjectRepository(PurchaseOrder, 'replica')
    private readonly readRepo: Repository<PurchaseOrder>,
    private readonly workflowService: WorkflowService,
  ) {}

  onModuleInit(): void {
    this.workflowService.registerHandler(
      'purchase-order.create',
      'po.approve',
      async (payload, tenantId, { requestedBy, approvedBy }, manager) => {
        const dto = payload as CreatePurchaseOrderDto;
        const purchaseOrder = manager.create(PurchaseOrder, {
          tenantId,
          vendorName: dto.vendorName,
          amount: dto.amount,
          currency: dto.currency,
          status: 'approved',
          requestedBy,
          approvedBy,
          approvedAt: new Date(),
        });
        await manager.save(PurchaseOrder, purchaseOrder);
      },
    );
  }

  async requestCreate(
    dto: CreatePurchaseOrderDto,
    tenantId: string,
    requestedBy: string,
  ): Promise<WorkflowInstance> {
    return this.workflowService.create('purchase-order.create', dto, tenantId, requestedBy);
  }

  async findAll(tenantId: string): Promise<PurchaseOrder[]> {
    return this.readRepo.find({ where: { tenantId } });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest purchase-orders/purchase-orders.service.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/purchase-orders/purchase-orders.service.ts app/src/purchase-orders/purchase-orders.service.spec.ts
git commit -m "feat(purchase-orders): add PurchaseOrdersService, writing via WorkflowService's transaction manager"
```

---

### Task 4: `PurchaseOrdersController`

**Files:**
- Create: `app/src/purchase-orders/purchase-orders.controller.ts`
- Test: `app/src/purchase-orders/purchase-orders.controller.spec.ts`

**Interfaces:**
- Consumes: `PurchaseOrdersService` (Task 3), `JwtAuthGuard` (existing), `RbacGuard`/`RequirePermission` (Phase 2), `IdempotencyInterceptor`/`Idempotent` (Phase 3), `TenantContext.getTenantId()` (Phase 1).
- Produces: `POST /purchase-orders` (permission `po.create`, idempotent), `GET /purchase-orders` (permission `po.read`).

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/purchase-orders/purchase-orders.controller.spec.ts
import { Test } from '@nestjs/testing';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { TenantContext } from '../tenancy/tenant-context';

describe('PurchaseOrdersController', () => {
  let controller: PurchaseOrdersController;
  const service = { requestCreate: jest.fn(), findAll: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [PurchaseOrdersController],
      providers: [{ provide: PurchaseOrdersService, useValue: service }],
    }).compile();
    controller = module.get(PurchaseOrdersController);
  });

  it('create delegates to requestCreate with tenant and requester from context/req.user', async () => {
    service.requestCreate.mockResolvedValue({ id: 'wf-1', status: 'pending' });
    const dto = { vendorName: 'Acme', amount: 100, currency: 'USD' };
    const result = await TenantContext.run('tenant-1', () =>
      controller.create(dto, { user: { userId: 'user-1' } } as any),
    );
    expect(service.requestCreate).toHaveBeenCalledWith(dto, 'tenant-1', 'user-1');
    expect(result.status).toBe('pending');
  });

  it('findAll delegates to service.findAll with the current tenant', async () => {
    service.findAll.mockResolvedValue([{ id: 'po-1' }]);
    const result = await TenantContext.run('tenant-1', () => controller.findAll());
    expect(service.findAll).toHaveBeenCalledWith('tenant-1');
    expect(result).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest purchase-orders/purchase-orders.controller.spec.ts
```
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/purchase-orders/purchase-orders.controller.ts
import { Body, Controller, Get, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { Idempotent } from '../idempotency/idempotent.decorator';
import { PurchaseOrdersService } from './purchase-orders.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { TenantContext } from '../tenancy/tenant-context';

interface RequestUser {
  userId: string;
  username: string;
  tenantId: string;
}

@Controller('purchase-orders')
@UseGuards(JwtAuthGuard, RbacGuard)
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrdersService: PurchaseOrdersService) {}

  @Post()
  @RequirePermission('po.create')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent()
  create(@Body() dto: CreatePurchaseOrderDto, @Req() req: { user: RequestUser }) {
    return this.purchaseOrdersService.requestCreate(dto, TenantContext.getTenantId(), req.user.userId);
  }

  @Get()
  @RequirePermission('po.read')
  findAll() {
    return this.purchaseOrdersService.findAll(TenantContext.getTenantId());
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest purchase-orders/purchase-orders.controller.spec.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/purchase-orders/purchase-orders.controller.ts app/src/purchase-orders/purchase-orders.controller.spec.ts
git commit -m "feat(purchase-orders): add PurchaseOrdersController"
```

---

### Task 5: `PurchaseOrdersModule`

**Files:**
- Create: `app/src/purchase-orders/purchase-orders.module.ts`
- Modify: `app/src/app.module.ts`

**Interfaces:**
- Consumes: `WorkflowModule` (Phase 4), `RbacModule` (Phase 2), `IdempotencyModule` (Phase 3).

- [ ] **Step 1: Write the module**

```typescript
// app/src/purchase-orders/purchase-orders.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseOrder } from '../database/entities/purchase-order.entity';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { RbacModule } from '../rbac/rbac.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';

@Module({
  imports: [
    // 'default' isn't registered here: PurchaseOrdersService only reads (via
    // 'replica'); the actual insert happens through the transaction manager
    // WorkflowService.approve() passes to the registered handler, which
    // already has PurchaseOrder registered on the 'default' connection via
    // database.module.ts's ENTITIES array — a second forFeature here would
    // be redundant, not required.
    TypeOrmModule.forFeature([PurchaseOrder], 'replica'),
    WorkflowModule,
    RbacModule,
    IdempotencyModule,
  ],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
```

- [ ] **Step 2: Register it in `AppModule`**

```typescript
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
// ...
imports: [
  // ...existing imports...
  PurchaseOrdersModule,
  TasksModule,
  HealthModule,
  AuthModule,
  MetricsModule,
],
```

- [ ] **Step 3: Verify the app boots and the full unit suite passes**

```bash
npm run build
npm test
```
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/src/purchase-orders/purchase-orders.module.ts app/src/app.module.ts
git commit -m "feat(purchase-orders): wire PurchaseOrdersModule into AppModule"
```

---

### Task 6: End-to-end proof against a real database

**Files:**
- Create: `app/test/purchase-orders.e2e-spec.ts`
- Create: `app/test/jest-e2e.json` (if it doesn't already exist from Phase 3 — check first; Phase 3's demo e2e test/config was deleted, but the config file itself may have been left in place. If present, reuse it as-is.)

**Interfaces:**
- Consumes: the full, real stack — `AppModule` booted against a real Postgres connection.

- [ ] **Step 1: Write the e2e test**

```typescript
// app/test/purchase-orders.e2e-spec.ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Purchase Orders (e2e)', () => {
  let app: INestApplication;
  let requesterToken: string;
  let approverToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    // Two accounts, not one: WorkflowService blocks self-approval, so create
    // and approve must come from different users (see Phase 2 Task 5).
    const requesterLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
    requesterToken = requesterLogin.body.accessToken;

    const approverLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: process.env.APPROVER_USERNAME, password: process.env.APPROVER_PASSWORD });
    approverToken = approverLogin.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a pending instance, then a different approver approving it produces a real purchase order', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set('Authorization', `Bearer ${requesterToken}`)
      .set('Idempotency-Key', `e2e-po-${Date.now()}`)
      .send({ vendorName: 'Acme Supplies', amount: '4200.00', currency: 'USD' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe('pending');

    const approveRes = await request(app.getHttpServer())
      .post(`/workflow/instances/${createRes.body.id}/approve`)
      .set('Authorization', `Bearer ${approverToken}`);

    expect(approveRes.status).toBe(201);
    expect(approveRes.body.status).toBe('approved');

    const listRes = await request(app.getHttpServer())
      .get('/purchase-orders')
      .set('Authorization', `Bearer ${requesterToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.some((po: { vendorName: string }) => po.vendorName === 'Acme Supplies')).toBe(true);
  });

  it('rejects self-approval — the requester cannot approve their own PO', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set('Authorization', `Bearer ${requesterToken}`)
      .set('Idempotency-Key', `e2e-po-self-${Date.now()}`)
      .send({ vendorName: 'Self Approve Vendor', amount: '10.00', currency: 'USD' });

    const approveRes = await request(app.getHttpServer())
      .post(`/workflow/instances/${createRes.body.id}/approve`)
      .set('Authorization', `Bearer ${requesterToken}`);

    expect(approveRes.status).toBe(403);
  });

  it('rejecting an instance leaves no purchase order behind', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set('Authorization', `Bearer ${requesterToken}`)
      .set('Idempotency-Key', `e2e-po-reject-${Date.now()}`)
      .send({ vendorName: 'Rejected Vendor', amount: '100.00', currency: 'USD' });

    await request(app.getHttpServer())
      .post(`/workflow/instances/${createRes.body.id}/reject`)
      .set('Authorization', `Bearer ${approverToken}`)
      .expect(201);

    const listRes = await request(app.getHttpServer())
      .get('/purchase-orders')
      .set('Authorization', `Bearer ${requesterToken}`);

    expect(listRes.body.some((po: { vendorName: string }) => po.vendorName === 'Rejected Vendor')).toBe(false);
  });

  it('rejects a request missing the Idempotency-Key header', async () => {
    const res = await request(app.getHttpServer())
      .post('/purchase-orders')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({ vendorName: 'No Key Vendor', amount: '50.00', currency: 'USD' });

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it against a running dev database**

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=change-me \
APPROVER_USERNAME=approver APPROVER_PASSWORD=change-me-too \
npx jest --config ./test/jest-e2e.json purchase-orders.e2e-spec.ts
```
Expected: all 4 tests PASS. This confirms the entire chain — JWT with `tenantId` → `RbacGuard` → `IdempotencyInterceptor` → `WorkflowService` (transactional, row-locked, self-approval blocked) → the `purchase-order.create` handler → the actual `purchase_orders` row — works end-to-end against real Postgres, not mocks.

- [ ] **Step 3: Commit**

```bash
git add app/test/purchase-orders.e2e-spec.ts app/test/jest-e2e.json
git commit -m "test(purchase-orders): add end-to-end create/approve/reject coverage"
```

---

## Definition of Done

- `purchase_orders` table exists.
- `PurchaseOrdersService`/`Controller` unit-tested; the create handler writes via the transaction `EntityManager` `WorkflowService` provides, not a directly-injected repository.
- `amount` is a validated decimal string end-to-end (DTO → workflow payload → `PurchaseOrder.amount`) — no JS `number` round-trip anywhere on the money path.
- End-to-end test proves: create → pending, a *different* approver approving → real row exists, same-account self-approval → `403`, reject → no row, missing idempotency key → `400`.
- Every one of the four platform capabilities (tenancy, RBAC, idempotency, workflow) is exercised by a real business write for the first time in this codebase.
- `npm run build` and `npm test` both pass in `app/`.
