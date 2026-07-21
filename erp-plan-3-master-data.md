# ERP Phase 3: Master Data (Vendors + Customers) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant-scoped, RBAC-gated `Vendor`/`Customer` master-data module — the canonical reference data every future business module (Purchase Orders now, invoicing/inventory later) points at by id, replacing the free-text `vendorName` string the original Purchase Orders design used.

**Architecture:** One module, `MasterDataModule`, two near-identical entities (`Vendor`, `Customer`), two separate exported services (`VendorsService`, `CustomersService` — kept separate, not a shared "Party" abstraction, since Vendor management and CRM/Customer are different bounded contexts long-term and this keeps a future split between them cheap). Both are tenant-scoped the same way `Task`/`PurchaseOrder` are, with a unique `(tenantId, name)` index to prevent duplicate vendor/customer records — a real ERP data-quality problem, not a hypothetical one. `findById` takes `tenantId` as an explicit parameter and filters at the query itself (`WHERE id = ... AND tenantId = ...`), not just at the entity-load subscriber — this is layer 1 of the same two-layer tenant isolation `erp-platform-design.md` already uses elsewhere (guard/query first, subscriber as the second, catch-all layer). No idempotency-key protection on create routes — duplicate-request protection here comes from the unique constraint, not `@Idempotent()`, since master data isn't a financial write (see Decisions in `docs/superpowers/specs/2026-07-21-core-platform-layer-design.md`).

**Tech Stack:** NestJS, TypeORM, class-validator.

## Global Constraints

- `synchronize` stays off — migrations only, from `app/`.
- Depends on **erp-plan-0-users.md**, **erp-plan-1-tenancy.md**, **erp-plan-2-rbac.md** being complete (`TenantContext`, `RbacGuard`, `@RequirePermission()`). Does **not** depend on **erp-plan-4-idempotency.md** or **erp-plan-5-workflow.md** — master data is plain CRUD, no approval chain, no idempotency keys.
- Must be complete **before** **erp-plan-6-purchase-orders.md**, which references `VendorsService.findById()` to validate `PurchaseOrder.vendorId`.
- Permission strings `masterdata.vendor.create`, `masterdata.vendor.read`, `masterdata.customer.create`, `masterdata.customer.read` are added to the `admin`/requester role's permission list in this phase's seed-script task — RBAC itself has no knowledge of what these strings mean, same as `po.*`.

---

### Task 1: `Vendor` + `Customer` entities + migration

**Files:**
- Create: `app/src/database/entities/vendor.entity.ts`
- Create: `app/src/database/entities/customer.entity.ts`
- Modify: `app/src/database/database.module.ts`
- Modify: `app/src/database/data-source.ts`
- Create: `app/src/database/migrations/<timestamp>-CreateMasterData.ts`

**Interfaces:**
- Produces: `Vendor` — `{ id: string; tenantId: string; name: string; contactEmail: string; active: boolean; createdAt: Date }`.
- Produces: `Customer` — identical shape.
- Both unique on `(tenantId, name)`.

- [ ] **Step 1: Write the entities**

```typescript
// app/src/database/entities/vendor.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('vendors')
@Index(['tenantId', 'name'], { unique: true })
export class Vendor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  name: string;

  @Column()
  contactEmail: string;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
```

```typescript
// app/src/database/entities/customer.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('customers')
@Index(['tenantId', 'name'], { unique: true })
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  name: string;

  @Column()
  contactEmail: string;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 2: Register both entities on both connections**

```typescript
import { Vendor } from './entities/vendor.entity';
import { Customer } from './entities/customer.entity';
// ...
const ENTITIES = [Task, ProcessedEvent, User, Tenant, Role, Vendor, Customer];
```
(same additions in `data-source.ts`'s `entities` array — note this list does **not** yet include `IdempotencyKey`/`WorkflowInstance`/`ApprovalStep`/`PurchaseOrder`: those are added by Phases 4–6, which run after this one per the build order.)

- [ ] **Step 3: Generate and run the migration**

```bash
npm run migration:generate -- src/database/migrations/CreateMasterData
```
Expected: `CREATE TABLE "vendors" (...)` and `CREATE TABLE "customers" (...)`, each with a unique index on `("tenantId", "name")`. Review, then:

```bash
npm run migration:run
```

- [ ] **Step 4: Commit**

```bash
git add app/src/database/entities/vendor.entity.ts app/src/database/entities/customer.entity.ts app/src/database/database.module.ts app/src/database/data-source.ts app/src/database/migrations/
git commit -m "feat(database): add vendors and customers tables"
```

---

### Task 2: `VendorsService` + `CustomersService`

**Files:**
- Create: `app/src/master-data/vendors.service.ts`
- Create: `app/src/master-data/customers.service.ts`
- Test: `app/src/master-data/vendors.service.spec.ts`
- Test: `app/src/master-data/customers.service.spec.ts`

**Interfaces:**
- Consumes: `Vendor`/`Customer` entities from Task 1.
- Produces (identical shape for both services — shown once for `VendorsService`, `CustomersService` is the same with `Customer`):
  - `create(tenantId: string, name: string, contactEmail: string): Promise<Vendor>` — lets a unique-constraint violation on `(tenantId, name)` propagate as-is; the controller (Task 3) turns it into `409`.
  - `findById(tenantId: string, id: string): Promise<Vendor | null>` — **tenant-scoped in the query itself** (`where: { id, tenantId }`), not a bare `findById(id)`. This is layer 1 of tenant isolation; `TenantScopedSubscriber` (Phase 1) is layer 2, catching anything that slips through — the same two-layer shape every other tenant-scoped read in this codebase uses.
  - `findAll(tenantId: string): Promise<Vendor[]>` — reads from `replica`.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/master-data/vendors.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VendorsService } from './vendors.service';
import { Vendor } from '../database/entities/vendor.entity';

describe('VendorsService', () => {
  let service: VendorsService;
  const writeRepo = { create: jest.fn((d) => d), save: jest.fn(async (d) => ({ id: 'vendor-1', active: true, createdAt: new Date(), ...d })) };
  const readRepo = { findOne: jest.fn(), find: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: getRepositoryToken(Vendor, 'default'), useValue: writeRepo },
        { provide: getRepositoryToken(Vendor, 'replica'), useValue: readRepo },
      ],
    }).compile();
    service = module.get(VendorsService);
  });

  it('creates a vendor scoped to a tenant', async () => {
    const vendor = await service.create('tenant-1', 'Acme Supplies', 'ap@acme.test');
    expect(vendor.tenantId).toBe('tenant-1');
    expect(vendor.name).toBe('Acme Supplies');
    expect(vendor.active).toBe(true);
  });

  it('findById filters by id AND tenantId in the same query', async () => {
    readRepo.findOne.mockResolvedValue({ id: 'vendor-1', tenantId: 'tenant-1', name: 'Acme Supplies' });
    const vendor = await service.findById('tenant-1', 'vendor-1');
    expect(readRepo.findOne).toHaveBeenCalledWith({ where: { id: 'vendor-1', tenantId: 'tenant-1' } });
    expect(vendor?.id).toBe('vendor-1');
  });

  it('findById returns null for a vendor belonging to a different tenant', async () => {
    readRepo.findOne.mockResolvedValue(null); // the tenantId filter means this never matches
    const vendor = await service.findById('tenant-2', 'vendor-1');
    expect(vendor).toBeNull();
  });

  it('findAll reads from the replica repo, scoped by tenant', async () => {
    readRepo.find.mockResolvedValue([{ id: 'vendor-1', tenantId: 'tenant-1' }]);
    const result = await service.findAll('tenant-1');
    expect(readRepo.find).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
    expect(result).toHaveLength(1);
  });
});
```

```typescript
// app/src/master-data/customers.service.spec.ts
// Identical structure to vendors.service.spec.ts, against CustomersService/Customer —
// omitted here for brevity, write it as the same four tests with s/[Vv]endor/[Cc]ustomer/
// and s/Acme Supplies/Acme Corp/, s/ap@acme.test/ar@acme.test/.
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest master-data/vendors.service.spec.ts master-data/customers.service.spec.ts
```
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write the implementations**

```typescript
// app/src/master-data/vendors.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vendor } from '../database/entities/vendor.entity';

@Injectable()
export class VendorsService {
  constructor(
    @InjectRepository(Vendor, 'default')
    private readonly writeRepo: Repository<Vendor>,
    @InjectRepository(Vendor, 'replica')
    private readonly readRepo: Repository<Vendor>,
  ) {}

  async create(tenantId: string, name: string, contactEmail: string): Promise<Vendor> {
    const vendor = this.writeRepo.create({ tenantId, name, contactEmail });
    return this.writeRepo.save(vendor);
  }

  async findById(tenantId: string, id: string): Promise<Vendor | null> {
    return this.readRepo.findOne({ where: { id, tenantId } });
  }

  async findAll(tenantId: string): Promise<Vendor[]> {
    return this.readRepo.find({ where: { tenantId } });
  }
}
```

```typescript
// app/src/master-data/customers.service.ts
// Identical to VendorsService, against the Customer entity — same three methods,
// same tenant-scoped findById signature.
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from '../database/entities/customer.entity';

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer, 'default')
    private readonly writeRepo: Repository<Customer>,
    @InjectRepository(Customer, 'replica')
    private readonly readRepo: Repository<Customer>,
  ) {}

  async create(tenantId: string, name: string, contactEmail: string): Promise<Customer> {
    const customer = this.writeRepo.create({ tenantId, name, contactEmail });
    return this.writeRepo.save(customer);
  }

  async findById(tenantId: string, id: string): Promise<Customer | null> {
    return this.readRepo.findOne({ where: { id, tenantId } });
  }

  async findAll(tenantId: string): Promise<Customer[]> {
    return this.readRepo.find({ where: { tenantId } });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest master-data/vendors.service.spec.ts master-data/customers.service.spec.ts
```
Expected: PASS, 4 tests each.

- [ ] **Step 5: Commit**

```bash
git add app/src/master-data/vendors.service.ts app/src/master-data/customers.service.ts app/src/master-data/vendors.service.spec.ts app/src/master-data/customers.service.spec.ts
git commit -m "feat(master-data): add VendorsService and CustomersService, tenant-scoped findById"
```

---

### Task 3: DTOs + `VendorsController` + `CustomersController`

**Files:**
- Create: `app/src/master-data/dto/create-vendor.dto.ts`
- Create: `app/src/master-data/dto/create-customer.dto.ts`
- Create: `app/src/master-data/vendors.controller.ts`
- Create: `app/src/master-data/customers.controller.ts`
- Test: `app/src/master-data/vendors.controller.spec.ts`
- Test: `app/src/master-data/customers.controller.spec.ts`

**Interfaces:**
- Consumes: `VendorsService`/`CustomersService` (Task 2), `JwtAuthGuard` (existing), `RbacGuard`/`RequirePermission` (Phase 2), `TenantContext.getTenantId()` (Phase 1).
- Produces: `POST /vendors` (`masterdata.vendor.create`), `GET /vendors` (`masterdata.vendor.read`); `POST /customers` (`masterdata.customer.create`), `GET /customers` (`masterdata.customer.read`). A unique-constraint violation on create is caught and returned as `409`, not a raw 500.

- [ ] **Step 1: Write the DTOs**

```typescript
// app/src/master-data/dto/create-vendor.dto.ts
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class CreateVendorDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  contactEmail: string;
}
```

```typescript
// app/src/master-data/dto/create-customer.dto.ts
// Identical shape to CreateVendorDto.
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  contactEmail: string;
}
```

- [ ] **Step 2: Write the failing controller tests**

```typescript
// app/src/master-data/vendors.controller.spec.ts
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { TenantContext } from '../tenancy/tenant-context';

describe('VendorsController', () => {
  let controller: VendorsController;
  const service = { create: jest.fn(), findAll: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [VendorsController],
      providers: [{ provide: VendorsService, useValue: service }],
    }).compile();
    controller = module.get(VendorsController);
  });

  it('create delegates to VendorsService.create with the current tenant', async () => {
    service.create.mockResolvedValue({ id: 'vendor-1', name: 'Acme Supplies' });
    const dto = { name: 'Acme Supplies', contactEmail: 'ap@acme.test' };
    const result = await TenantContext.run('tenant-1', () => controller.create(dto));
    expect(service.create).toHaveBeenCalledWith('tenant-1', 'Acme Supplies', 'ap@acme.test');
    expect(result.id).toBe('vendor-1');
  });

  it('create surfaces a duplicate-name unique-constraint violation as 409', async () => {
    service.create.mockRejectedValue({ code: '23505' }); // Postgres unique_violation
    const dto = { name: 'Acme Supplies', contactEmail: 'ap@acme.test' };
    await expect(TenantContext.run('tenant-1', () => controller.create(dto))).rejects.toThrow(ConflictException);
  });

  it('findAll delegates to VendorsService.findAll with the current tenant', async () => {
    service.findAll.mockResolvedValue([{ id: 'vendor-1' }]);
    const result = await TenantContext.run('tenant-1', () => controller.findAll());
    expect(service.findAll).toHaveBeenCalledWith('tenant-1');
    expect(result).toHaveLength(1);
  });
});
```

```typescript
// app/src/master-data/customers.controller.spec.ts
// Identical structure against CustomersController/CustomersService — same three
// tests with s/[Vv]endor/[Cc]ustomer/, s/Acme Supplies/Acme Corp/.
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx jest master-data/vendors.controller.spec.ts master-data/customers.controller.spec.ts
```
Expected: FAIL — modules don't exist yet.

- [ ] **Step 4: Write the implementations**

```typescript
// app/src/master-data/vendors.controller.ts
import { Body, ConflictException, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { VendorsService } from './vendors.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { TenantContext } from '../tenancy/tenant-context';

@Controller('vendors')
@UseGuards(JwtAuthGuard, RbacGuard)
export class VendorsController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Post()
  @RequirePermission('masterdata.vendor.create')
  async create(@Body() dto: CreateVendorDto) {
    try {
      return await this.vendorsService.create(TenantContext.getTenantId(), dto.name, dto.contactEmail);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException(`Vendor '${dto.name}' already exists`);
      }
      throw err;
    }
  }

  @Get()
  @RequirePermission('masterdata.vendor.read')
  findAll() {
    return this.vendorsService.findAll(TenantContext.getTenantId());
  }
}
```

```typescript
// app/src/master-data/customers.controller.ts
// Identical to VendorsController, against CustomersService/CreateCustomerDto,
// routes @Controller('customers'), permissions masterdata.customer.create/read.
import { Body, ConflictException, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { TenantContext } from '../tenancy/tenant-context';

@Controller('customers')
@UseGuards(JwtAuthGuard, RbacGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  @RequirePermission('masterdata.customer.create')
  async create(@Body() dto: CreateCustomerDto) {
    try {
      return await this.customersService.create(TenantContext.getTenantId(), dto.name, dto.contactEmail);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException(`Customer '${dto.name}' already exists`);
      }
      throw err;
    }
  }

  @Get()
  @RequirePermission('masterdata.customer.read')
  findAll() {
    return this.customersService.findAll(TenantContext.getTenantId());
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest master-data/vendors.controller.spec.ts master-data/customers.controller.spec.ts
```
Expected: PASS, 3 tests each.

- [ ] **Step 6: Commit**

```bash
git add app/src/master-data/dto app/src/master-data/vendors.controller.ts app/src/master-data/customers.controller.ts app/src/master-data/vendors.controller.spec.ts app/src/master-data/customers.controller.spec.ts
git commit -m "feat(master-data): add VendorsController and CustomersController"
```

---

### Task 4: `MasterDataModule`

**Files:**
- Create: `app/src/master-data/master-data.module.ts`
- Modify: `app/src/app.module.ts`

**Interfaces:**
- Consumes: `RbacModule` (Phase 2).
- Produces: `MasterDataModule`, exporting `VendorsService` and `CustomersService` for Phase 6's `PurchaseOrdersModule` to import.

- [ ] **Step 1: Write the module**

```typescript
// app/src/master-data/master-data.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Vendor } from '../database/entities/vendor.entity';
import { Customer } from '../database/entities/customer.entity';
import { VendorsService } from './vendors.service';
import { CustomersService } from './customers.service';
import { VendorsController } from './vendors.controller';
import { CustomersController } from './customers.controller';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vendor, Customer], 'default'),
    TypeOrmModule.forFeature([Vendor, Customer], 'replica'),
    RbacModule,
  ],
  controllers: [VendorsController, CustomersController],
  providers: [VendorsService, CustomersService],
  exports: [VendorsService, CustomersService],
})
export class MasterDataModule {}
```

- [ ] **Step 2: Register it in `AppModule`**

```typescript
import { MasterDataModule } from './master-data/master-data.module';
// ...
imports: [
  // ...existing imports...
  MasterDataModule,
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
git add app/src/master-data/master-data.module.ts app/src/app.module.ts
git commit -m "feat(master-data): wire MasterDataModule into AppModule"
```

---

### Task 5: Seed master-data permissions onto the existing `admin` role

**Files:**
- Modify: `app/src/database/seed-admin.ts`

**Interfaces:**
- Consumes: `ensureRole`'s upsert behavior from **erp-plan-2-rbac.md** Task 5 (already updated there to sync permissions on every run, not just on first creation — that fix is what makes this task take effect on a database that was already seeded before this phase existed).
- Produces: the `admin` (requester) role's permission list gains `masterdata.vendor.create`, `masterdata.vendor.read`, `masterdata.customer.create`, `masterdata.customer.read`. The `approver` role is untouched — vendor/customer management isn't an approval-gated action.

- [ ] **Step 1: Extend `REQUESTER_PERMISSIONS`**

In `app/src/database/seed-admin.ts`:

```typescript
const REQUESTER_PERMISSIONS = [
  'po.create',
  'po.read',
  'masterdata.vendor.create',
  'masterdata.vendor.read',
  'masterdata.customer.create',
  'masterdata.customer.read',
];
```

No other change to the script — `ensureRole` already upserts, so re-running against a database seeded by Phase 2 alone picks up the new permissions on the existing `admin` role.

- [ ] **Step 2: Run it**

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=change-me \
APPROVER_USERNAME=approver APPROVER_PASSWORD=change-me-too \
npm run seed:admin
```
Expected: `Updated permissions for role 'admin'.` on a database seeded before this phase; `Created role 'admin'.` with the full list on a fresh database. Either way, `admin` ends up with all six permissions.

- [ ] **Step 3: Commit**

```bash
git add app/src/database/seed-admin.ts
git commit -m "feat(database): grant master-data permissions to the admin role"
```

---

## Definition of Done

- `vendors` and `customers` tables exist, each unique on `(tenantId, name)`.
- `VendorsService`/`CustomersService` unit-tested: create, tenant-scoped `findById` (including the cross-tenant-returns-null case), `findAll`.
- `VendorsController`/`CustomersController` expose create/list, RBAC-gated, unit-tested including the duplicate-name → `409` path.
- `admin` role has `masterdata.vendor.create`/`read` and `masterdata.customer.create`/`read`; the seed script's `ensureRole` upserts permissions so this applies even to an already-seeded database.
- `npm run build` and `npm test` both pass in `app/`.
- No idempotency-key handling on `POST /vendors`/`POST /customers` — intentional, dedupe is the unique constraint's job, not `@Idempotent()`'s (see Architecture note above).
