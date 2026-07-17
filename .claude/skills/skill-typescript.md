# TypeScript Conventions

## tsconfig baseline

Use strict mode — don't weaken it to make errors go away:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "moduleResolution": "bundler",
    "skipLibCheck": true
  }
}
```

`noUncheckedIndexedAccess` is worth calling out specifically: without it, `arr[i]` and `obj[key]` are typed as if they can never be `undefined`, which is false and a common source of runtime errors. With it on, TypeScript forces you to handle the missing case.

## Schema-first types with Zod

Define the shape once, as a Zod schema, and infer the TypeScript type from it. This keeps runtime validation and compile-time types from drifting apart — a hand-written `interface User` next to a hand-written parser is two sources of truth that will eventually disagree.

```ts
// features/users/schemas.ts
import { z } from "zod";

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: z.enum(["admin", "member", "viewer"]),
  createdAt: z.string().datetime(),
});

export type User = z.infer<typeof userSchema>;

export const createUserInputSchema = userSchema.omit({ id: true, createdAt: true });
export type CreateUserInput = z.infer<typeof createUserInputSchema>;
```

Parse untrusted data (API responses, form input) at the boundary, not deep inside components:

```ts
// features/users/api.ts
export async function fetchUser(id: string): Promise<User> {
  const res = await httpClient.get(`/users/${id}`);
  return userSchema.parse(res.data); // throws if the API shape drifts — fail loud, not silently
}
```

If a project doesn't use Zod, at minimum hand-write the type to match the API contract exactly and keep it next to the code that calls the API, not in a distant shared file.

## `type` vs `interface`

Default to `type` for consistency — it handles unions, mapped types, and object shapes equally well. `interface` is fine and idiomatic for object shapes that are meant to be extended (e.g. a component prop type a consumer might augment) or when the project already has a convention. Don't mix conventions arbitrarily within one project.

```ts
// Object shape
type UserCardProps = {
  user: User;
  onEdit?: (id: string) => void;
};

// Union — must be `type`
type Status = "idle" | "loading" | "success" | "error";
```

## Prefer literal unions over enums

```ts
// Prefer
type Role = "admin" | "member" | "viewer";

// Avoid, unless the project already standardizes on enums
enum Role { Admin = "admin", Member = "member", Viewer = "viewer" }
```

Literal unions are structurally typed (no import needed just to reference the type), tree-shake cleanly, and print as their actual string value in debugging — enums add an extra indirection for little benefit in most React codebases.

## Discriminated unions for state that isn't independent

If two pieces of state only make sense together (e.g. "we have an error" implies "we don't have data"), model it as one discriminated union instead of several independent booleans that can fall out of sync.

```ts
// Avoid — isLoading, isError, and data can be set inconsistently
type State = { isLoading: boolean; isError: boolean; data: User | null };

// Prefer
type State =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "success"; data: User };
```

In practice, TanStack Query already gives you this shape via its status/`isPending`/`isError`/`isSuccess` fields — this pattern matters most for state you're managing yourself (multi-step forms, wizards, optimistic UI).

## Typing components

```tsx
type UserCardProps = {
  user: User;
  variant?: "compact" | "detailed";
  onEdit?: (userId: string) => void;
};

export function UserCard({ user, variant = "compact", onEdit }: UserCardProps) {
  // ...
}
```

- Don't type components as `React.FC` — it adds an implicit `children` prop even when the component doesn't accept children, and offers no real benefit over typing props directly.
- Give optional props a default in the destructure (`variant = "compact"`) rather than checking `if (!variant)` inside the body.
- Only add `children: React.ReactNode` when the component actually renders children.

## Avoid `any` — reach for these instead

| Instead of | Use |
|---|---|
| `any` for "I don't know the shape yet" | `unknown`, then narrow with a type guard or Zod parse |
| `any` for a third-party value | Check for `@types/...`, or write a minimal local type for just the fields you use |
| `as SomeType` to force a mismatch | Fix the upstream type, or write a proper type guard function |
| `Function` as a type | A specific signature: `(id: string) => void` |
| `object` as a type | A specific shape, or `Record<string, unknown>` if truly generic |

A type guard example, for narrowing `unknown` safely:

```ts
function isUser(value: unknown): value is User {
  return userSchema.safeParse(value).success;
}
```

## Useful built-in utility types

Reach for these before hand-rolling an equivalent:

- `Partial<T>` / `Required<T>` — e.g. a form's draft state as `Partial<CreateUserInput>`
- `Pick<T, K>` / `Omit<T, K>` — deriving a narrower type from an existing one instead of redefining it
- `Record<K, V>` — dictionaries/lookup maps
- `ReturnType<typeof fn>` — typing a value from a function you don't control the return type of directly
- `Awaited<ReturnType<typeof fetchUser>>` — the resolved type of an async function's return

Deriving types (`Omit<User, "id">`) instead of hand-writing a near-duplicate keeps the two in sync automatically when the source type changes.
