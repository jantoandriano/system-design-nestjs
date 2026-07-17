# Folder Structure

## Guiding idea

Organize by **feature/domain first, file type second.** The question "where does the code for X live" should have one answer: `features/x/`. Reserve top-level `components/`, `hooks/`, `lib/` for things that are genuinely shared across multiple features — not as a default dumping ground.

## Top-level layout (Next.js App Router)

The key split: **`app/` is routing only.** Route segment files (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `route.ts`) live there and stay thin. Actual feature code — components, hooks, API calls, schemas — lives in `src/features/` and gets imported into the route files. This keeps `app/`'s structure dictated purely by your URLs, not by where feature logic happens to live.

```
app/
├── layout.tsx                # Root layout
├── page.tsx                  # `/`
├── globals.css
├── (marketing)/               # Route group — organizes routes without affecting the URL
│   ├── about/page.tsx
│   └── pricing/page.tsx
├── users/
│   ├── page.tsx               # `/users` — imports from src/features/users
│   ├── loading.tsx
│   ├── error.tsx
│   └── [id]/
│       ├── page.tsx           # `/users/:id`
│       └── edit/page.tsx      # `/users/:id/edit`
└── api/
    └── users/route.ts         # Route handler, if not using Server Actions

src/
├── features/                  # One folder per business domain — same shape as below
│   ├── users/
│   │   ├── components/         # Components used only within this feature
│   │   ├── hooks/              # TanStack Query hooks for this feature
│   │   ├── actions.ts          # Server Actions ("use server"), if used instead of route handlers
│   │   ├── api.ts              # Client-side fetch functions
│   │   ├── schemas.ts          # Zod schemas + inferred types
│   │   ├── query-keys.ts       # Query key factory (see tanstack-query.md)
│   │   └── index.ts            # Public exports other features/routes are allowed to import
│   └── orders/
│       └── ...                 # same shape
├── components/
│   └── ui/                     # shadcn/ui generated components — don't hand-edit their structure
├── hooks/                      # Cross-feature hooks only (useDebounce, useMediaQuery)
├── lib/                        # Cross-feature utilities: cn(), the HTTP client instance, date formatting
└── types/                      # Types shared across 2+ features (rare — most types live in their feature)
```

A route file stays thin and delegates to the feature:

```tsx
// app/users/[id]/page.tsx
import { UserDetail } from "@/features/users/components/UserDetail";
import { getUser } from "@/features/users/api";

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser(id); // Server Component — fetch directly, no TanStack Query needed here
  return <UserDetail initialUser={user} id={id} />;
}
```

See `references/nextjs-app-router.md` for the Server/Client Component split and how this page pattern hands off to TanStack Query on the client.

## Rules of thumb

- **A feature folder is self-contained.** If deleting `features/orders/` would also require hunting through `components/`, `hooks/`, and `types/` at the root to fully remove orders, the feature isn't actually colocated.
- **Only promote to a shared folder when ≥2 features need it.** Don't pre-emptively guess what will be shared — start local, extract when a second consumer shows up.
- **Small features skip subfolders.** A feature with two components and one hook doesn't need `components/` and `hooks/` directories — flat files (`UserCard.tsx`, `useUsers.ts`) inside `features/users/` are fine. Add subfolders once a feature has enough files that a flat list gets hard to scan (roughly 6-8+).
- **`index.ts` per feature is optional but useful for boundary discipline.** If you use it, only export what other features/pages should import — internal components/hooks stay unexported to signal "don't reach into this feature's internals from outside."
- **Avoid deep, mirrored nesting** like `features/users/components/UserList/UserList.tsx` with one file per folder — that's ceremony without payoff unless a component genuinely has multiple co-located files (e.g. `UserList.tsx` + `UserList.test.tsx` + `UserList.module.css`).

## Naming conventions

| What | Convention | Example |
|---|---|---|
| Component files | PascalCase, matches the component name | `UserCard.tsx` |
| Hook files | camelCase, `use` prefix | `useUsers.ts` |
| Non-component modules | kebab-case or camelCase, be consistent within the project | `query-keys.ts` / `queryKeys.ts` |
| Types/interfaces | PascalCase, no `I`/`T` prefix | `User`, not `IUser` |
| Boolean props/vars | `is`/`has`/`can` prefix | `isLoading`, `hasError`, `canEdit` |
| Event handler props | `on` prefix; handler implementations `handle` prefix | prop: `onSave`, impl: `handleSave` |

Pick one casing convention for non-component files per project and apply it everywhere — consistency matters more than which one you pick.

## Path aliases

Set up `@/` (or a similar alias) pointing at `src/` so imports don't degrade into `../../../../features/users/api`. Next.js picks this up automatically from `tsconfig.json` — no separate bundler config needed. Vitest, however, does need to be told about the alias separately (see `references/testing-vitest.md`), since it resolves modules through its own Vite config, not Next's.

```ts
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  }
}
```

```ts
// Good
import { useUsers } from "@/features/users/hooks/useUsers";
// Avoid
import { useUsers } from "../../../features/users/hooks/useUsers";
```

## Barrel files (`index.ts` re-exporting everything)

Use a feature's `index.ts` as a curated **public API** for that feature (a handful of intentional exports), not as a blanket `export * from "./components/UserList"` for every internal file. Blanket barrels make it too easy to accidentally depend on internals, and in large apps they can hurt build/HMR performance. If in doubt, import directly from the specific file instead of adding it to a barrel.
