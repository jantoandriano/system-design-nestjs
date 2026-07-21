# Phase 0 (erp-plan-0-users.md) — Status: COMPLETE

Session date: 2026-07-21. Branch: `main` (user chose "directly on main", no feature branch/worktree).

## What shipped

All 5 tasks from `erp-plan-0-users.md` implemented via `superpowers:subagent-driven-development` (fresh implementer subagent + task-reviewer per task, final whole-branch review at the end).

1. **Users entity + migration** — `app/src/database/entities/user.entity.ts` (uuid id, unique username, passwordHash, createdAt). Added to `ENTITIES` in `database.module.ts` and `data-source.ts`. Migration `app/src/database/migrations/1784100000000-CreateUsers.ts` — **hand-written** (no live DB in this session to run `migration:generate`), uses TypeORM's `QueryRunner.createTable`/`Table` API rather than raw SQL to avoid guessing constraint-name hashes. Functionally equivalent to a generated migration; constraint/index names will differ from TypeORM's auto-hash naming (accepted Minor caveat).
2. **UsersService** — `app/src/users/users.service.ts` + spec. `create()`, `findByUsername()`, `validatePassword(user: User | null, password)` using `@InjectRepository(User, 'default')`, bcryptjs, `SALT_ROUNDS = 10`.
3. **UsersModule** — wraps with `TypeOrmModule.forFeature([User], 'default')`, exports `UsersService`. Wired into `app.module.ts`.
4. **AuthService rewrite** — `app/src/auth/auth.service.ts` now looks up real users via `UsersService` instead of env-based single credential. `auth.module.ts` imports `UsersModule`.
5. **Admin seed script** — `app/src/database/seed-admin.ts`, idempotent (skips if username exists), reads `ADMIN_USERNAME`/`ADMIN_PASSWORD` from env (throws if missing), mirrors `run-migrations.ts`'s standalone-`DataSource` pattern. `npm run seed:admin` added to `app/package.json`. Env vars documented in `.env.example`.

## Notable fix during review: timing side-channel

Task 4's reviewer flagged (Important, **plan-mandated** — the plan's own example code had this bug) that the original `login()`:
```ts
user != null && (await this.usersService.validatePassword(user, password))
```
short-circuits on unknown username, skipping bcrypt entirely — an attacker can time the difference between "unknown user" and "wrong password" responses. Per skill rule (plan-mandated findings are the human's call), asked the user via AskUserQuestion — **chose "Fix now"**.

Fix: `validatePassword` widened to accept `User | null`; on null it still runs a real `bcrypt.compare` against a hardcoded dummy hash (`$2b$10$BCW6AdDYjzrLtC.a9xiTy.tq0M99F5cm8KK.BWzKFR5OBm780hQNO`), so unknown-username and wrong-password paths take the same time. `AuthService.login` simplified to be unconditional (see final code in `app/src/auth/auth.service.ts`).

## Final whole-branch review (opus)

"Ready to merge? With fixes." One Important finding — `.env.example` cleanup removed old `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` but never documented the new `ADMIN_USERNAME`/`ADMIN_PASSWORD` required by `seed-admin.ts`. Fixed directly (commit `b4ec8be`). Minor/accepted notes: hand-written migration's constraint-naming caveat (above); `SALT_ROUNDS` duplicated between `UsersService` and `seed-admin.ts` (deliberate — seed script is standalone, doesn't share DI with the service).

## Side fix (not part of plan, user-approved)

`.vscode/settings.json` added — `eslint.workingDirectories: [{ directory: "app" }]`. Root cause: `eslint.config.js`'s `project: 'tsconfig.json'` resolves relative to invocation dir; CLI runs from `app/` (fine), VS Code's ESLint extension resolves from workspace root (`system-design-nestjs/`, no tsconfig there) → false "Cannot read file" parse errors in-editor only. Not a real lint failure, `npm run lint` from `app/` was always clean.

## Pending — needs user's local Docker

No Docker/Postgres reachable in that session (`docker compose ps` failed, DB CLI commands got `ECONNREFUSED`). Two things never actually run against a real DB:

1. `npm run migration:run` (from `app/`) — apply `1784100000000-CreateUsers.ts` for real, confirm it executes cleanly against Postgres.
2. `npm run seed:admin` — then manually verify login end-to-end per `erp-plan-0-users.md` Task 5 Steps 3-4 (curl `POST /auth/login` with `ADMIN_USERNAME`/`ADMIN_PASSWORD`, confirm JWT comes back and works against a protected route).

Do these once `docker compose up` is live, before trusting Phase 0 as fully verified.

## Process notes (for whoever runs the next phase)

- Used `superpowers:subagent-driven-development`: task-brief → implementer subagent → review-package → task-reviewer subagent → fix loop if needed → ledger update, per task; final opus-tier whole-branch review at the end.
- Progress ledger for that run: `.superpowers/sdd/progress.md` (git-ignored scratch — gone if `git clean -fdx` runs; this file is the durable summary instead).
- Model tiering used: haiku/sonnet for mechanical/integration tasks (per task complexity), opus for final whole-branch review only.
- Task 1 (entity/migration) was implemented directly by the controller, not a subagent, after 3 consecutive transient `529 Overloaded` API errors on dispatch — judgment call given the task was small/mechanical, documented in the ledger for the final reviewer's awareness.

## Next phase

`erp-plan-1-tenancy.md` — not started. Same execution approach (subagent-driven-development) expected; ask user before starting, and ask branch strategy again (previous choice was "directly on main" but that was this-session-specific, don't assume it carries forward silently).
