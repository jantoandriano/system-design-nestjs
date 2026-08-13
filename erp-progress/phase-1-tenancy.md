# Phase 1 (erp-plan-1-tenancy.md) — Status: COMPLETE

Session date: 2026-08-13. Branch: `main` (user chose "direct on main" again, no feature branch/worktree — same as Phase 0, confirmed explicitly this session rather than assumed).

## What shipped

All 6 tasks implemented via `superpowers:subagent-driven-development` (fresh implementer subagent + task-reviewer per task, final opus-tier whole-branch review at the end).

1. **`Tenant` entity + migration with backfill** — `app/src/database/entities/tenant.entity.ts` (uuid id, unique name, createdAt). `User.tenantId` column added. Migration `app/src/database/migrations/1784200000000-CreateTenantsAndScopeUsers.ts` — **hand-written** (no Docker/Postgres reachable this session, same as Phase 0), follows the existing Table-API style of `1784100000000-CreateUsers.ts`. Backfill sequencing: create table → seed `'default'` tenant row → add `tenantId` nullable → `UPDATE` backfill → tighten to NOT NULL → add FK. `down()` reverses in correct order.
2. **`TenantContext`** — `app/src/tenancy/tenant-context.ts`, AsyncLocalStorage wrapper: `run()`, `getTenantId()` (throws outside context), `tryGetTenantId()` (returns undefined outside context, used by the subscriber so unauthenticated routes aren't affected).
3. **JWT payload carries `tenantId`** — `JwtPayload`, `JwtStrategy.validate()`, `AuthService.login()` all updated. Implementer caught that the plan's own example code for `AuthService.login()` would have reintroduced the timing-attack bug fixed in `423a11a` (short-circuits `validatePassword` on unknown username) — deviated from the literal snippet, kept the existing unconditional `validatePassword` call, only added `tenantId` to the payload. Verified correct by task reviewer via direct file read.
4. **`TenantScopedSubscriber`** — `app/src/tenancy/tenant-scoped.subscriber.ts`, TypeORM subscriber registered on both `default`/`replica` connections via constructor push (not decorator-based auto-discovery — `@EventSubscriber()` was removed in the final fix wave as an inert, latent crash trap; see below). Throws `ForbiddenException` on cross-tenant load only when a context is bound and the entity has a mismatched `tenantId`; no-ops otherwise.
5. **`TenantContextInterceptor` + `TenancyModule`** — global `APP_INTERCEPTOR` binding `TenantContext` from `req.user.tenantId`, no-op pass-through when absent. Highest-risk task (affects every route). The reviewer independently verified — by driving real `@nestjs/core` interceptor-chaining internals against the actual interceptor with genuine async (`setTimeout`) boundaries — that `AsyncLocalStorage` context correctly survives into async route-handler execution, not just the synchronous test path. Confirmed no cross-request leakage.
6. **Seed script updated** — `seed-admin.ts` now finds-or-creates a tenant (`ADMIN_TENANT_NAME`, default `'default'`, matching the migration's hardcoded default) before creating the admin user, assigns `tenantId`.

## Final whole-branch review (opus) — findings and fix wave

"Ready to merge? With fixes." No Critical findings. The reviewer traced the never-run migration's TypeORM API calls to their actual emitted SQL (via `node_modules/typeorm` source) to gain confidence despite zero execution evidence, and independently re-verified the ALS-propagation claim from Task 5's review with its own repro against real Nest internals.

Four Important findings, all fixed in one fix wave (commits `ceab7b2`, `30642ac`, `796243e`, `ef5b6e9`), verified ADDRESSED by a scoped re-review with no new breakage:

1. **`JwtStrategy.validate()` failed open on a JWT with no `tenantId` claim** — a state the plan never considered ("authenticated but unbound"). Any pre-Phase-1 JWT (1h expiry) would authenticate successfully with tenant context silently unbound. Fixed: throws `UnauthorizedException('Token is missing a tenant claim')` when `payload.tenantId` is falsy.
2. **`UsersService.create()` couldn't express a tenant** — signature had no way to carry `tenantId`, so a future caller wouldn't get a compile-time nudge, only a runtime NOT NULL violation. Fixed: signature is now `create(tenantId, username, password)`. (This method remains unused by any controller — no user-registration endpoint exists yet.)
3. **Global-unique `username` across all tenants is an undocumented one-way design decision** — `User.username` has a DB-level UNIQUE constraint with no tenant scoping, which is what makes `AuthService.login()`'s tenant-less lookup work today, but becomes expensive to change once a second tenant/account exists. **Asked the user** — chose "document, defer" over redesigning to per-tenant-unique + a login tenant selector. Documented in `erp-platform-design.md`'s Alternatives-considered table.
4. **Minor sweep**: removed the inert `@EventSubscriber()` decorator on `TenantScopedSubscriber` (verified safe — neither TypeORM connection has decorator-based subscriber auto-discovery enabled; was a latent crash trap if that ever changed) with an explanatory comment; restored an explanatory comment on `seed-admin.ts` that an earlier task's diff had deleted; documented `ADMIN_TENANT_NAME` in `.env.example`; added an invariant-preserving comment on `TenantContextInterceptor` explaining why the synchronous-callback binding pattern can't be simplified away.

## Pending — needs user's local Docker (same situation as Phase 0)

No Docker/Postgres reachable all session. Never actually run against a real DB:

1. `npm run migration:run` (from `app/`) — apply `1784200000000-CreateTenantsAndScopeUsers.ts`. The reviewer traced its TypeORM API calls against `node_modules/typeorm`'s actual SQL-generation code and found it correct, but this is static analysis, not execution evidence.
2. `npm run migration:revert` then `npm run migration:run` again — exercises `down()`, which has the least static confidence of anything in this phase.
3. `ADMIN_USERNAME=... ADMIN_PASSWORD=... npm run seed:admin` — confirm tenant + admin user both get created (or found, if Phase 0's row already exists) correctly.
4. Manually verify: `curl -X POST /auth/login` with the admin credentials, decode the JWT, confirm `tenantId` is present in the payload.

Do these once `docker compose up` is live, before trusting Phase 1 as fully verified — mirrors Phase 0's unresolved pending item.

## Known, accepted gap (not fixed, documented as deliberate)

`username` is globally unique across all tenants, not per-tenant. Revisit only if a real requirement for duplicate usernames across different tenants emerges — would need a tenant selector added to the login flow and the unique constraint changed to `(tenantId, username)`. See `erp-platform-design.md`.

## Process notes (for whoever runs the next phase)

- Used `superpowers:subagent-driven-development` end to end: task-brief → implementer subagent → review-package → task-reviewer subagent (all 6 tasks reviewed clean, no fix loops needed at the per-task level) → final opus-tier whole-branch review → one fix wave → one scoped re-review (all addressed, no new breakage) → workspace deleted.
- Model tiering: haiku for pure-transcription TDD tasks (2, 6), sonnet for tasks touching existing files/integration concerns (1, 3, 4, 5) and all task reviews, opus for the final whole-branch review and the fix-wave dispatch review context.
- The Task 3 and Task 5 reviewers both did notably deep verification beyond just reading the diff: Task 3's reviewer read the full `auth.service.ts` to confirm a security fix wasn't regressed; Task 5's reviewer and the final reviewer both built empirical repros against real `@nestjs/core`/`typeorm` internals rather than trusting the plan's assumptions about framework behavior. This caught nothing wrong in either case, but the verification standard is worth preserving in future phases given how much of this plan depends on framework internals (ALS + RxJS interceptor chaining, TypeORM subscriber auto-discovery, migration SQL generation).
- Progress ledger for this run: `.superpowers/sdd/erp-plan-1-tenancy/progress.md` — deleted per the skill's finish step now that git history + this file are the durable record.

## Next phase

`erp-plan-2-rbac.md` — not started. Depends on this phase (`Role`/`Permission`/`UserRole` are tenant-scoped, need `Tenant`/`tenantId`/`TenantContext` from this phase). Ask user before starting, and ask branch strategy again — don't assume "direct to main" carries forward silently (per Phase 0's own note, still true).
