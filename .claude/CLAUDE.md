# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A runnable NestJS scaffold demonstrating *System Design Interview* (Alex Xu) concepts with real production hardening: migrations, JWT auth, rate limiting, structured logging, a RabbitMQ dead-letter queue with idempotent consumers, TLS termination via nginx, DB connection pooling, and Prometheus/Grafana observability. Deliberately out of scope: secrets management and multi-host orchestration (see README "Where this still needs a real platform").

## Commands

All app commands run from `app/`:

```bash
npm run start:dev          # nest start --watch
npm run build               # nest build
npm run lint                 # eslint --fix
npm run format                # prettier --write
npm test                       # jest, all specs
npx jest path/to/file.spec.ts   # single test file
npx jest -t "test name"          # single test by name
```

Client commands run from `client/`:

```bash
npm run dev        # next dev
npm run build       # next build
npm run lint          # next lint (no eslint config committed yet — prompts interactively until one's added)
npm test              # vitest run
npm run test:watch     # vitest
```

Migrations (TypeORM, CLI-only connection defined in `src/database/data-source.ts`):

```bash
npm run migration:generate -- src/database/migrations/YourMigrationName   # after changing an entity
npm run migration:run
npm run migration:revert
```

`synchronize` is off on both DB connections — schema changes only ever come from reviewed migration files. In Docker, the `migrate` compose service runs them automatically before `app1`/`app2` start.

Full stack (nginx + 2 app instances + postgres primary/replica + pgbouncer + rabbitmq + prometheus + grafana):

```bash
cp .env.example .env
bash nginx/certs/generate-self-signed-cert.sh
docker compose up --build
```

Then hit the stack through nginx at `https://localhost` (self-signed cert), not directly against an app container — see README for the login/curl walkthrough.

## Architecture

```
Browser → nginx (TLS, rate limiting, LB :443)
              ├─► /            client (Next.js) ─► app1/app2 (internal, server-side only)
              └─► /api/*       app1 / app2 (NestJS)
                  /health                  ├─► pgbouncer-primary → postgres-primary  (writes)
                  /metrics                 ├─► pgbouncer-replica → postgres-replica  (reads)
                                            └─► rabbitmq (quorum queue + DLQ)
prometheus scrapes app1/app2 /metrics directly (not through nginx); grafana queries prometheus.
```

**The `/api` split lives entirely in nginx, not Nest.** `app/src/main.ts` has no `setGlobalPrefix()` — Nest's routes are still bare (`/auth/login`, `/tasks`, `/health`, `/metrics`). `nginx/nginx.conf`'s `location /api/` strips the prefix before proxying to `nestjs_backend`; `location /` proxies everything else to the `client` (Next.js) service. This was deliberate: a Nest-side global prefix would've also renamed `/health`/`/metrics`, which Prometheus scrapes directly against `app1:3000`/`app2:3000` — doing the split at the edge keeps that scrape path (and the Nest app itself) untouched.

**The web client (`client/`) never sees the raw JWT.** It's a Next.js App Router app, served same-origin at `/` (no CORS needed). Server Actions (`client/app/login/actions.ts`, `client/app/tasks/actions.ts`) call the Nest API server-side over the internal docker network (`INTERNAL_API_URL`, defaults to `http://nestjs-backend:3000` — a network alias shared by `app1`/`app2` in `docker-compose.yml` so server-side calls round-robin the same way nginx's upstream does), then store the resulting `accessToken` in an httpOnly, Secure, SameSite=Lax cookie (`client/lib/session.ts`). Client-side JS never touches the token. There's no refresh-token endpoint on the backend (1h JWT expiry, see `auth.module.ts`) — a 401 from the Nest API clears the cookie and redirects to `/login` rather than attempting a refresh.

**Two named TypeORM connections, everywhere.** `DatabaseModule` (`src/database/database.module.ts`) registers `'default'` (writes, → pgbouncer-primary) and `'replica'` (reads, → pgbouncer-replica) as separate `TypeOrmModule.forRootAsync` connections against the *same* entities. Any repository injection must specify which one: `@InjectRepository(Task, 'default')` vs `'replica'`. Migrations only ever run against `'default'`/primary — the replica's schema comes from Postgres streaming replication. When adding a new entity, add it to the `ENTITIES` array in `database.module.ts` (both connections use it) and generate a migration.

**Write path takes the DB write as the source of truth, not the queue.** In `TasksService.create` (`src/tasks/tasks.service.ts`), the row is saved to the primary first; the queue publish is best-effort afterward (`QueueService.publishTaskCreated` has a 2s timeout) and a publish failure is logged, not thrown — a broker outage degrades the async side effect, not the write itself. The known gap (event silently dropped on that failure) and the fix (transactional outbox) are documented in a comment there; don't "fix" this by making publish failures throw without reading that comment first.

**Queue consumer implements at-least-once + idempotent processing by hand** (`src/queue/queue.consumer.ts`): a quorum queue with `x-delivery-limit` lets RabbitMQ itself count redelivery attempts and auto-dead-letter after `MAX_DELIVERY_ATTEMPTS` (`src/queue/queue.constants.ts`) — no app-side retry counter. Before doing the real side effect, it checks the `processed_events` table for the event ID; a hit means a safe no-op ack, since redelivery after a crash between "did the work" and "acked" is expected, not exceptional. Unparseable payloads are nacked straight to the DLQ (`nack(msg, false, false)`) since retrying won't fix a parse error; processing errors are nacked with requeue (`nack(msg, false, true)`) so the delivery-limit mechanism handles retry/dead-lettering.

**Auth is a single demo credential, not a users table**: `AuthService` checks env-provided `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` (bcrypt), issues a JWT via `@nestjs/jwt`, and `JwtAuthGuard` protects `POST /tasks`. `GET /tasks` (reads) is unauthenticated. If this grows real accounts, `AuthService.login` is the one place to replace with a per-user lookup.

**Rate limiting is defense-in-depth, two layers**: nginx `limit_req` at the edge (`nginx/nginx.conf`), and `@nestjs/throttler` as a global `APP_GUARD` in `app.module.ts` (catches anything reaching an app container directly; per-route overrides can be stricter, see `AuthController`).

**Logging is structured via `nestjs-pino`**, JSON lines in production (`NODE_ENV=production` drops the `pino-pretty` transport), with `req.headers.authorization` redacted. `INSTANCE_NAME` env var tags which container (`app1`/`app2`) emitted a log line.

**Graceful shutdown matters here**: `app.enableShutdownHooks()` in `main.ts` lets `onModuleDestroy`/`beforeApplicationShutdown` run on SIGTERM (what Docker/K8s send before killing a container) — e.g. `QueueConsumerService.onModuleDestroy` closes the AMQP connection cleanly instead of dropping in-flight acks.

## Frontend (client/)

The conventions below are also written up as a skill at `.claude/skills/SKILL.md` (+ `.claude/skills/skill-*.md` references) — read those for copy-adaptable patterns; this section says what's actually true of this codebase today.

**`app/` is routing only; feature code lives in `src/features/<name>/`.** Route segment files (`page.tsx`, `layout.tsx`) stay thin and import from the matching feature — e.g. `app/tasks/page.tsx` is a Server Component that calls `fetchTasks()` and `getSessionToken()` directly, then renders `<TaskList>`/`<CreateTaskForm>` from `src/features/tasks/components/`. `app/providers.tsx` (the `QueryClientProvider` wrapper) is the one exception that stays in `app/` per Next.js convention. `@/*` resolves to `src/*` (`tsconfig.json`), so shared code goes in `src/lib/` (`utils.ts` for `cn()`, `session.ts` for the httpOnly cookie helpers) and `src/components/ui/` (shadcn-generated).

**Each feature owns `schemas.ts` (Zod), `api.ts` (fetch wrappers + error classes), `actions.ts` (Server Actions), and for `tasks` also `query-keys.ts` + `hooks/`.** Types are inferred from Zod schemas, not hand-written — `taskSchema`/`Task` in `src/features/tasks/schemas.ts` is the pattern to copy for a new feature. Error classes (`UnauthorizedError`, `InvalidCredentialsError`) live next to the `api.ts` that throws them and stay feature-local unless a second feature needs them.

**Two different mutation patterns, picked per form's needs, not uniformly:** `LoginForm` is a plain `<form action={loginAction}>` + `useActionState` — no client cache to update, so no TanStack Query involved. `CreateTaskForm` goes through `useCreateTask()` (`useMutation` wrapping the `createTaskAction` Server Action as `mutationFn`), because it needs to invalidate the `tasks` query on success. `TaskList` reads via `useTasks(initialTasks)`, a `useQuery` seeded with the Server Component's fetch as `initialData` (no hydration boundary needed for a single query — see `references/nextjs-app-router.md` in the skill for when Pattern B, prefetch+hydrate, would be worth the extra ceremony instead).

**shadcn/ui here is the Base UI flavor, not Radix** (`components.json` → `"style": "base-nova"`, primitives import from `@base-ui/react/*`). `src/components/ui/button.tsx` and `input.tsx` use Base UI primitives; `label.tsx` and the hand-written `form.tsx` are plain elements + `@radix-ui/react-slot` (a standalone primitive, not part of Radix's component set) — don't assume a `@radix-ui/react-*` component package is available when extending `components/ui/`, check what's actually installed first. `npx shadcn@latest add <name>` may return an empty registry item for some components in this style (happened for `form`) — if so, hand-write from the canonical shadcn source rather than assuming the component doesn't exist.

**Tests are colocated** (`Component.tsx` + `Component.test.tsx` in the same folder), run via Vitest + React Testing Library (`vitest.config.ts`, `vitest.setup.ts`). Mock at the `api.ts`/`actions.ts` boundary (`vi.mock('../actions')`), not TanStack Query internals; wrap components that use query hooks with `renderWithQueryClient` from `src/test/utils.tsx`.

## Project layout

```
app/src/
  auth/         JWT login + guard
  database/     entities, migrations, data-source.ts (CLI-only), run-migrations.ts (used by compose `migrate` service)
  queue/        producer (queue.service.ts), consumer with DLQ + idempotency (queue.consumer.ts)
  tasks/        CRUD example wired through primary/replica/queue/auth — the reference implementation to follow for new resources
  health/       GET /health
  metrics/      GET /metrics (Prometheus format)
client/
  app/                             routes only (page/layout/providers), thin
  src/
    features/{auth,tasks}/         schemas.ts, api.ts, actions.ts, (tasks only) query-keys.ts, hooks/, components/
    components/ui/                 shadcn-generated (Base UI flavor, see Frontend section)
    lib/                           cn(), session cookie helpers
    test/                          shared test utils (renderWithQueryClient)
nginx/nginx.conf                  TLS + rate limiting + load balancing + /api split
grafana/provisioning/             datasource + dashboard, auto-loaded
.github/workflows/ci-cd.yml       lint/test/build -> npm audit -> image build+push -> deploy
```
