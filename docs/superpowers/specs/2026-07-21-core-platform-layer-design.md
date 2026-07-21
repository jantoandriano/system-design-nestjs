# Core Platform Layer — Master Data + Inter-Module Comms Design

Date: 2026-07-21
Status: Implemented as a plan — see `erp-plan-3-master-data.md`. `erp-platform-design.md` and `erp-plan-6-purchase-orders.md` (renamed from `erp-plan-5-purchase-orders.md` to make room for this phase) have been updated to match; `erp-plan-4-idempotency.md`/`erp-plan-5-workflow.md`/`erp-plan-7-extraction-audit.md` renamed and renumbered accordingly.

## Goal

Before any further ERP business modules are built, harden the core platform layer so it's genuinely reusable across future modules — not just proven once by Purchase Orders. Two gaps identified in `erp-platform-design.md`'s original plan:

1. **No master data ownership.** `PurchaseOrder.vendorName` was designed as a raw string, not a reference to a real `Vendor` record — meaning there is no canonical, tenant-scoped source of truth for vendors/customers that future modules (invoicing, inventory) could share.
2. **No concrete inter-module communication rule.** The original design states the boundary discipline ("no module reaches into another module's repository directly") but doesn't say which mechanism modules actually use to talk to each other — direct calls vs an event bus vs the existing queue.

This spec resolves both, and inserts the result into the existing build order from `erp-platform-design.md` rather than replacing it.

## Current state (relevant facts)

- `erp-platform-design.md` (approved) already plans: `users` → `tenancy` → `rbac` → `idempotency` → `workflow` → `purchase-orders` → extraction-readiness audit.
- `PurchaseOrder` entity as originally specified: `vendorName` is a plain string column, not a foreign reference — no `Vendor` table exists anywhere in the codebase.
- RabbitMQ (`app/src/queue/queue.service.ts`, `queue.consumer.ts`) already exists but is narrow: one producer (`TasksService.create`), one consumer, best-effort async publish, idempotent via `processed_events` table, DLQ on parse failure. It is not a general-purpose bus today.
- Module boundary discipline is already stated as a principle in `erp-platform-design.md` ("an in-process call becomes an AMQP call... via queue.service.ts/queue.consumer.ts") but has no concrete second example besides the Task flow.

## Decisions

### 1. Master data: new `master-data` module (Vendor + Customer)

One module, two tenant-scoped entities:

```
Vendor:   id (uuid), tenant_id, name, contactEmail, active, createdAt
Customer: id (uuid), tenant_id, name, contactEmail, active, createdAt
```

Two exported services, `VendorsService` and `CustomersService`, both from `MasterDataModule`. Kept as one module now (YAGNI — no reason to split infra for two near-identical entities yet) but two separate services (not a shared "Party" abstraction) — Vendor management and CRM/Customer are different bounded contexts long-term, and this keeps a future split between them cheap without designing for it prematurely.

CRUD surface follows the existing `TasksService` pattern: write via `default` connection, read via `replica`. Gated by RBAC permissions `masterdata.vendor.create`/`masterdata.vendor.read` and the customer equivalents — requires `rbac` (phase 2) to exist first. These permissions get seeded onto the existing `admin`/requester role, same as `po.*` — which requires the seed script's role-upsert to actually apply permission-list changes to an *already-created* role, not just at first creation (a real gap fixed alongside this: see `erp-plan-2-rbac.md`'s `ensureRole`).

Both entities are unique on `(tenantId, name)` — plain CRUD retries or fat-fingered double-submits produce a `409` from the constraint, not a duplicate vendor record. Real ERP pain otherwise: duplicate vendor rows silently break payment/invoice matching downstream. No `@Idempotent()`/`Idempotency-Key` protection on `POST /vendors`/`POST /customers` — that machinery exists for *financial* writes (Phase 4's docstring is explicit about this); master-data create isn't one, and the unique constraint already does the dedupe job idempotency keys would otherwise be repurposed for.

`Customer` has no consumer yet (no invoicing module exists). It's included now anyway because it's cheap, low-risk reference data to seed early and expensive to retrofit as a sibling of `Vendor` later once PO's pattern is copied for invoicing.

**Cross-module reference rule:** `PurchaseOrder.vendorId` is a plain `uuid` column, not a TypeORM `@ManyToOne` relation into `Vendor`. `PurchaseOrdersService` validates it by calling the injected `VendorsService.findById(tenantId, vendorId)` — **tenant-scoped in the call itself**, not a bare `findById(id)` — never by joining tables across module lines. Filtering by `tenantId` at the query is layer 1 of tenant isolation, matching every other tenant-scoped read in this codebase; `TenantScopedSubscriber` (Phase 1) remains layer 2, catching anything that slips through. Relying on the subscriber alone (an unscoped `findById(id)`, tenant check only on `afterLoad`) would still work today but breaks the two-layers-by-default pattern the rest of the platform holds to, so the signature takes `tenantId` explicitly. This is the concrete enforcement of the existing "no module reaches into another module's repository directly" rule — it also means the reference already looks like what an HTTP/AMQP call to a separated Vendor service would look like, if this is ever extracted.

### 2. Inter-module comms: hybrid, not a single mechanism

- **Sync, same-request logic → direct injected service calls.** RBAC checks, idempotency checks, workflow handler invocation on approval, `PurchaseOrdersService → VendorsService` validation. The caller needs an immediate result or exception; routing these through a queue adds latency and eventual-consistency bugs for no benefit. Matches the existing `AuthModule → UsersModule` pattern.
- **Async, cross-module side effects that don't block the request → reuse the existing RabbitMQ producer/consumer pattern.** e.g. a future `PurchaseOrderApproved` event notifying an inventory module to decrement stock, or a notification module to email the vendor. Same shape as the current Task-created flow: best-effort publish, idempotent consume via `processed_events`, DLQ on unparseable payloads.
- **Rejected: a new in-process event bus (e.g. `@nestjs/event-emitter`).** Would be a second, parallel mechanism alongside RabbitMQ for the same class of problem (cross-module notification), with no corresponding future-extraction story RabbitMQ doesn't already provide. Not worth owning two abstractions that solve the same job.
- **Rejected: routing everything (including sync in-request checks) through RabbitMQ.** Most "microservice-ready" on paper, but adds unnecessary latency/complexity to permission and idempotency checks that must return synchronously within the same request, and is heavier than a small-company MVP needs today.

### 3. Auth/permissions as a shared service — confirmed, no change

Already the existing phase-0/phase-2 design: `UsersService` exported from `UsersModule`, `RbacGuard`/`@RequirePermission()` exported from `RbacModule`. `master-data` becomes the first consumer of this pattern beyond `AuthModule` itself, which is useful validation that "shared service, not reimplemented per-module" actually generalizes past a single example.

## Updated build order

```
0 users            — real accounts, replaces env-credential auth
1 tenancy           — tenant_id everywhere, AsyncLocalStorage context, subscriber
2 rbac               — Role/Permission/UserRole, RbacGuard, @RequirePermission()
3 master-data         — Vendor, Customer (NEW — inserted here)
4 idempotency          — IdempotencyKey entity, interceptor, decorator
5 workflow              — WorkflowInstance/ApprovalStep, handler registry
6 purchase-orders        — PurchaseOrder with vendorId FK → master-data, full flow
7 extraction-readiness audit
```

Placement rationale: `master-data` needs `rbac` to exist (its CRUD routes are permission-gated) but has no dependency on `idempotency` or `workflow` internals, so it sits immediately after `rbac` and before those two — and, critically, before `purchase-orders`, so PO is built against a real `vendorId` FK from day one rather than a string that gets retrofitted later.

## Error handling (additions to existing plan)

- PO create with unknown **or cross-tenant** `vendorId` → `400`, validated via `VendorsService.findById(tenantId, vendorId)` before idempotency/workflow are touched (same validation-order spot as the existing amount/currency checks) — a cross-tenant id is rejected the same way an unknown one is, since the tenant-scoped query finds nothing either way.
- Master-data CRUD permission failure → `403`, same as any other `RbacGuard`-protected route.
- Duplicate vendor/customer name for the same tenant → `409` from the unique constraint, not a raw 500.
- Master-data entities are tenant-scoped → same subscriber-level defense-in-depth as `PurchaseOrder` (query filters by `tenantId` first; subscriber rejects a missing/mismatched tenant context as the second layer).

## Testing

- Unit: `VendorsService`/`CustomersService` CRUD + tenant-scoped `findById` (including the cross-tenant-returns-null case), mirroring the existing `UsersService.spec.ts` pattern (mocked repo, `getRepositoryToken(Vendor, 'default')`).
- Integration: PO create rejects an unknown or cross-tenant `vendorId` with `400`; duplicate vendor/customer name rejected with `409`; cross-tenant isolation — tenant A cannot read or reference tenant B's vendors/customers.

## Alternatives considered

| Decision | Chosen | Rejected alternatives |
|---|---|---|
| Master data entities | Vendor + Customer now, in one module w/ two services | Vendor only (defers Customer, risks re-doing the pattern for invoicing later); Vendor+Customer+Product (Product has no consumer at all yet, purely speculative) |
| Master-data build-order placement | After `rbac`, before `purchase-orders` | Right after `tenancy` (defers RBAC wiring, no real benefit since CRUD still needs rbac before it ships); parallel workstream with idempotency/workflow (no shared dependency to justify the coordination overhead at this team size) |
| Inter-module comms | Hybrid — direct calls (sync) + existing RabbitMQ (async) | New in-process event emitter (a second mechanism solving a problem RabbitMQ already solves); RabbitMQ for all comms including sync checks (unneeded latency/complexity for an MVP) |

## Definition of Done

- `master-data` module exists with `Vendor`/`Customer` entities, tenant-scoped, unique on `(tenantId, name)`, RBAC-gated CRUD, unit-tested — done, `erp-plan-3-master-data.md`.
- `VendorsService.findById(tenantId, id)` is tenant-scoped in the query itself, not relying solely on the subscriber — done, Task 2 of that plan.
- `PurchaseOrder.vendorId` is a validated FK (via service call, not ORM relation) into `master-data`, not a free-text string — done, `erp-plan-6-purchase-orders.md` (entity, DTO, service, and e2e test all updated).
- Build order in `erp-platform-design.md`'s "Build order" section updated to insert `master-data` as phase 3, with `idempotency`/`workflow`/`purchase-orders`/audit renumbered 4/5/6/7 and their files renamed to match — done.
- `admin` role's seed permissions extended with `masterdata.*`, and `ensureRole` fixed to upsert (not create-once) so this actually applies to an already-seeded database — done, `erp-plan-2-rbac.md` + `erp-plan-3-master-data.md` Task 5.
- No new inter-module communication mechanism introduced beyond direct calls (sync) and the existing RabbitMQ producer/consumer (async).
