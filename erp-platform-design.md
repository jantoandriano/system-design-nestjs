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
- `idempotency/` — `IdempotencyKey` entity (tenant_id + key + request-body hash + cached response + status); `IdempotencyInterceptor`; `@Idempotent()` decorator.
- `workflow/` — `WorkflowInstance`, `ApprovalStep` tables (the state machine is the instance's `status` column and its legal transitions, not a separate `WorkflowDefinition` table — no admin UI exists to edit workflow definitions dynamically, so definitions are an in-process handler registry: `WorkflowService.registerHandler(type, handler)`). Generic — not aware of purchase orders specifically, just invokes whatever handler is registered for an instance's `type` on final approval.
- `purchase-orders/` — `PurchaseOrder` entity (`id`, `tenant_id`, `vendorName`, `amount`, `currency`, `status: approved | rejected`, `requestedBy`, `approvedBy`, `createdAt`, `approvedAt`). The real business module proving the other four work together. Registers a `purchase-order.create` handler with `workflow/` that performs the actual `PurchaseOrder` insert on final approval. Follows the existing write-repo/read-repo/publish pattern from `TasksService`.

## Request flow

Purchase order create → approval → committed.

1. `POST /purchase-orders` (body: `vendorName`, `amount`, `currency`) → `JwtAuthGuard` → `RbacGuard` (permission `po.create`) → `TenantContextInterceptor` binds `tenant_id` from the JWT claim into `AsyncLocalStorage` for the rest of the request.
2. `IdempotencyInterceptor` (via `@Idempotent()`) looks up the `Idempotency-Key` header + tenant + request-body hash in `idempotency_keys`.
   - Same key + same hash → return the cached response, no side effect (replay).
   - Same key + different hash → `409 Conflict`, no write.
   - New key → proceed.
3. Instead of writing the `PurchaseOrder` row directly, `PurchaseOrdersService` creates a `WorkflowInstance` (`status = pending`, `type = purchase-order.create`) holding the validated payload. The pending-instance response (id + status) is what gets cached under that idempotency key.
4. An approver calls `POST /workflow/instances/:id/approve` — authenticated (`JwtAuthGuard`), but the required permission (`po.approve`) is checked *inside* `WorkflowService`, not by a static `RbacGuard`/`@RequirePermission()` on the route: which permission is required depends on the instance's `type`, only known once the instance is loaded, so a route-level decorator can't express it. `WorkflowService` looks it up from what the type registered and checks it against the approver's role, same tenant-scoped role check `RbacGuard` does elsewhere. Each call records an `ApprovalStep`. The demo chain is single-step (one `po.approve` holder approves); the engine itself supports N-step chains for future modules. On the required approval, `WorkflowService` invokes the `purchase-order.create` handler, which inserts the `PurchaseOrder` row (`status = approved`, tenant-scoped) and marks the instance `completed`. `POST /workflow/instances/:id/reject` marks the instance `rejected`, no `PurchaseOrder` row is created.
5. `GET /purchase-orders` (permission `po.read`) reads from the replica, tenant-scoped, following `TasksService.findAll`'s read-repo pattern.
6. Tenant isolation is enforced twice: at the guard (early reject) and at a TypeORM subscriber on tenant-scoped entities (defense in depth — a guard bug alone can't leak cross-tenant data).

## Error handling

- Idempotency key reused with a different payload hash → `409`, no write performed.
- Missing or mismatched tenant context on a scoped entity → rejected at the subscriber level, not only the guard.
- Approve/reject called on a non-`pending` workflow instance → `409`.
- Permission check fails (wrong role, or the right role but wrong tenant) → `403`.
- `amount` not positive, or `currency`/`vendorName` missing → `400` (DTO validation), before idempotency/workflow are touched.

## Testing

- Unit: RBAC permission matrix (role × permission × tenant combinations); idempotency interceptor (replay, conflict, first-call-persists cases); workflow state-transition table (which transitions are legal from which states); PO DTO validation.
- Integration (supertest, following the existing test pattern): full PO create → pending → approve → `PurchaseOrder` row exists flow; reject path leaves no `PurchaseOrder` row; cross-tenant isolation — tenant A cannot read, approve, or reject tenant B's `WorkflowInstance` or see tenant B's `PurchaseOrder`s.

## Build order

Dependency-driven — each phase requires the one before it:

0. **`users`** — real per-user accounts, replaces `AuthService`'s env-credential check.
1. **`tenancy`** — `Tenant` entity, `tenant_id` everywhere, `AsyncLocalStorage` context, TypeORM subscriber.
2. **`rbac`** — `Role`/`Permission`/`UserRole`, `RbacGuard`, `@RequirePermission()`.
3. **`idempotency`** — `IdempotencyKey` entity, interceptor, decorator (generic, unit-tested standalone).
4. **`workflow`** — definitions/instances/approval steps (generic, unit-tested standalone via a fake handler).
5. **`purchase-orders`** — real module wiring 0–4 together: `PurchaseOrder` entity, create/approve/reject/list flow, `po.create`/`po.approve`/`po.read` permissions seeded.
6. **Extraction-readiness audit** — confirm no cross-module repository access snuck in during 0–5; document per-module table ownership; note which module boundaries map to future service boundaries.

## Alternatives considered

| Capability | Chosen | Rejected alternatives |
|---|---|---|
| Multi-tenancy | Row-level, shared schema (`tenant_id` column) | Schema-per-tenant (ops overhead multiplies per tenant, premature at this scale); DB-per-tenant (far too heavy) |
| RBAC | Custom roles/permissions tables + Nest guard | CASL (more expressive than needed); Casbin (extra DSL/infra to own) |
| Idempotency | Postgres table (`idempotency_keys`) | Redis-backed (faster, but a new infra dependency the stack doesn't otherwise need) |
| Workflow | Table-driven state machine, in-app | XState / Temporal (workflow engine libraries — heavier than a config-driven approval chain needs) |
| Service boundaries | Module-boundary discipline now, no extraction yet | Extract services now (too large a scope change alongside the four capabilities); ignore extraction concerns entirely (makes a future split expensive) |
