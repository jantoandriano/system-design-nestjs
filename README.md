# System Design NestJS Demo

A runnable scaffold that puts the core concepts from *System Design Interview*
(Alex Xu) into an actual NestJS project you can `docker compose up`. It isn't
a production template — it's a sandbox for seeing load balancing, replication,
and message queues behave, so the diagrams in the book stop being abstract.

## What's in the stack

```
Client
  │
  ▼
nginx (load balancer, port 80)
  │
  ├──► app1 (NestJS) ─┐
  └──► app2 (NestJS) ─┤
                       ├──► postgres-primary  (writes)
                       ├──► postgres-replica  (reads, streams from primary)
                       └──► rabbitmq          (async events)
```

| Concept from the book         | Where it lives here                                   |
|--------------------------------|---------------------------------------------------------|
| Horizontal scaling              | Two identical `app1` / `app2` containers                |
| Load balancer                   | `nginx`, round-robin across `app1`/`app2`                |
| Database replication (read/write split) | `postgres-primary` (writes) + `postgres-replica` (reads), streaming replication via Bitnami's Postgres image |
| Message queue / async processing | `rabbitmq`; `TasksService.create()` publishes an event, `QueueConsumerService` processes it independently of the HTTP request |
| Health checks                    | `GET /health` (used by orchestrators to know if an instance is alive) |
| CI/CD                            | `.github/workflows/ci-cd.yml` — lint/test/build → build+push image → deploy |

## Running it

```bash
cp .env.example .env       # fill in real values, or leave placeholders for local dev
docker compose up --build
```

Then:
- `curl http://localhost/` a few times — watch the `instance` field alternate between `app1` and `app2`. That's the load balancer.
- `curl -X POST http://localhost/tasks -H "Content-Type: application/json" -d '{"title":"write more system design notes"}'` — writes to the primary DB and publishes a queue event. Check the `docker compose logs app1 app2` output to see the consumer pick it up.
- `curl http://localhost/tasks` — reads from the replica.
- `curl http://localhost/health` — health check used for readiness/liveness.
- RabbitMQ management UI: `http://localhost:15672` (login with `RABBITMQ_USER` / `RABBITMQ_PASSWORD` from `.env`).

## Project layout

```
docker-compose.yml       # orchestrates everything below
.env.example              # copy to .env and fill in
nginx/nginx.conf          # load balancer config
app/                       # the NestJS service
  src/
    app.controller.ts       # GET / -> which instance served this request
    database/                # primary + replica TypeORM connections
    queue/                   # RabbitMQ producer + consumer
    tasks/                   # CRUD example wired through primary/replica/queue
    health/                  # GET /health via @nestjs/terminus
  Dockerfile                # multi-stage build
.github/workflows/ci-cd.yml # lint/test/build -> image build+push -> deploy
```

## Things worth experimenting with, once it's running

- **Kill `postgres-primary`** while it's running and watch writes fail while `GET /tasks` (reads from replica) keeps working — this is exactly the read-availability trade-off the book discusses.
- **Scale further**: add `app3` in `docker-compose.yml` and the `nginx.conf` upstream block; no code changes needed.
- **Swap the load-balancing algorithm**: try `least_conn;` or `ip_hash;` in `nginx.conf` and compare behavior.
- **Add a cache**: this is the natural next step the book covers after load balancing/replication — try dropping a Redis container in front of `TasksService.findAll()`.
- **Replace polling logs with real consumer work**: have `QueueConsumerService` actually do something (write to a search index, send a notification) to feel the decoupling benefit.

## Notes on the placeholders

Every secret-shaped value (DB passwords, RabbitMQ credentials, JWT secret,
Docker registry credentials, deploy host/key) is a placeholder in `.env.example`
and in the GitHub Actions workflow (as `secrets.*`). Don't commit a real `.env`;
set the real values as GitHub Actions repo secrets for CI/CD, and as your
deployment platform's environment variables/secrets for the running app.

`synchronize: true` on the primary TypeORM connection is there purely so the
`tasks` table gets created automatically on first boot for this demo — turn it
off and use migrations before this touches anything resembling production data.
