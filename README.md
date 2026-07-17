# System Design NestJS Demo

A runnable scaffold built around the core concepts from *System Design
Interview* (Alex Xu), now with the hardening a real deployment needs
around it: migrations, auth, rate limiting, structured logging, a
dead-letter queue with idempotent processing, TLS termination,
connection pooling, and metrics/dashboards.

**What's deliberately still out of scope:** secrets management (a real
secrets manager/vault instead of `.env` placeholders) and true
multi-host orchestration (Kubernetes/ECS) or managed cloud services
(RDS, a real load balancer). Those are platform decisions tied to
whichever cloud you land on, not something a code scaffold can decide
for you — see "Where this still needs a real platform" below.

## Architecture

```
Browser
  │
  ▼
nginx (TLS termination, rate limiting, load balancer :443)
  │
  ├──► /            client (Next.js)
  │                    │
  │                    └──► app1/app2 (internal, server-side calls only)
  │
  └──► /api/*       app1 (NestJS) ─┐
       /health      app2 (NestJS) ─┤
       /metrics                     ├──► pgbouncer-primary ──► postgres-primary  (writes)
                                     ├──► pgbouncer-replica ──► postgres-replica  (reads)
                                     └──► rabbitmq (quorum queue + DLQ)

prometheus ──scrapes──► app1 /metrics, app2 /metrics
grafana ──queries──► prometheus
```

## What's in the stack, and why

| Concern | Where it lives | Why it matters |
|---|---|---|
| Horizontal scaling | `app1` / `app2`, identical containers | No single instance is a SPOF |
| Load balancer + TLS | `nginx`, round-robin, self-signed cert by default | Single entry point; HTTPS only past the edge |
| Edge + app rate limiting | `nginx` (`limit_req`) and `@nestjs/throttler` | Defense in depth against abuse |
| Read/write DB split | `postgres-primary` (writes) + `postgres-replica` (reads) | Read scaling, matches the book's replication chapter |
| Connection pooling | `pgbouncer-primary` / `pgbouncer-replica` | Postgres has a hard connection ceiling; pooling lets many app instances share it |
| Schema changes | TypeORM migrations (`app/src/database/migrations`) | `synchronize: true` is a data-loss risk in prod - migrations are explicit and reviewable |
| Auth | JWT via `AuthModule` - `POST /auth/login`, protects `POST /tasks` | Writes shouldn't be open to anyone who can reach nginx |
| Structured logging | `nestjs-pino`, JSON in prod | Searchable logs, not scrollback |
| Message queue resilience | RabbitMQ quorum queue + `x-delivery-limit` + DLQ | Auto-retries a bounded number of times, then dead-letters instead of looping or dropping silently |
| Idempotent consumers | `processed_events` table, checked before processing | At-least-once delivery means redelivery *will* happen - this makes it safe |
| Graceful degradation | `QueueService.publishTaskCreated` has a 2s timeout | A downed broker degrades the async side effect, not the whole write - see the comment in `tasks.service.ts` about the transactional outbox pattern as the next step up from this |
| Graceful shutdown | `app.enableShutdownHooks()` in `main.ts` | SIGTERM (what Docker/K8s sends before killing a container) drains cleanly instead of cutting off in-flight work |
| Observability | `/metrics` (Prometheus format) + `prometheus` + `grafana` containers | See problems before users report them |
| Security headers | `helmet()` in `main.ts` | Standard HTTP hardening headers |
| Non-root containers | `Dockerfile` runs as the `node` user | A container compromise doesn't hand over root |
| CI/CD | `.github/workflows/ci-cd.yml` | lint/test/build → `npm audit` → image build+push → deploy |

## Running it

```bash
cp .env.example .env                          # fill in real values
bash nginx/certs/generate-self-signed-cert.sh   # local TLS cert (browsers will warn - expected)
docker compose up --build
```

The `migrate` service runs automatically before `app1`/`app2` start
(via `depends_on: condition: service_completed_successfully`) - no
separate step needed.

Then, against `https://localhost` (accept the self-signed cert warning):

The Nest API sits behind nginx's `/api/` prefix (stripped before it
reaches the app - see `nginx/nginx.conf`); `/health` and `/metrics` stay
unprefixed since Prometheus scrapes those paths directly against
`app1`/`app2`, not through nginx.

```bash
# Log in (demo credential - see "Auth" below)
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<the password you hashed into AUTH_PASSWORD_HASH>"}' \
  | jq -r .accessToken)

# Writes require the token
curl -sk -X POST https://localhost/api/tasks \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"write more system design notes"}'

# Reads don't
curl -sk https://localhost/api/tasks

# Health, metrics
curl -sk https://localhost/health
curl -sk https://localhost/metrics
```

Or use the web client directly at `https://localhost` - login form at
`/login`, task list + create form at `/tasks` (see "Web client" below).

Other UIs:
- RabbitMQ management: `http://localhost:15672` (`RABBITMQ_USER`/`RABBITMQ_PASSWORD` from `.env`) - check the `tasks_queue.dlq` queue to see dead-lettered messages after repeated failures.
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3003` (login `admin` / `GF_SECURITY_ADMIN_PASSWORD` from docker-compose) - the "System Design NestJS - Overview" dashboard is provisioned automatically.

## Auth

This ships a single demo credential via env vars (`AUTH_USERNAME`,
`AUTH_PASSWORD_HASH`), not a users table - enough to demonstrate a real
JWT flow protecting a write endpoint. Generate a hash for your own
password:

```bash
node -e "require('bcryptjs').hash('your-password', 10).then(console.log)"
```

Before this handles real accounts: replace `AuthService.login` with a
lookup against a users table (per-user bcrypt hashes), and consider
refresh tokens if 1-hour access tokens are too short for your use case.

## Web client

`client/` is a Next.js app (App Router), served same-origin at `/`
behind the same nginx entrypoint - no CORS needed. It never handles the
raw JWT client-side: Server Actions call the Nest API server-side
(directly over the internal docker network, bypassing nginx) and store
the resulting token in an httpOnly cookie. See
`client/lib/session.ts` and `client/app/{login,tasks}/actions.ts`.

## Migrations

```bash
cd app
npm run migration:generate -- src/database/migrations/YourMigrationName   # after changing an entity
npm run migration:run       # apply pending migrations
npm run migration:revert    # roll back the last one
```

`synchronize` is off on both DB connections - schema changes only ever
come from reviewed migration files, run explicitly (by the `migrate`
service in Docker, or manually via the commands above).

## Things worth experimenting with

- **Kill `postgres-primary`** while running - writes fail, `GET /tasks` (replica) keeps working.
- **Kill `rabbitmq`** and create a task - the write still succeeds (in ~2s, once the publish times out); check the logs for the "Failed to publish" warning. That's the graceful-degradation behavior in `tasks.service.ts`.
- **Watch a message dead-letter**: make the consumer throw on purpose (edit `queue.consumer.ts`), publish a few events, and watch them land in `tasks_queue.dlq` in the RabbitMQ UI after 3 failed attempts.
- **Scale further**: add `app3` to `docker-compose.yml` and the `nginx.conf` upstream block.
- **Add a cache**: the natural next step after load balancing/replication - Redis in front of `TasksService.findAll()`.

## Where this still needs a real platform

Everything above is real, running code. These aren't:

- **Secrets management** - `.env` placeholders are fine for this scaffold; swap for AWS Secrets Manager / Vault / GCP Secret Manager before production, with rotation.
- **Managed database** - self-hosted primary/replica here has no automatic failover. RDS/Cloud SQL/Aurora (or Patroni if you must self-host) handle that.
- **Managed load balancer** - a single `nginx` container is a SPOF. An ALB/GCP LB spans zones by default.
- **Orchestration** - docker-compose runs everything on one host. Kubernetes/ECS/Nomad spread across hosts and zones, with autoscaling and rolling deploys.
- **Clustered message broker** - a single RabbitMQ node is a SPOF; cluster it or use a managed broker (Amazon MQ, CloudAMQP).
- **Full observability** - what's here (Prometheus + Grafana + basic process metrics) is a real starting point, not a complete picture. Add alerting (PagerDuty/Opsgenie) on error rate and p99 latency, and distributed tracing (OpenTelemetry) if requests start crossing multiple services.

## Project layout

```
docker-compose.yml
.env.example
nginx/
  nginx.conf                    # TLS + rate limiting + load balancing
  certs/generate-self-signed-cert.sh
prometheus/prometheus.yml
grafana/provisioning/           # datasource + dashboard, auto-loaded
app/
  src/
    auth/                        # JWT login + guard
    database/
      migrations/                 # schema history
      data-source.ts               # CLI-only, used by migration commands
      run-migrations.ts            # used by the docker-compose `migrate` service
    queue/                        # producer, consumer with DLQ + idempotency
    tasks/                        # CRUD example wired through primary/replica/queue/auth
    health/                       # GET /health
    metrics/                      # GET /metrics (Prometheus format)
  Dockerfile                      # multi-stage, non-root
client/
  app/
    login/                         # login form + Server Action
    tasks/                         # task list + create form + Server Action
    logout/                        # Server Action
  lib/
    api.ts                          # server-only fetch helpers against INTERNAL_API_URL
    session.ts                       # httpOnly session cookie helpers
  Dockerfile                      # multi-stage, non-root
.github/workflows/ci-cd.yml       # lint/test/build -> audit -> image -> deploy
```
