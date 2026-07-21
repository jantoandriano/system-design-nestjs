# ERP Phase 0: Users Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `AuthService`'s single env-credential check with a real `users` table, so later RBAC has actual accounts to attach roles to.

**Architecture:** New `User` entity in `app/src/database/entities/`, a `UsersModule`/`UsersService` owning bcrypt hashing and lookups, `AuthService` rewritten to call it. A standalone seed script bootstraps one admin account (mirrors the existing `run-migrations.ts` standalone-DataSource pattern), replacing the `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` env vars.

**Tech Stack:** NestJS, TypeORM (`default` connection only — login must never read stale/missing data off the replica), `bcryptjs` (already a dependency), Jest.

## Global Constraints

- `synchronize` stays off. Every schema change is a migration file under `app/src/database/migrations/`, generated via `npm run migration:generate -- src/database/migrations/<Name>` and run via `npm run migration:run`, from `app/`.
- Every new entity must be added to the `ENTITIES` array in `app/src/database/database.module.ts` (both `default` and `replica` connections use it) and to `app/src/database/data-source.ts`'s `entities` array (CLI-only connection).
- Repository injection always specifies the connection: `@InjectRepository(User, 'default')`.
- No `console.log`/`Logger` of passwords or hashes, ever.
- All new tests follow the existing Jest setup (`app/package.json`'s `jest` block, `rootDir: src`, files matching `*.spec.ts`).

---

### Task 1: `User` entity + migration

**Files:**
- Create: `app/src/database/entities/user.entity.ts`
- Modify: `app/src/database/database.module.ts`
- Modify: `app/src/database/data-source.ts`
- Create: `app/src/database/migrations/<timestamp>-CreateUsers.ts` (generated, timestamp is whatever TypeORM assigns)

**Interfaces:**
- Produces: `User` class — `{ id: string; username: string; passwordHash: string; createdAt: Date }`, importable from `../database/entities/user.entity`.

- [ ] **Step 1: Write the entity**

```typescript
// app/src/database/entities/user.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  username: string;

  @Column()
  passwordHash: string;

  @CreateDateColumn()
  createdAt: Date;
}
```

- [ ] **Step 2: Register the entity on both connections**

In `app/src/database/database.module.ts`, add the import and extend `ENTITIES`:

```typescript
import { User } from './entities/user.entity';
// ...
const ENTITIES = [Task, ProcessedEvent, User];
```

In `app/src/database/data-source.ts`, add the same import and extend the `entities` array:

```typescript
import { User } from './entities/user.entity';
// ...
entities: [Task, ProcessedEvent, User],
```

- [ ] **Step 3: Generate the migration**

Run from `app/`:
```bash
npm run migration:generate -- src/database/migrations/CreateUsers
```
Expected: a new file `src/database/migrations/<timestamp>-CreateUsers.ts` containing a `CREATE TABLE "users" (...)` in `up()` and a `DROP TABLE "users"` in `down()`. Open it and confirm both — TypeORM's generator is deterministic from the entity diff, no hand-editing needed.

- [ ] **Step 4: Run the migration**

```bash
npm run migration:run
```
Expected: output includes `CreateUsers<timestamp>` under "migrations applied". Verify with `psql` or any client that a `users` table now exists with columns `id, username, passwordHash, createdAt`.

- [ ] **Step 5: Commit**

```bash
git add app/src/database/entities/user.entity.ts app/src/database/database.module.ts app/src/database/data-source.ts app/src/database/migrations/
git commit -m "feat(database): add users table"
```

---

### Task 2: `UsersService`

**Files:**
- Create: `app/src/users/users.service.ts`
- Test: `app/src/users/users.service.spec.ts`

**Interfaces:**
- Consumes: `User` entity from Task 1 (`../database/entities/user.entity`).
- Produces: `UsersService` class with:
  - `create(username: string, password: string): Promise<User>`
  - `findByUsername(username: string): Promise<User | null>`
  - `validatePassword(user: User, password: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/users/users.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { User } from '../database/entities/user.entity';

describe('UsersService', () => {
  let service: UsersService;
  const repo = {
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'user-1', createdAt: new Date(), ...data })),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User, 'default'), useValue: repo },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  it('hashes the password before saving', async () => {
    const user = await service.create('alice', 'correct-horse');
    expect(user.username).toBe('alice');
    expect(user.passwordHash).toBeDefined();
    expect(user.passwordHash).not.toBe('correct-horse');
  });

  it('finds a user by username', async () => {
    repo.findOne.mockResolvedValue({ id: 'user-1', username: 'alice' });
    const user = await service.findByUsername('alice');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { username: 'alice' } });
    expect(user?.username).toBe('alice');
  });

  it('returns null when the username does not exist', async () => {
    repo.findOne.mockResolvedValue(null);
    const user = await service.findByUsername('nobody');
    expect(user).toBeNull();
  });

  it('validates a correct password against the stored hash', async () => {
    const created = await service.create('bob', 'hunter2');
    const ok = await service.validatePassword(created, 'hunter2');
    expect(ok).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const created = await service.create('bob', 'hunter2');
    const ok = await service.validatePassword(created, 'wrong-password');
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest users/users.service.spec.ts
```
Expected: FAIL — `Cannot find module './users.service'`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/users/users.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../database/entities/user.entity';

const SALT_ROUNDS = 10;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User, 'default')
    private readonly repo: Repository<User>,
  ) {}

  async create(username: string, password: string): Promise<User> {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = this.repo.create({ username, passwordHash });
    return this.repo.save(user);
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.repo.findOne({ where: { username } });
  }

  async validatePassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest users/users.service.spec.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/users/users.service.ts app/src/users/users.service.spec.ts
git commit -m "feat(users): add UsersService with bcrypt password hashing"
```

---

### Task 3: `UsersModule`

**Files:**
- Create: `app/src/users/users.module.ts`
- Modify: `app/src/app.module.ts`

**Interfaces:**
- Consumes: `UsersService` from Task 2.
- Produces: `UsersModule`, exporting `UsersService` for `AuthModule` to import in Task 4.

- [ ] **Step 1: Write the module**

```typescript
// app/src/users/users.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User], 'default')],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 2: Register it in `AppModule`**

In `app/src/app.module.ts`, add the import and list it alongside the other feature modules:

```typescript
import { UsersModule } from './users/users.module';
// ...
imports: [
  // ...existing imports...
  UsersModule,
  TasksModule,
  HealthModule,
  AuthModule,
  MetricsModule,
],
```

- [ ] **Step 3: Verify the app still boots**

```bash
npm run build
```
Expected: exits 0, no TypeScript errors (unused-module errors would show here if the wiring is wrong).

- [ ] **Step 4: Commit**

```bash
git add app/src/users/users.module.ts app/src/app.module.ts
git commit -m "feat(users): wire UsersModule into AppModule"
```

---

### Task 4: Rewrite `AuthService` to use `UsersService`

**Files:**
- Modify: `app/src/auth/auth.service.ts`
- Modify: `app/src/auth/auth.module.ts`
- Test: `app/src/auth/auth.service.spec.ts` (new — none exists today)

**Interfaces:**
- Consumes: `UsersService.findByUsername`, `UsersService.validatePassword` from Task 2.
- Produces: `AuthService.login(username: string, password: string): Promise<{ accessToken: string }>` — same external signature as before, so `AuthController` (`app/src/auth/auth.controller.ts`) needs no change.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/auth/auth.service.spec.ts
import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

describe('AuthService', () => {
  let service: AuthService;
  const usersService = {
    findByUsername: jest.fn(),
    validatePassword: jest.fn(),
  };
  const jwtService = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('issues an access token for valid credentials', async () => {
    usersService.findByUsername.mockResolvedValue({ id: 'user-1', username: 'alice', passwordHash: 'hash' });
    usersService.validatePassword.mockResolvedValue(true);

    const result = await service.login('alice', 'correct-horse');

    expect(result).toEqual({ accessToken: 'signed.jwt.token' });
    expect(jwtService.signAsync).toHaveBeenCalledWith({ sub: 'user-1', username: 'alice' });
  });

  it('rejects an unknown username', async () => {
    usersService.findByUsername.mockResolvedValue(null);
    await expect(service.login('nobody', 'whatever')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an incorrect password', async () => {
    usersService.findByUsername.mockResolvedValue({ id: 'user-1', username: 'alice', passwordHash: 'hash' });
    usersService.validatePassword.mockResolvedValue(false);
    await expect(service.login('alice', 'wrong')).rejects.toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest auth/auth.service.spec.ts
```
Expected: FAIL — current `AuthService` takes `ConfigService`, not `UsersService`; the `useValue: usersService` provider is never consumed, so `jwtService.signAsync` gets called with a payload built from env vars instead, and the assertion on the call args fails.

- [ ] **Step 3: Rewrite the implementation**

```typescript
// app/src/auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async login(username: string, password: string) {
    const user = await this.usersService.findByUsername(username);
    const passwordMatches =
      user != null && (await this.usersService.validatePassword(user, password));

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: user.id, username: user.username };
    return {
      accessToken: await this.jwtService.signAsync(payload),
    };
  }
}
```

- [ ] **Step 4: Update `AuthModule` to import `UsersModule`**

```typescript
// app/src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    PassportModule,
    UsersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest auth/auth.service.spec.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Remove the now-unused env vars**

Remove `AUTH_USERNAME` and `AUTH_PASSWORD_HASH` from `app/.env.example` (or the repo's root `.env.example`, wherever they're declared) — they're replaced by the seed script in Task 5. Leave `JWT_SECRET`.

- [ ] **Step 7: Commit**

```bash
git add app/src/auth/auth.service.ts app/src/auth/auth.module.ts app/src/auth/auth.service.spec.ts
git commit -m "feat(auth): authenticate against the users table instead of env credentials"
```

---

### Task 5: Admin seed script

**Files:**
- Create: `app/src/database/seed-admin.ts`
- Modify: `app/package.json`

**Interfaces:**
- Consumes: `User` entity, `data-source.ts`'s connection config pattern.
- Produces: `npm run seed:admin` — idempotent (safe to run twice), reads `ADMIN_USERNAME`/`ADMIN_PASSWORD` from env.

Manual auth (login → protected route) is otherwise untestable without a real account, since there's no signup endpoint (admin-only account creation, no public registration — matches the "single demo credential" trust model this is replacing). This script is the bootstrap path, standalone from Nest DI, mirroring `run-migrations.ts`'s direct-`DataSource` style rather than booting the full app.

- [ ] **Step 1: Write the script**

```typescript
// app/src/database/seed-admin.ts
import dataSource from './data-source';
import { User } from './entities/user.entity';
import * as bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Idempotent bootstrap for the one account needed to log in before any
 * other users exist. Replaces the old AUTH_USERNAME/AUTH_PASSWORD_HASH
 * env vars now that credentials live in the users table.
 */
async function seed() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be set to seed the admin user');
  }

  await dataSource.initialize();
  const repo = dataSource.getRepository(User);

  const existing = await repo.findOne({ where: { username } });
  if (existing) {
    console.log(`User '${username}' already exists, skipping.`);
  } else {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await repo.save(repo.create({ username, passwordHash }));
    console.log(`Created user '${username}'.`);
  }

  await dataSource.destroy();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding admin user failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `app/package.json`, add alongside the other `migration:*` scripts (uses `ts-node` directly with the same `tsconfig-paths` register the CLI migration scripts rely on via `typeorm-ts-node-commonjs`):

```json
"seed:admin": "ts-node -r tsconfig-paths/register src/database/seed-admin.ts"
```

- [ ] **Step 3: Run it against a local/dev database**

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=change-me npm run seed:admin
```
Expected: `Created user 'admin'.` — running it again prints `User 'admin' already exists, skipping.` instead of erroring.

- [ ] **Step 4: Manually verify login end-to-end**

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me"}'
```
Expected: `{"accessToken":"..."}`. This confirms Tasks 1–5 work together against a real database, not just mocks.

- [ ] **Step 5: Commit**

```bash
git add app/src/database/seed-admin.ts app/package.json
git commit -m "feat(database): add idempotent admin user seed script"
```

---

## Definition of Done

- `users` table exists via migration, `User` entity registered on both TypeORM connections.
- `UsersService` covered by unit tests (create/find/validate).
- `AuthService.login` authenticates against the `users` table; unit tests cover valid/unknown-user/wrong-password paths.
- `ADMIN_USERNAME`/`ADMIN_PASSWORD` seed script creates a working login, idempotently.
- `npm run build` and `npm test` both pass in `app/`.
