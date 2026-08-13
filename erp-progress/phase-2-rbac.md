# Phase 2 (erp-plan-2-rbac.md) — Status: COMPLETE

Session date: 2026-08-13 (same session as Phase 1). Branch: `main` (user confirmed "direct on main" again, asked explicitly per Phase 1's own note not to assume it carries forward).

## What shipped

All 5 tasks implemented via `superpowers:subagent-driven-development` (fresh implementer subagent + task-reviewer per task, final opus-tier whole-branch review at the end).

1. **`Role` entity + `roleId` on `User` + migration** — `app/src/database/entities/role.entity.ts` (uuid id, tenantId, name, flat `permissions: string[]` via `simple-array`, createdAt). `User.roleId: string | null` (nullable, no backfill needed). Migration `app/src/database/migrations/1784300000000-CreateRoles.ts` — hand-written (no Docker/Postgres reachable this session, same as every prior phase). **Fix round 1**: task reviewer flagged missing FK constraints on `roles.tenantId → tenants.id` and `users.roleId → roles.id` — the brief's example code omitted them, judged a genuine referential-integrity gap (not a clean YAGNI call, and inconsistent with Phase 1's own FK precedent) rather than plan-mandated; fixed to match Phase 1's `TableForeignKey` style exactly.
2. **`RolesService`** — `app/src/rbac/roles.service.ts`: `create(tenantId, name, permissions)`, `findById(id)`, `hasPermission(role, permission)`.
3. **`@RequirePermission()` decorator + `RbacGuard`** — `app/src/rbac/require-permission.decorator.ts`, `app/src/rbac/rbac.guard.ts`. Guard checks: no-permission-required passthrough, no-role 403, tenant-mismatch 403 (role's tenantId vs caller's), missing-permission 403, has-permission allow. Small addition to Phase 0's `UsersService`: `findById(id)`.
4. **`RbacModule`** — wires `RolesService`+`RbacGuard` together, imports `UsersModule`. **Not** registered globally (unlike Phase 1's interceptor) — exported for future phases (workflow, purchase-orders) to apply per-route via `@UseGuards(RbacGuard)` + `@RequirePermission(...)`.
5. **Seed script → two demo accounts** — `seed-admin.ts` now creates two tenant-scoped roles (`admin`: `po.create`+`po.read`; `approver`: `po.approve`+`po.read`) and two accounts, replacing Phase 1's single-admin seed. Upsert-style (`ensureRole` corrects stale permissions on re-run, not just create-if-missing). Two accounts exist because a later phase blocks self-approval — one account holding both create and approve permissions could never approve its own request.

## Final whole-branch review (opus) — a real Critical bug, caught before merge

"Ready to merge? With fixes — one blocking." This is the first phase where the final review found a genuine Critical defect, not just design-judgment findings:

**Critical**: `User.roleId: string | null` (written verbatim from the plan's own Task 1 example code) reflects to TypeScript's `design:type = Object` under this project's `strictNullChecks`, which TypeORM's Postgres driver cannot map — `DataSource.initialize()` throws `DataTypeNotSupportedError` on **every** boot, migration command, and the seed script. The reviewer didn't just theorize this — they built the actual entity set against a `DataSource` and reproduced the exact failure. Root cause: the plan's own example code, not an implementer deviation — every per-task reviewer (correctly) matched implementation to plan and passed it. The build+test gate structurally could not catch it, since every spec in this repo mocks its repository and never triggers real TypeORM metadata building. This is the first *concrete* failure produced by the "no Docker/Postgres reachable all session" gap that's been a theoretical risk carried across three phases — now demonstrated to be load-bearing.

Fixed in a fix wave (5 commits: `1fedeca`, `a5506da`, `3de6be1`, `f45e46a`, `56ebb45`), verified ADDRESSED by a scoped re-review that empirically confirmed the fix by reverting it, re-running the new regression test, watching it fail with the exact original error, then restoring and re-confirming green:

1. **[Critical]** `roleId` given explicit `type: 'uuid'`.
2. **[Important]** Same root-cause class: `Role.tenantId` and `User.tenantId` were bare `@Column() tenantId: string` (resolves to `character varying`) while both migrations create the column as `uuid` — harmless today (`synchronize: false`) but would have caused a destructive `ALTER COLUMN` the next time `migration:generate` runs (Phase 3's plan does exactly that). Both given explicit `@Column('uuid')`.
3. **[Important]** `.env.example` never documented `APPROVER_USERNAME`/`APPROVER_PASSWORD` — the seed script now hard-throws without them, so the documented `cp .env.example .env` → `npm run seed:admin` path was a guaranteed failure (the same class of gap Phase 0 hit and fixed for `ADMIN_TENANT_NAME`). Fixed.
4. **[Important]** `RbacGuard` threw a raw `TypeError` (500) instead of a clean rejection when applied to a route with no upstream auth guard — a likely mistake for whichever future phase wires this guard in first. Fixed: `ForbiddenException('Not authenticated')`, with a new test.
5. **[Recommended, applied]** Added `app/src/database/entities.spec.ts` — a DB-less smoke test that builds a real TypeORM `DataSource` over the actual `ENTITIES` array and asserts metadata construction succeeds, no live Postgres needed. This is the standing regression guard for the whole bug class that produced the Critical finding, and will catch the same defect in Phases 3-6 as more entities are added. The re-reviewer verified this test is not a stub — it genuinely fails without the fix and passes with it.
6. **[Minor]** Unique `(tenantId, name)` constraint added to `roles`, folded into the still-unrun migration.
7. **[Minor]** `PERMISSION_KEY` namespaced (`'permission'` → `'rbac:permission'`) to avoid future metadata-key collisions.

## Known, deferred items (not fixed, documented as deliberate or pre-existing)

- `RolesService.findById(id)` is a bare, cross-tenant-capable read — safe today only because `RbacGuard`'s explicit tenant check catches a mismatch; Phase 1's `TenantScopedSubscriber` can't help here because guards run *before* the tenant-context interceptor binds `TenantContext`. `erp-platform-design.md`'s Phase 3 section already specifies a tenant-scoped `findById(tenantId, id)` convention for `master-data`. **Decision needed before Phase 3**: should `rbac/` match that convention, or is it an intentional, documented exception? Not resolved this session.
- `ensureUser`'s username lookup in the seed script isn't tenant-scoped (pre-existing since Phase 0/1) — the final reviewer noted Phase 2 changes its blast radius (previously just skipped-and-logged on a collision, now *writes* `roleId` onto whatever user the unscoped lookup finds), but a correct fix requires changing `User.username`'s global unique index to composite `(tenantId, username)` — a schema decision genuinely outside this phase's scope, deferred alongside Phase 1's already-documented global-username trade-off.
- Minor: `!role` branch in `RbacGuard` shares its error message with the genuine tenant-mismatch case ("Role not valid for this tenant") — misleading when the role simply doesn't exist. Not fixed.
- Minor: `ensureUser` can't repair a wrong role assignment on re-run (skips any user with *any* existing `roleId`), asymmetric with `ensureRole`'s upsert behavior. Not fixed.
- `erp-platform-design.md` still has two spots (lines ~37, ~80) describing `rbac/` as `Role`/`Permission`/`UserRole` — stale prose superseded by the plan's flat-`permissions[]` model (the design doc's own trade-off table, line ~102, already reflects the real decision). Not fixed.

## Pending — needs user's local Docker (same situation as Phases 0-1)

No Docker/Postgres reachable all session. Never actually run against a real DB:

1. `npm run migration:run` — applies both `1784300000000-CreateRoles.ts` (now including the FK fix-round and the fix-wave's unique-constraint addition) and confirms the `roleId`/`tenantId` uuid-type entity fixes actually match what the migration created.
2. `ADMIN_USERNAME=... ADMIN_PASSWORD=... APPROVER_USERNAME=... APPROVER_PASSWORD=... npm run seed:admin` — confirm both roles and both accounts get created (or found/updated, if Phase 0/1's admin row already exists).
3. Manually verify both accounts can log in and their JWTs carry the expected `tenantId`.
4. `RbacGuard` has no real route to exercise yet (deferred to Phase 5/6 by design) — nothing to manually verify there this phase.

## Process notes (for whoever runs the next phase)

- Used `superpowers:subagent-driven-development` end to end, including its first fix loop at the per-task level (Task 1's missing FKs) and its first Critical finding at the final-review level (Task 1's `roleId` type bug) this multi-phase build has hit.
- **Environment issue worth knowing about**: `git commit` hung repeatedly and unpredictably throughout this phase (Tasks 3, 4 twice, 5, and the final fix wave) on SSH-agent-based commit signing. Diagnosed once, concretely, during the fix wave: `ps aux`/`tasklist` showed genuinely stuck `ssh-keygen.exe` processes (not just slow signing), confirmed by process age. User chose to kill the stuck processes and retry rather than switch tools or relax signing. Pattern observed repeatedly: a commit attempt that appears to time out at the tool level (even at 5 minutes) may have actually succeeded — always check `git log`/`git status` before assuming failure or retrying. If this recurs in a future phase, check for stuck `ssh-keygen.exe` processes early rather than only retrying with longer timeouts.
- When a dispatched implementer subagent stalls after staging changes but before committing/reporting (happened on Task 4 and the final fix wave), the controller independently verified the staged diff matched the brief/findings, re-ran build+test itself, completed the commit, and wrote the report file on the implementer's behalf — this is a mechanical completion of already-produced work, not a code fix, so it doesn't skip the review step that follows.
- Model tiering: haiku for pure-transcription TDD tasks (Task 2), sonnet for integration tasks (Tasks 1, 3, 4, 5) and most task reviews, haiku for two small/low-risk task reviews (Tasks 2 and 4), opus for the final whole-branch review.
- Progress ledger for this run: `.superpowers/sdd/erp-plan-2-rbac/progress.md` — deleted per the skill's finish step now that git history + this file are the durable record.

## Next phase

`erp-plan-3-master-data.md` — not started. Depends on this phase (`RbacGuard`/`@RequirePermission` gate its routes) and Phase 1 (tenant scoping). Ask user before starting, and ask branch strategy again — per both prior phases' own notes, don't assume "direct to main" carries forward silently. **Also resolve the `RolesService.findById` tenant-scoping convention question (above) before or during this phase**, since Phase 3's plan already commits to the opposite convention (`findById(tenantId, id)`) for its own services.
