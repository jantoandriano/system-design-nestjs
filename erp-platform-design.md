# ERP Platform Capabilities — Design

Date: 2026-07-21
Status: Approved (design), pending implementation plan

## Goal

Add four platform-level capabilities that don't exist anywhere in the current codebase, so future ERP business modules (invoicing, purchase orders, GL, etc.) can be built on top of them:

- RBAC (tenant-scoped roles/permissions)
- Idempotency keys on financial writes
- Workflow / approval chains
- Multi-tenancy

Plus: design the modular monolith so a future split into microservices is mechanical, without actually extracting services now.

**In scope as proof:** one real ERP business module — **Purchase Orders** — built end-to-end on top of the four capabilities. This replaces using `Task` as a stand-in; PO create is a real financial write, gated by RBAC, idempotent, and requiring approval before it commits.

**Explicitly out of scope:** any other ERP business module (GL, AP/AR, inventory, full invoicing).

**Addendum (2026-07-21):** `docs/superpowers/specs/2026-07-21-core-platform-layer-design.md` added a fifth platform capability — a `master-data` module (`Vendor`/`Customer`) — inserted as phase 3, before `idempotency`/`workflow`/`purchase-orders`, and fixed `PurchaseOrder.vendorName` to be a validated `vendorId` FK instead of a free-text string. This document has been updated in place to reflect that; the addendum spec is the historical record of why.

## Current state (relevant facts)

- `AuthService` (`app/src/auth/auth.service.ts`) checks a single credential pair from env vars (`AUTH_USERNAME`/`AUTH_PASSWORD_HASH`), no users table.
- `Task` entity (`app/src/database/entities/task.entity.ts`) has no `tenant_id` or owner.
- Two named TypeORM connections (`default` = primary/writes, `replica` = reads) registered in `app/src/database/database.module.ts`, both against the same `ENTITIES` array — any new entity needs both.
- `TasksService.create` (`app/src/tasks/tasks.service.ts`) writes to the primary first, then best-effort publishes to RabbitMQ (publish failure is logged, not thrown — see the transactional-outbox comment there) — the pattern (write repo / read repo / publish) new modules should follow.
- No RBAC, no per-request tenant context, no idempotency handling, no approval/workflow concept, no purchasing/financial domain anywhere in the repo today.

## Architecture

New modules under `app/src/`, each self-contained — owns its own entities, exposes only injectable services/guards/decorators to the rest of the app. No module reaches into another module's repository directly. This boundary discipline is what makes a later microservices split mechanical: an in-process call becomes an AMQP call (the app already has this pattern via `queue.service.ts` / `queue.consumer.ts`), and each module's tables become that service's own schema.

- `users/` — replaces `AuthService`'s env-credential check with a real `User` entity + per-user bcrypt hash. Prerequisite for RBAC (roles attach to users, not env vars).
- `tenancy/` — `Tenant` entity; `tenant_id` column added to `User` and `PurchaseOrder` (and every future entity). `Task` is deliberately left untouched — its `GET /tasks` is intentionally unauthenticated (see `CLAUDE.md`), so there's no tenant context to scope it by; touching it would either break that or create a silent cross-tenant leak on an unauthenticated route. Tenant context is request-scoped via `AsyncLocalStorage`, set from the JWT's `tenantId` claim.
- `rbac/` — `Role`, `Permission`, `UserRole` (tenant-scoped — a user's role is per-tenant, not global); `RbacGuard`; `@RequirePermission()` decorator.
- `master-data/` — `Vendor`/`Customer` entities (tenant-scoped, unique on `(tenantId, name)`, `active` flag instead of hard delete), `VendorsService`/`CustomersService` (both tenant-scoped lookups — `findById(tenantId, id)`, not a bare `findById(id)`, so cross-tenant reference is rejected at the query itself, not only by the tenancy subscriber after the row loads). The canonical source of truth `purchase-orders/` (and later invoicing/inventory) reference by id, never by free-text name.
- `idempotency/` — `IdempotencyKey` entity (tenant_id + key + request-body hash + cached response + status); `IdempotencyInterceptor`; `@Idempotent()` decorator.
- `workflow/` — `WorkflowInstance`, `ApprovalStep` tables (the state machine is the instance's `status` column and its legal transitions, not a separate `WorkflowDefinition` table — no admin UI exists to edit workflow definitions dynamically, so definitions are an in-process handler registry: `WorkflowService.registerHandler(type, handler)`). Generic — not aware of purchase orders specifically, just invokes whatever handler is registered for an instance's `type` on final approval. `approve()`/`reject()` run transactionally with a `pessimistic_write` lock on the instance row (two concurrent approvals of the same instance must not both fire the handler) and block self-approval (`approverId === requestedBy` → `403`).
- `purchase-orders/` — `PurchaseOrder` entity (`id`, `tenant_id`, `vendorId` — a validated FK into `master-data`, not a free-text string — `amount` as a decimal string end-to-end, `currency`, `status: approved | rejected`, `requestedBy`, `approvedBy`, `createdAt`, `approvedAt`). The real business module proving the other capabilities work together. Registers a `purchase-order.create` handler with `workflow/` that performs the actual `PurchaseOrder` insert (via the approval transaction's `EntityManager`) on final approval. Follows the existing write-repo/read-repo/publish pattern from `TasksService`.

## Request flow

Purchase order create → approval → committed.

1. `POST /purchase-orders` (body: `vendorId`, `amount`, `currency`) → `JwtAuthGuard` → `RbacGuard` (permission `po.create`) → `TenantContextInterceptor` binds `tenant_id` from the JWT claim into `AsyncLocalStorage` for the rest of the request.
2. `IdempotencyInterceptor` (via `@Idempotent()`) looks up the `Idempotency-Key` header + tenant + request-body hash in `idempotency_keys`.
   - Same key + same hash → return the cached response, no side effect (replay).
   - Same key + different hash → `409 Conflict`, no write.
   - A `pending` key older than `PENDING_TIMEOUT_MS` (30s — a crash-abandoned key, not a slow request) → reclaimed, treated as new.
   - New key → proceed.
3. `PurchaseOrdersService` validates `vendorId` via `VendorsService.findById(tenantId, vendorId)` — `400` if missing (a cross-tenant `vendorId` is rejected the same way: the tenant-scoped query itself finds nothing). Then, instead of writing the `PurchaseOrder` row directly, it creates a `WorkflowInstance` (`status = pending`, `type = purchase-order.create`) holding the validated payload. The pending-instance response (id + status) is what gets cached under that idempotency key.
4. A *different* approver (not the requester — self-approval is blocked, `403`) calls `POST /workflow/instances/:id/approve` — authenticated (`JwtAuthGuard`), but the required permission (`po.approve`) is checked *inside* `WorkflowService`, not by a static `RbacGuard`/`@RequirePermission()` on the route: which permission is required depends on the instance's `type`, only known once the instance is loaded, so a route-level decorator can't express it. `WorkflowService` looks it up from what the type registered and checks it against the approver's role, same tenant-scoped role check `RbacGuard` does elsewhere. The whole approve — row-lock, permission check, handler invocation, `ApprovalStep` insert, instance status transition — runs in one DB transaction, so two concurrent approvals of the same instance can't both succeed. The demo chain is single-step (one `po.approve` holder approves); the engine itself supports N-step chains for future modules. On the required approval, `WorkflowService` invokes the `purchase-order.create` handler with that transaction's `EntityManager`, which inserts the `PurchaseOrder` row (`status = approved`, tenant-scoped) and marks the instance `completed` — atomically, same commit. `POST /workflow/instances/:id/reject` marks the instance `rejected`, no `PurchaseOrder` row is created.
5. `GET /purchase-orders` (permission `po.read`) reads from the replica, tenant-scoped, following `TasksService.findAll`'s read-repo pattern.
6. Tenant isolation is enforced twice: at the guard (early reject) and at a TypeORM subscriber on tenant-scoped entities (defense in depth — a guard bug alone can't leak cross-tenant data).

## Error handling

- Idempotency key reused with a different payload hash → `409`, no write performed.
- Missing or mismatched tenant context on a scoped entity → rejected at the subscriber level, not only the guard.
- Approve/reject called on a non-`pending` workflow instance → `409` (also what a losing concurrent approve sees, since the row lock serializes the two).
- Self-approval (`approverId === instance.requestedBy`) → `403`, checked before the permission lookup.
- Permission check fails (wrong role, or the right role but wrong tenant) → `403`.
- `amount` not a valid decimal string, or `currency`/`vendorId` missing → `400` (DTO validation), before idempotency/workflow are touched.
- `vendorId` doesn't resolve for the caller's tenant (unknown, or belongs to another tenant) → `400`, checked via `VendorsService.findById(tenantId, vendorId)` before idempotency/workflow are touched.
- Vendor/Customer name collides with an existing one for the tenant → unique constraint violation surfaced as `409` (dedupe, not a race — see master-data module).

## Testing

- Unit: RBAC permission matrix (role × permission × tenant combinations); idempotency interceptor (replay, conflict, first-call-persists, stale-pending-reclaim cases); workflow state-transition table (which transitions are legal from which states, self-approval blocked); PO DTO validation (decimal-string amount, vendorId shape); `VendorsService`/`CustomersService` CRUD + tenant scoping.
- Integration (supertest, following the existing test pattern): full PO create → pending → a different approver approves → `PurchaseOrder` row exists flow; same-account self-approval → `403`; concurrent approve on one instance → exactly one succeeds; reject path leaves no `PurchaseOrder` row; PO create with an unknown or cross-tenant `vendorId` → `400`; cross-tenant isolation — tenant A cannot read, approve, or reject tenant B's `WorkflowInstance`, see tenant B's `PurchaseOrder`s, or reference tenant B's `Vendor`s/`Customer`s.

## Build order

Dependency-driven — each phase requires the one before it:

0. **`users`** — real per-user accounts, replaces `AuthService`'s env-credential check.
1. **`tenancy`** — `Tenant` entity, `tenant_id` everywhere, `AsyncLocalStorage` context, TypeORM subscriber.
2. **`rbac`** — `Role`/`Permission`/`UserRole`, `RbacGuard`, `@RequirePermission()`.
3. **`master-data`** — `Vendor`/`Customer` entities, tenant-scoped CRUD, RBAC-gated. Needs `rbac` (its routes are permission-gated) but nothing from `idempotency`/`workflow`, and must exist before `purchase-orders` so PO is built against a real `vendorId` FK from day one.
4. **`idempotency`** — `IdempotencyKey` entity, interceptor, decorator (generic, unit-tested standalone).
5. **`workflow`** — definitions/instances/approval steps (generic, unit-tested standalone via a fake handler).
6. **`purchase-orders`** — real module wiring 0–5 together: `PurchaseOrder` entity (`vendorId` FK into `master-data`), create/approve/reject/list flow, `po.create`/`po.approve`/`po.read` permissions seeded.
7. **Extraction-readiness audit** — confirm no cross-module repository access snuck in during 0–6; document per-module table ownership; note which module boundaries map to future service boundaries.

## Alternatives considered

| Capability | Chosen | Rejected alternatives |
|---|---|---|
| Multi-tenancy | Row-level, shared schema (`tenant_id` column) | Schema-per-tenant (ops overhead multiplies per tenant, premature at this scale); DB-per-tenant (far too heavy) |
| RBAC | Custom roles/permissions tables + Nest guard | CASL (more expressive than needed); Casbin (extra DSL/infra to own) |
| Idempotency | Postgres table (`idempotency_keys`) | Redis-backed (faster, but a new infra dependency the stack doesn't otherwise need) |
| Workflow | Table-driven state machine, in-app | XState / Temporal (workflow engine libraries — heavier than a config-driven approval chain needs) |
| Service boundaries | Module-boundary discipline now, no extraction yet | Extract services now (too large a scope change alongside the four capabilities); ignore extraction concerns entirely (makes a future split expensive) |

## Known limitations (deferred, tracked — not fixed in Phases 0–6)

Identified in a senior-level review of this design before Phase 6 locked in its e2e test. None of these block the current build order; all are cheap to fix now and expensive to retrofit once more business modules copy the patterns below.

- **One role per user** (`erp-plan-2-rbac.md` Task 1) — `User.roleId` is a single nullable column, not a join table. Real org charts get overlapping duties (a clerk who's also a backup approver) faster than a small company expects. Migration path when this bites: nullable `roleId` → a `UserRole` join table, additive, no data loss.
- **No document numbering** — `PurchaseOrder` (and every future business document) is UUID-only, no human-facing sequential number (`PO-2026-000123`). Fine for an API demo, not for a vendor email or a paper invoice match. Add a tenant-scoped sequence before this is used outside a demo.
- **Unbounded list endpoints** — `PurchaseOrdersService.findAll` has no pagination, and it's "the reference implementation to follow" per the Architecture section above — meaning every future module's `findAll` will copy the same unbounded pattern unless this is fixed once, here, first.
- **No generic audit trail** — every entity has `createdAt` only, no `updatedAt`/`updatedBy`, no change log outside `ApprovalStep`'s PO-specific record. "Who changed this vendor's payment terms and when" is a question a small-company ERP still gets asked.
- **Users/Roles have no deactivate path** — unlike master-data's `Vendor`/`Customer` (`active` flag), `User`/`Role` can only be hard-deleted. Since `PurchaseOrder.requestedBy`/`approvedBy` are raw id strings with no DB foreign key (by design, per module-boundary discipline), a hard-deleted user leaves orphaned references with nothing to resolve them against. Add `active`/deactivate to `User`/`Role` for the same reason master data has it.
