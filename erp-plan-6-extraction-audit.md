# ERP Phase 6: Extraction-Readiness Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm the module-boundary discipline held across Phases 0–5 (no module reached into another's repository directly), fix any violations found, and document which module boundaries map to which future microservice boundaries — so a later extraction is a mechanical "swap an injected call for an AMQP call," not a redesign.

**Architecture:** This phase produces no new runtime behavior — it's an audit + a doc. The "test" for each task is either a grep-based structural check or the existing test suite staying green after a fix.

**Tech Stack:** Grep/manual review, no new dependencies.

## Global Constraints

- Depends on all of **erp-plan-0-users.md** through **erp-plan-5-purchase-orders.md** being complete.
- No behavior changes unless a boundary violation is found — if Task 1 finds nothing to fix, Task 2 (documentation) still happens.

---

### Task 1: Grep audit for cross-module repository access

**Files:**
- No files created; investigates all of `app/src/{users,tenancy,rbac,idempotency,workflow,purchase-orders}/`.

**Interfaces:**
- N/A — this task is read-only investigation, its deliverable is either "no violations found" or a list of fixes made in Task 1b.

- [ ] **Step 1: Grep for `@InjectRepository` usages naming an entity outside the module's own domain**

Run from `app/`:
```bash
grep -rn "InjectRepository" src/users src/tenancy src/rbac src/idempotency src/workflow src/purchase-orders
```
Expected pattern: each module only injects repositories for entities it owns —
- `users/` → `User` only
- `rbac/` → `Role` only (never `User` directly — it goes through `UsersService`)
- `idempotency/` → `IdempotencyKey` only
- `workflow/` → `WorkflowInstance`, `ApprovalStep` only (never `Role`/`User` directly — goes through `RolesService`/`UsersService`)
- `purchase-orders/` → `PurchaseOrder` only (never `WorkflowInstance` directly — goes through `WorkflowService`)
- `tenancy/` → no repository injection at all (only the subscriber, which touches `DataSource.subscribers`, not a repository)

If everything matches this list, this step found no violations — record that and move to Step 2. If something doesn't match (e.g. `PurchaseOrdersService` importing `Repository<WorkflowInstance>` directly instead of going through `WorkflowService`), note the exact file:line for Task 1b.

- [ ] **Step 2: Grep for cross-module relative imports of services/entities**

```bash
grep -rn "from '\.\./\(users\|tenancy\|rbac\|idempotency\|workflow\|purchase-orders\)" src/users src/tenancy src/rbac src/idempotency src/workflow src/purchase-orders
```
Expected: only imports of a module's own exported surface — e.g. `purchase-orders/` may import `WorkflowService` from `../workflow/workflow.service` (that's the intended public interface) but must never import something like `../workflow/workflow-instance.repository` (an internal). Since none of the plans in Phases 0–5 created internal per-module repository wrapper files, check instead that every cross-module import targets a `*.service.ts`, `*.guard.ts`, `*.decorator.ts`, `*.interceptor.ts`, or `*.module.ts` file — never a raw entity or a `*.entity.ts` path reached from inside another feature module's service (entities living in `database/entities/` and being imported by multiple modules is fine and expected — the constraint is about not reaching into another *module's* internals, not about entity file location).

- [ ] **Step 3: Record findings**

If Steps 1–2 found violations, list them (file:line, what it does, what it should do instead) as the input to Task 2. If clean, state that explicitly — "no cross-module repository or internal-import violations found across users/tenancy/rbac/idempotency/workflow/purchase-orders" — this is itself a valid, useful audit result, not a failure to find something.

---

### Task 2 (conditional): Fix any violations found in Task 1

**Files:** Whatever Task 1 flagged.

**Interfaces:** Depends entirely on what's found — skip this task's steps entirely if Task 1 found nothing.

- [ ] **Step 1: For each violation, replace the direct access with the owning module's exported service**

Example shape (only if this exact case is found — do not invent a fix for a violation that doesn't exist): if `PurchaseOrdersService` were found injecting `Repository<WorkflowInstance>` directly instead of calling `WorkflowService.create`/`approve`, the fix is deleting that injection and routing the call through `WorkflowService` (which `PurchaseOrdersModule` already imports via `WorkflowModule`, per **erp-plan-5-purchase-orders.md** Task 5).

- [ ] **Step 2: Run the full test suite after each fix**

```bash
npm test
```
Expected: PASS — a boundary fix should never change behavior, only how a module reaches it (if behavior changes, the "violation" was actually load-bearing and needs a different fix, not a mechanical swap).

- [ ] **Step 3: Commit each fix separately**

```bash
git add <changed files>
git commit -m "refactor(<module>): route <access> through <OwningModule>Service instead of direct repository access"
```

---

### Task 3: Document module → future service boundary mapping

**Files:**
- Create: `erp-module-boundaries.md` (root, matching the location of `erp-platform-design.md` and the other `erp-plan-*.md` files)

**Interfaces:** N/A — documentation only.

- [ ] **Step 1: Write the document**

```markdown
# ERP Module Boundaries → Future Service Boundaries

Status as of the extraction-readiness audit (Phase 6). This documents which
in-process module boundaries built in Phases 0–5 are designed to become
service boundaries later, and what the mechanical swap looks like for each.

## Current state: modular monolith

All six modules (`users`, `tenancy`, `rbac`, `idempotency`, `workflow`,
`purchase-orders`) run in one Nest process, one deployable. Cross-module
calls are plain injected service calls (e.g. `PurchaseOrdersService` calling
`WorkflowService.create()` in-process).

## What extraction would look like, per module

- **`tenancy`** — stays in every service. `TenantContext` and the JWT
  `tenantId` claim are cross-cutting; there's no "tenancy service" to
  extract, this logic gets copied into whatever process boundary exists,
  the same way auth middleware does in most microservice fleets.

- **`users` / `rbac`** — natural first extraction candidate: an "identity
  service" owning `users`, `roles` tables and exposing `findById`,
  `validatePassword`, `hasPermission` over the network instead of in-process.
  Every other module already calls these through `UsersService`/`RolesService`
  interfaces (confirmed clean in Task 1's audit), so extraction is: stand up
  the service, replace the injected class with an HTTP/gRPC client
  implementing the same method signatures, no caller-side logic changes.

- **`idempotency`** — could extract to a shared service if multiple future
  services need idempotency keys, but as a single Postgres table behind one
  interceptor, there's little pressure to split it out before there's a
  second consumer of it.

- **`workflow`** — extracts cleanly *if* the handler registry becomes a
  problem (in-process handler registration doesn't work across a network
  boundary). The swap: `WorkflowService.approve()`'s final step — invoking
  `registration.handler(...)` in-process — becomes publishing an
  `workflow.instance.approved` event on the existing RabbitMQ exchange
  (`queue.service.ts`'s pattern) instead of a direct function call, and
  `purchase-orders` becomes a consumer (`queue.consumer.ts`'s pattern) that
  performs its own write on receipt, using the existing `processed_events`
  idempotent-consumer table to dedupe redelivery. This is the same
  transactional-outbox gap already documented in `TasksService.create` — the
  workflow instance write and the event publish aren't atomic, so extracting
  `workflow` for real should pair with actually building that outbox, not
  before.

- **`purchase-orders`** (and any future business module) — extracts as its
  own deployable owning the `purchase_orders` table, calling the identity
  service for permission checks and consuming workflow-approval events
  instead of registering an in-process handler.

## What this buys us now, before any extraction happens

- Every module's public surface is already a service class with an explicit
  method signature — no controller or service anywhere reaches into another
  module's repository (verified in Task 1).
- Nothing depends on Nest's dependency injection working in-process — a
  service class swapped for an HTTP client with the same method names is a
  drop-in replacement everywhere it's currently injected.
- `tenant_id`/`Idempotency-Key`/permission-string conventions are already
  request-boundary concepts, not database-boundary ones, so they carry over
  to a network boundary unchanged.
```

- [ ] **Step 2: Commit**

```bash
git add erp-module-boundaries.md
git commit -m "docs: document module-to-future-service boundary mapping"
```

---

## Definition of Done

- Grep audit complete, findings recorded (clean, or violations found and fixed with passing tests after each fix).
- `erp-module-boundaries.md` written, giving a concrete extraction path per module rather than a vague "could be split later."
- `npm run build` and `npm test` pass in `app/`.
- All six ERP platform plans (Phases 0–5) are now complete and this audit confirms they were built to the module-boundary discipline the design called for.
