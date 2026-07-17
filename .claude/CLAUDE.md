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
npm run lint          # next lint
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

## Project layout

```
app/src/
  auth/         JWT login + guard
  database/     entities, migrations, data-source.ts (CLI-only), run-migrations.ts (used by compose `migrate` service)
  queue/        producer (queue.service.ts), consumer with DLQ + idempotency (queue.consumer.ts)
  tasks/        CRUD example wired through primary/replica/queue/auth — the reference implementation to follow for new resources
  health/       GET /health
  metrics/      GET /metrics (Prometheus format)
nginx/nginx.conf                  TLS + rate limiting + load balancing + /api split
grafana/provisioning/             datasource + dashboard, auto-loaded
.github/workflows/ci-cd.yml       lint/test/build -> npm audit -> image build+push -> deploy

client/
  app/
    login/        login form + Server Action (loginAction)
    tasks/        task list (Server Component) + create form + Server Action (createTaskAction)
    logout/       Server Action (logoutAction)
  lib/
    api.ts          server-only fetch helpers against INTERNAL_API_URL — never import from a client component
    session.ts       httpOnly session cookie helpers (get/set/clear)
```
