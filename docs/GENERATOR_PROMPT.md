# Generator Prompt — System Design NestJS Demo

Feed this to an LLM coding agent (Claude Code, etc.) in a fresh, empty repo to
scaffold a project matching this one's architecture and hardening. Two parts:
a **system prompt** (persona + non-negotiable architecture rules) and a
**task checklist** (ordered build steps + acceptance checks). Paste both in
one go, or the system prompt once as standing context and the checklist as
the actual task.

---

## Part 1 — System Prompt

You are building a runnable full-stack scaffold that demonstrates *System
Design Interview* (Alex Xu) concepts with real production hardening — not a
toy demo. Every concept must be backed by working code, not a comment saying
"in production you'd add X."

**Stack (fixed, do not substitute):**
- Backend: NestJS 10 + TypeScript, TypeORM 0.3 against Postgres, class-validator
- Frontend: Next.js 15 (App Router) + React 19, TypeScript, Server Actions only
- DB: Postgres 16 (bitnamilegacy/postgresql image), primary + streaming-replication replica
- Pooling: PgBouncer (bitnamilegacy/pgbouncer), transaction pool mode, one instance per DB
- Queue: RabbitMQ 3 (management image), quorum queue + DLQ
- Edge: nginx (alpine), TLS termination + rate limiting + load balancing + reverse proxy
- Observability: Prometheus + Grafana, `@willsoto/nestjs-prometheus`
- Logging: `nestjs-pino`, JSON in prod, pretty in dev
- Auth: `@nestjs/jwt` + `passport-jwt`, bcrypt via `bcryptjs`
- Orchestration (local only): docker-compose, non-root multi-stage Dockerfiles
- CI: GitHub Actions — lint → test → build → `npm audit` → image build/push → deploy

**Non-negotiable architecture rules — apply these exactly, don't "simplify":**

1. **Two named TypeORM connections everywhere**, `'default'` (writes → pgbouncer-primary)
   and `'replica'` (reads → pgbouncer-replica), against the same entity set. Every
   repository injection must name one explicitly: `@InjectRepository(X, 'default')`.
   `synchronize: false` on both. Schema changes only via generated migrations, run
   against `'default'`/primary only — the replica's schema comes from Postgres
   streaming replication, never from a migration run against it.

2. **The `/api` path split lives in nginx, not Nest.** Nest's routes stay
   unprefixed (`/auth/login`, `/tasks`, `/health`, `/metrics` — no
   `app.setGlobalPrefix()`). nginx's `location /api/` strips the prefix before
   proxying to the app upstream; `location /health` and `location /metrics`
   proxy unprefixed (Prometheus scrapes app containers directly, not through
   nginx, so don't rename those paths app-side); `location /` proxies
   everything else to the frontend. This split is deliberate — don't move it
   into a Nest global prefix.

3. **The frontend never sees the raw JWT.** It's a server-rendered app (Next.js
   App Router) served same-origin behind the same nginx entrypoint (no CORS).
   All API calls that need the token happen in Server Actions / Server
   Components, calling the backend directly over the internal docker network
   (bypass nginx and TLS entirely for internal calls — they don't need to trust
   a self-signed cert). The resulting access token is stored in an httpOnly,
   Secure, SameSite=Lax cookie. Client-side JS never touches it. No refresh-token
   flow — a 401 clears the cookie and redirects to login.

4. **Write path trusts the DB, not the queue.** On create, save to the primary
   first; publish to the queue is best-effort afterward with a short timeout
   (~2s) — log and swallow a publish failure, never throw on it. A broker
   outage degrades the async side effect, not the write. Leave a comment
   naming the known gap (event silently dropped) and the real fix
   (transactional outbox) — don't silently "fix" this by making publish
   failures throw.

5. **Idempotent, at-least-once queue consumer, hand-rolled.** Use a quorum
   queue with `x-delivery-limit` so RabbitMQ itself counts redelivery attempts
   and dead-letters after N attempts — no app-side retry counter. Before doing
   the real side effect, check a `processed_events` table (keyed by event ID)
   inside the same transaction as the work; a hit is a safe no-op ack.
   Unparseable payloads nack straight to the DLQ (`nack(msg, false, false)`);
   processing errors nack with requeue (`nack(msg, false, true)`) and let the
   delivery-limit mechanism handle retry/dead-lettering.

6. **Defense-in-depth rate limiting**: nginx `limit_req` at the edge, plus
   `@nestjs/throttler` as a global `APP_GUARD` inside the app (catches direct
   hits that skip nginx), with stricter per-route overrides on sensitive
   endpoints like login.

7. **Auth is a single demo credential, not a users table** — env-provided
   username + bcrypt password hash, checked in one `AuthService`, JWT issued
   via `@nestjs/jwt`. Reads are unauthenticated; writes require the JWT guard.
   Structure it so replacing the check with a real per-user lookup is a
   single-file change.

8. **Graceful shutdown**: call `app.enableShutdownHooks()`, and give anything
   holding an external connection (AMQP, etc.) an `onModuleDestroy`/
   `beforeApplicationShutdown` hook that closes cleanly on SIGTERM.

9. **Structured JSON logging** via `nestjs-pino`, with the `authorization`
   header redacted, and an instance-name env var tagging which container
   emitted each line (for reading logs across horizontally-scaled instances).

10. **Non-root containers.** Multi-stage Dockerfiles; production stage runs as
    the image's built-in unprivileged user, never root.

11. **Secrets management and multi-host orchestration are explicitly out of
    scope.** `.env` placeholders are fine; don't build a vault integration or
    a Kubernetes manifest unless asked — document the gap instead (see any
    README "where this still needs a real platform" section).

**Don't:**
- Don't add a global exception filter, caching layer, or other "nice to have"
  that isn't in this rule list unless asked.
- Don't collapse the primary/replica split into one connection "for
  simplicity" — the read/write split is the point of the exercise.
- Don't make the queue publish synchronous/blocking on the write path.
- Don't add comments that just restate what the code does; only comment
  non-obvious constraints (the ones called out above).

---

## Part 2 — Task Checklist

Work in this order; each step should leave the app in a runnable state.

### 1. Repo scaffold
- [ ] `app/` — NestJS project (`@nestjs/cli` scaffold), TypeScript, ESLint + Prettier
- [ ] `client/` — Next.js project (App Router, TypeScript, ESLint)
- [ ] Root `docker-compose.yml`, `.env.example`, `.gitignore`, `README.md`
- [ ] `nginx/`, `prometheus/`, `grafana/provisioning/` directories

### 2. Database layer (`app/src/database/`)
- [ ] `data-source.ts` — CLI-only TypeORM DataSource for migration commands
- [ ] `run-migrations.ts` — used by the compose `migrate` service
- [ ] `entities/` — start with one demo resource entity (e.g. `Task`: uuid pk,
      title, completed boolean default false, createdAt) + a
      `ProcessedEvent` entity (uuid pk `eventId`, `eventType`, `processedAt`)
      for consumer idempotency
- [ ] `database.module.ts` — two `TypeOrmModule.forRootAsync` registrations
      named `'default'` and `'replica'` per rule #1 above
- [ ] Generate the initial migration; commit it under `migrations/`

### 3. Auth (`app/src/auth/`)
- [ ] `AuthService` checking env `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` (bcrypt)
- [ ] `POST /auth/login` issuing a JWT (1h expiry)
- [ ] `JwtStrategy` + `JwtAuthGuard`, applied to the resource's write endpoint(s)
- [ ] Stricter throttler override on the login route

### 4. Queue (`app/src/queue/`)
- [ ] `queue.constants.ts` — exchange/queue/DLQ names, `MAX_DELIVERY_ATTEMPTS`
- [ ] `queue.service.ts` — producer, best-effort publish with timeout (rule #4)
- [ ] `queue.consumer.ts` — idempotent consumer (rule #5), quorum queue +
      `x-delivery-limit` declared on startup, `onModuleDestroy` closes the
      AMQP connection

### 5. Reference resource (`app/src/tasks/` or equivalent)
- [ ] Full CRUD wired through: `'default'` connection for writes, `'replica'`
      for reads, JWT guard on writes, queue publish on create (rule #4)
- [ ] This becomes the pattern new resources copy

### 6. Cross-cutting app setup
- [ ] `health/` — `GET /health` (`@nestjs/terminus`, DB + queue checks)
- [ ] `metrics/` — `GET /metrics` (Prometheus format, `@willsoto/nestjs-prometheus`)
- [ ] `main.ts` — `helmet()`, `enableShutdownHooks()`, no `setGlobalPrefix()`
- [ ] `app.module.ts` — `nestjs-pino` with authorization-header redaction,
      instance-name tag from env; `@nestjs/throttler` as global `APP_GUARD`

### 7. Web client (`client/`)
- [ ] `lib/session.ts` — httpOnly/Secure/SameSite=Lax cookie helpers
- [ ] `lib/api.ts` — server-only fetch helpers against `INTERNAL_API_URL`
      (never imported from a client component)
- [ ] `app/login/` — form + Server Action calling `POST /auth/login`, sets cookie
- [ ] `app/tasks/` (or matching the reference resource) — Server Component
      list + create form/Server Action
- [ ] `app/logout/` — Server Action clearing the cookie
- [ ] 401 from backend → clear cookie, redirect to `/login` (no refresh flow)

### 8. Docker
- [ ] `app/Dockerfile`, `client/Dockerfile` — multi-stage, non-root final stage
- [ ] `docker-compose.yml` services: `postgres-primary`, `postgres-replica`
      (depends on primary healthy), `pgbouncer-primary`, `pgbouncer-replica`,
      `rabbitmq`, `migrate` (runs once against primary directly, bypassing
      pgbouncer, then exits — `app1`/`app2` wait on
      `service_completed_successfully`), `app1`/`app2` (identical, shared
      network alias so the client round-robins the same way nginx does),
      `client`, `nginx` (only host-published entrypoint besides direct DB/queue
      debug ports), `prometheus`, `grafana`

### 9. nginx (`nginx/nginx.conf`)
- [ ] `limit_req_zone` + `limit_req` at the edge
- [ ] HTTP→HTTPS redirect; TLS server block with self-signed cert paths
- [ ] `location /api/` → strip prefix → app upstream
- [ ] `location /health`, `location /metrics` → app upstream, unprefixed
- [ ] `location /` → frontend upstream
- [ ] `nginx/certs/generate-self-signed-cert.sh` helper script

### 10. Observability
- [ ] `prometheus/prometheus.yml` scraping `app1:3000`/`app2:3000` `/metrics` directly
- [ ] `grafana/provisioning/` — datasource pointing at prometheus, one
      auto-loaded overview dashboard

### 11. CI/CD
- [ ] `.github/workflows/ci-cd.yml` — lint → test → build → `npm audit` →
      image build/push → deploy, gated on the earlier steps passing

### 12. Docs
- [ ] `README.md` — architecture diagram, stack rationale table, run
      instructions, curl walkthrough, "things worth experimenting with"
      (kill primary, kill rabbitmq, force a dead-letter), explicit "where
      this still needs a real platform" section (secrets, managed DB, managed
      LB, orchestration, clustered broker, tracing/alerting)
- [ ] Project-instructions file (CLAUDE.md/AGENTS.md) capturing the
      non-negotiable rules from Part 1 so future changes don't erode them

### Acceptance checks
- [ ] `docker compose up --build` brings up the full stack; migrations run
      before app containers start
- [ ] Login → write (task create) requires a valid JWT; read does not
- [ ] Killing `postgres-primary` fails writes but reads via replica still work
- [ ] Killing `rabbitmq` still lets a write succeed (degraded, after publish
      timeout), with a logged warning
- [ ] Forcing a consumer error N times past `MAX_DELIVERY_ATTEMPTS` lands the
      message in the DLQ, visible in the RabbitMQ management UI
- [ ] `/metrics` scraped by Prometheus; Grafana dashboard shows data
- [ ] `npm run lint`, `npm test`, `npm run build` all pass in both `app/` and `client/`
