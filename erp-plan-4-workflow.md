# ERP Phase 4: Workflow / Approval Chains — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A generic pending → approved/rejected state machine. A business module (Phase 5's `purchase-orders`) creates a `WorkflowInstance` instead of writing directly; on approval, `WorkflowService` invokes whatever handler that business module registered for the instance's `type`.

**Architecture:** Two tables — `WorkflowInstance` (the state) and `ApprovalStep` (the audit trail of who approved/rejected and when). No `WorkflowDefinition` table: definitions are an in-process handler registry (`WorkflowService.registerHandler(type, handler)`), since there's no admin UI to edit workflow definitions dynamically and a DB table for that would just be config nobody reads. `WorkflowController`'s approve/reject routes only require authentication (`JwtAuthGuard`) — the permission check is *dynamic* (which permission is required depends on the instance's `type`, looked up at runtime), so it happens inside `WorkflowService`, not via a static `@RequirePermission()` on the route the way Phase 5's create endpoint works.

**Tech Stack:** NestJS, TypeORM.

## Global Constraints

- `synchronize` stays off — migrations only, from `app/`.
- Depends on **erp-plan-1-tenancy.md** (`TenantContext`) and **erp-plan-2-rbac.md** (`RolesService`, `UsersService.findById`).
- This module has zero knowledge of purchase orders, invoices, or any other business concept — it only knows `type: string`, `payload: unknown`, and a permission-string lookup table keyed by `type`. Phase 5 is what makes it mean anything.

---

### Task 1: `WorkflowInstance` + `ApprovalStep` entities + migration

**Files:**
- Create: `app/src/database/entities/workflow-instance.entity.ts`
- Create: `app/src/database/entities/approval-step.entity.ts`
- Modify: `app/src/database/database.module.ts`
- Modify: `app/src/database/data-source.ts`
- Create: `app/src/database/migrations/<timestamp>-CreateWorkflow.ts`

**Interfaces:**
- Produces: `WorkflowInstance` — `{ id: string; tenantId: string; type: string; status: 'pending' | 'approved' | 'rejected'; payload: unknown; requestedBy: string; createdAt: Date; completedAt: Date | null }`.
- Produces: `ApprovalStep` — `{ id: string; workflowInstanceId: string; approverId: string; action: 'approve' | 'reject'; createdAt: Date }`.

- [ ] **Step 1: Write the entities**

```typescript
// app/src/database/entities/workflow-instance.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('workflow_instances')
export class WorkflowInstance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  type: string;

  @Column({ default: 'pending' })
  status: 'pending' | 'approved' | 'rejected';

  @Column({ type: 'jsonb' })
  payload: unknown;

  @Column()
  requestedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;
}
```

```typescript
// app/src/database/entities/approval-step.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('approval_steps')
export class ApprovalStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  workflowInstanceId: string;

  @Column()
  approverId: string;

  @Column()
  action: 'approve' | 'reject';

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 2: Register both entities on both connections**

```typescript
import { WorkflowInstance } from './entities/workflow-instance.entity';
import { ApprovalStep } from './entities/approval-step.entity';
// ...
const ENTITIES = [Task, ProcessedEvent, User, Tenant, Role, IdempotencyKey, WorkflowInstance, ApprovalStep];
```
(same in `data-source.ts`)

- [ ] **Step 3: Generate and run the migration**

```bash
npm run migration:generate -- src/database/migrations/CreateWorkflow
```
Review the generated `CREATE TABLE "workflow_instances"` / `CREATE TABLE "approval_steps"`, then:

```bash
npm run migration:run
```

- [ ] **Step 4: Commit**

```bash
git add app/src/database/entities/workflow-instance.entity.ts app/src/database/entities/approval-step.entity.ts app/src/database/database.module.ts app/src/database/data-source.ts app/src/database/migrations/
git commit -m "feat(database): add workflow_instances and approval_steps tables"
```

---

### Task 2: `WorkflowService`

**Files:**
- Create: `app/src/workflow/workflow.service.ts`
- Test: `app/src/workflow/workflow.service.spec.ts`

**Interfaces:**
- Consumes: `RolesService.hasPermission`/`findById` (Phase 2), `UsersService.findById` (Phase 0/2).
- Produces: `WorkflowService` with:
  - `registerHandler(type: string, requiredApprovePermission: string, handler: (payload: unknown, tenantId: string) => Promise<void>): void`
  - `create(type: string, payload: unknown, tenantId: string, requestedBy: string): Promise<WorkflowInstance>`
  - `approve(instanceId: string, approverId: string): Promise<WorkflowInstance>`
  - `reject(instanceId: string, approverId: string): Promise<WorkflowInstance>`
  - `findById(id: string): Promise<WorkflowInstance | null>`

This is the exact interface Phase 5's `PurchaseOrdersService` calls `registerHandler`/`create` against, and `WorkflowController` (Task 3) calls `approve`/`reject` against.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/workflow/workflow.service.spec.ts
import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WorkflowService } from './workflow.service';
import { WorkflowInstance } from '../database/entities/workflow-instance.entity';
import { ApprovalStep } from '../database/entities/approval-step.entity';
import { UsersService } from '../users/users.service';
import { RolesService } from '../rbac/roles.service';

describe('WorkflowService', () => {
  let service: WorkflowService;
  const instanceRepo = {
    create: jest.fn((d) => d),
    save: jest.fn(async (d) => ({ id: 'wf-1', createdAt: new Date(), completedAt: null, ...d })),
    findOne: jest.fn(),
  };
  const stepRepo = { create: jest.fn((d) => d), save: jest.fn(async (d) => d) };
  const usersService = { findById: jest.fn() };
  const rolesService = { findById: jest.fn(), hasPermission: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        WorkflowService,
        { provide: getRepositoryToken(WorkflowInstance, 'default'), useValue: instanceRepo },
        { provide: getRepositoryToken(ApprovalStep, 'default'), useValue: stepRepo },
        { provide: UsersService, useValue: usersService },
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();
    service = module.get(WorkflowService);
    service.registerHandler('purchase-order.create', 'po.approve', jest.fn());
  });

  it('creates a pending instance', async () => {
    const instance = await service.create('purchase-order.create', { amount: 100 }, 'tenant-1', 'user-1');
    expect(instance.status).toBe('pending');
    expect(instance.payload).toEqual({ amount: 100 });
  });

  it('rejects create for an unregistered type', async () => {
    await expect(service.create('unknown.type', {}, 'tenant-1', 'user-1')).rejects.toThrow();
  });

  it('approve invokes the registered handler and marks the instance approved', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    service.registerHandler('purchase-order.create', 'po.approve', handler);
    instanceRepo.findOne.mockResolvedValue({
      id: 'wf-1', tenantId: 'tenant-1', type: 'purchase-order.create', status: 'pending', payload: { amount: 100 },
    });
    usersService.findById.mockResolvedValue({ id: 'approver-1', tenantId: 'tenant-1', roleId: 'role-1' });
    rolesService.findById.mockResolvedValue({ id: 'role-1', tenantId: 'tenant-1', permissions: ['po.approve'] });
    rolesService.hasPermission.mockReturnValue(true);

    const result = await service.approve('wf-1', 'approver-1');

    expect(handler).toHaveBeenCalledWith({ amount: 100 }, 'tenant-1');
    expect(result.status).toBe('approved');
    expect(stepRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve', approverId: 'approver-1' }));
  });

  it('approve throws when the approver lacks the required permission', async () => {
    instanceRepo.findOne.mockResolvedValue({
      id: 'wf-1', tenantId: 'tenant-1', type: 'purchase-order.create', status: 'pending', payload: {},
    });
    usersService.findById.mockResolvedValue({ id: 'approver-1', tenantId: 'tenant-1', roleId: 'role-1' });
    rolesService.findById.mockResolvedValue({ id: 'role-1', tenantId: 'tenant-1', permissions: ['po.read'] });
    rolesService.hasPermission.mockReturnValue(false);

    await expect(service.approve('wf-1', 'approver-1')).rejects.toThrow(ForbiddenException);
  });

  it('approve throws on a non-pending instance', async () => {
    instanceRepo.findOne.mockResolvedValue({ id: 'wf-1', status: 'approved' });
    await expect(service.approve('wf-1', 'approver-1')).rejects.toThrow(ConflictException);
  });

  it('approve throws on an unknown instance id', async () => {
    instanceRepo.findOne.mockResolvedValue(null);
    await expect(service.approve('missing', 'approver-1')).rejects.toThrow(NotFoundException);
  });

  it('reject marks the instance rejected without invoking the handler', async () => {
    const handler = jest.fn();
    service.registerHandler('purchase-order.create', 'po.approve', handler);
    instanceRepo.findOne.mockResolvedValue({
      id: 'wf-1', tenantId: 'tenant-1', type: 'purchase-order.create', status: 'pending', payload: {},
    });
    usersService.findById.mockResolvedValue({ id: 'approver-1', tenantId: 'tenant-1', roleId: 'role-1' });
    rolesService.findById.mockResolvedValue({ id: 'role-1', tenantId: 'tenant-1', permissions: ['po.approve'] });
    rolesService.hasPermission.mockReturnValue(true);

    const result = await service.reject('wf-1', 'approver-1');

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe('rejected');
    expect(stepRepo.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'reject' }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest workflow/workflow.service.spec.ts
```
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/workflow/workflow.service.ts
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkflowInstance } from '../database/entities/workflow-instance.entity';
import { ApprovalStep } from '../database/entities/approval-step.entity';
import { UsersService } from '../users/users.service';
import { RolesService } from '../rbac/roles.service';

type Handler = (payload: unknown, tenantId: string) => Promise<void>;

interface Registration {
  requiredApprovePermission: string;
  handler: Handler;
}

@Injectable()
export class WorkflowService {
  private readonly registry = new Map<string, Registration>();

  constructor(
    @InjectRepository(WorkflowInstance, 'default')
    private readonly instanceRepo: Repository<WorkflowInstance>,
    @InjectRepository(ApprovalStep, 'default')
    private readonly stepRepo: Repository<ApprovalStep>,
    private readonly usersService: UsersService,
    private readonly rolesService: RolesService,
  ) {}

  registerHandler(type: string, requiredApprovePermission: string, handler: Handler): void {
    this.registry.set(type, { requiredApprovePermission, handler });
  }

  async create(
    type: string,
    payload: unknown,
    tenantId: string,
    requestedBy: string,
  ): Promise<WorkflowInstance> {
    if (!this.registry.has(type)) {
      throw new Error(`No handler registered for workflow type '${type}'`);
    }
    const instance = this.instanceRepo.create({
      tenantId,
      type,
      status: 'pending',
      payload,
      requestedBy,
      completedAt: null,
    });
    return this.instanceRepo.save(instance);
  }

  async approve(instanceId: string, approverId: string): Promise<WorkflowInstance> {
    const instance = await this.loadPending(instanceId);
    const registration = this.registry.get(instance.type);
    if (!registration) {
      throw new Error(`No handler registered for workflow type '${instance.type}'`);
    }

    await this.assertPermission(approverId, instance.tenantId, registration.requiredApprovePermission);
    await registration.handler(instance.payload, instance.tenantId);

    await this.stepRepo.save(
      this.stepRepo.create({ workflowInstanceId: instance.id, approverId, action: 'approve' }),
    );

    return this.instanceRepo.save({ ...instance, status: 'approved', completedAt: new Date() });
  }

  async reject(instanceId: string, approverId: string): Promise<WorkflowInstance> {
    const instance = await this.loadPending(instanceId);
    const registration = this.registry.get(instance.type);
    if (!registration) {
      throw new Error(`No handler registered for workflow type '${instance.type}'`);
    }

    await this.assertPermission(approverId, instance.tenantId, registration.requiredApprovePermission);

    await this.stepRepo.save(
      this.stepRepo.create({ workflowInstanceId: instance.id, approverId, action: 'reject' }),
    );

    return this.instanceRepo.save({ ...instance, status: 'rejected', completedAt: new Date() });
  }

  async findById(id: string): Promise<WorkflowInstance | null> {
    return this.instanceRepo.findOne({ where: { id } });
  }

  private async loadPending(instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.instanceRepo.findOne({ where: { id: instanceId } });
    if (!instance) {
      throw new NotFoundException('Workflow instance not found');
    }
    if (instance.status !== 'pending') {
      throw new ConflictException(`Workflow instance is already ${instance.status}`);
    }
    return instance;
  }

  private async assertPermission(userId: string, tenantId: string, permission: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user?.roleId) {
      throw new ForbiddenException('No role assigned');
    }
    const role = await this.rolesService.findById(user.roleId);
    if (!role || role.tenantId !== tenantId) {
      throw new ForbiddenException('Role not valid for this tenant');
    }
    if (!this.rolesService.hasPermission(role, permission)) {
      throw new ForbiddenException(`Missing permission: ${permission}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest workflow/workflow.service.spec.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/workflow/workflow.service.ts app/src/workflow/workflow.service.spec.ts
git commit -m "feat(workflow): add WorkflowService with handler registry and permission-gated approval"
```

---

### Task 3: `WorkflowController`

**Files:**
- Create: `app/src/workflow/workflow.controller.ts`
- Test: `app/src/workflow/workflow.controller.spec.ts`

**Interfaces:**
- Consumes: `WorkflowService.approve`/`reject`/`findById` from Task 2.
- Produces: `POST /workflow/instances/:id/approve`, `POST /workflow/instances/:id/reject` — both behind `JwtAuthGuard` only (permission is checked inside `WorkflowService`, per this plan's Architecture note); `GET /workflow/instances/:id` behind `JwtAuthGuard`.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/workflow/workflow.controller.spec.ts
import { Test } from '@nestjs/testing';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

describe('WorkflowController', () => {
  let controller: WorkflowController;
  const workflowService = { approve: jest.fn(), reject: jest.fn(), findById: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [WorkflowController],
      providers: [{ provide: WorkflowService, useValue: workflowService }],
    }).compile();
    controller = module.get(WorkflowController);
  });

  it('approve delegates to WorkflowService with the caller as approver', async () => {
    workflowService.approve.mockResolvedValue({ id: 'wf-1', status: 'approved' });
    const result = await controller.approve('wf-1', { userId: 'approver-1' } as any);
    expect(workflowService.approve).toHaveBeenCalledWith('wf-1', 'approver-1');
    expect(result.status).toBe('approved');
  });

  it('reject delegates to WorkflowService with the caller as approver', async () => {
    workflowService.reject.mockResolvedValue({ id: 'wf-1', status: 'rejected' });
    const result = await controller.reject('wf-1', { userId: 'approver-1' } as any);
    expect(workflowService.reject).toHaveBeenCalledWith('wf-1', 'approver-1');
    expect(result.status).toBe('rejected');
  });

  it('findOne returns the instance', async () => {
    workflowService.findById.mockResolvedValue({ id: 'wf-1', status: 'pending' });
    const result = await controller.findOne('wf-1');
    expect(result?.id).toBe('wf-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest workflow/workflow.controller.spec.ts
```
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/workflow/workflow.controller.ts
import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkflowService } from './workflow.service';

interface RequestUser {
  userId: string;
  username: string;
  tenantId: string;
}

@Controller('workflow/instances')
@UseGuards(JwtAuthGuard)
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post(':id/approve')
  approve(@Param('id') id: string, @Req() req: { user: RequestUser }) {
    return this.workflowService.approve(id, req.user.userId);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Req() req: { user: RequestUser }) {
    return this.workflowService.reject(id, req.user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.workflowService.findById(id);
  }
}
```

Note: the test above calls `controller.approve('wf-1', { userId: 'approver-1' } as any)` — passing a partial user object directly, not a full `Req()`-shaped request. Adjust the test's second argument to `{ user: { userId: 'approver-1' } } as any` to match the real `@Req()` shape, or (equivalent, less coupling to Express internals) switch the controller to a custom `@CurrentUser()` param decorator that extracts `req.user` directly — either is fine; the version above keeps this task's scope to what's already established (`@Req()` is used nowhere else in this codebase, but it's the simplest option given no `@CurrentUser()` decorator exists yet, and introducing one is out of scope for this plan).

- [ ] **Step 4: Fix the test to match `@Req()`**

```typescript
it('approve delegates to WorkflowService with the caller as approver', async () => {
  workflowService.approve.mockResolvedValue({ id: 'wf-1', status: 'approved' });
  const result = await controller.approve('wf-1', { user: { userId: 'approver-1' } } as any);
  expect(workflowService.approve).toHaveBeenCalledWith('wf-1', 'approver-1');
  expect(result.status).toBe('approved');
});

it('reject delegates to WorkflowService with the caller as approver', async () => {
  workflowService.reject.mockResolvedValue({ id: 'wf-1', status: 'rejected' });
  const result = await controller.reject('wf-1', { user: { userId: 'approver-1' } } as any);
  expect(workflowService.reject).toHaveBeenCalledWith('wf-1', 'approver-1');
  expect(result.status).toBe('rejected');
});
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest workflow/workflow.controller.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add app/src/workflow/workflow.controller.ts app/src/workflow/workflow.controller.spec.ts
git commit -m "feat(workflow): add WorkflowController approve/reject/get endpoints"
```

---

### Task 4: `WorkflowModule`

**Files:**
- Create: `app/src/workflow/workflow.module.ts`
- Modify: `app/src/app.module.ts`

**Interfaces:**
- Consumes: `RbacModule` (Phase 2), `UsersModule` (Phase 0).
- Produces: `WorkflowModule`, exporting `WorkflowService` for Phase 5's `PurchaseOrdersModule` to call `registerHandler`/`create` on.

- [ ] **Step 1: Write the module**

```typescript
// app/src/workflow/workflow.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowInstance } from '../database/entities/workflow-instance.entity';
import { ApprovalStep } from '../database/entities/approval-step.entity';
import { WorkflowService } from './workflow.service';
import { WorkflowController } from './workflow.controller';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowInstance, ApprovalStep], 'default'),
    RbacModule,
  ],
  controllers: [WorkflowController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
```

- [ ] **Step 2: Register it in `AppModule`**

```typescript
import { WorkflowModule } from './workflow/workflow.module';
// ...
imports: [
  // ...existing imports...
  WorkflowModule,
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
git add app/src/workflow/workflow.module.ts app/src/app.module.ts
git commit -m "feat(workflow): wire WorkflowModule into AppModule"
```

---

## Definition of Done

- `workflow_instances` and `approval_steps` tables exist.
- `WorkflowService` unit-tested: create against a registered/unregistered type, approve (success, permission-denied, non-pending, unknown-id), reject.
- `WorkflowController` exposes approve/reject/get, unit-tested.
- No business logic about purchase orders (or anything else) exists in this module — confirmed by the fact that its only test fixtures are the string `'purchase-order.create'` used purely as an opaque type key.
- `npm run build` and `npm test` both pass in `app/`.
