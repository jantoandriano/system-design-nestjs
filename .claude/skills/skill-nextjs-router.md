# Next.js App Router Patterns

## Server Components by default

Everything under `app/` is a Server Component unless it (or an ancestor in its render tree) has `"use client"` at the top. Server Components:

- Can be `async` and fetch data directly (`await fetch(...)`, or call a database/ORM) — no `useEffect`, no loading state to manage, no client-side waterfall.
- Never re-render on the client, don't ship their JS to the browser, and can't use hooks, browser APIs, or event handlers (`onClick`, etc).
- Are the default for pages, layouts, and any component that's purely presentational or does server-side data fetching.

```tsx
// app/users/page.tsx — Server Component, no "use client"
import { UserListClient } from "@/features/users/components/UserListClient";
import { fetchUsers } from "@/features/users/api";

export default async function UsersPage() {
  const initialUsers = await fetchUsers();
  return <UserListClient initialUsers={initialUsers} />;
}
```

## When a Client Component is actually needed

Add `"use client"` only to the specific component that needs one of these — not to the whole page:

- State (`useState`, `useReducer`) or effects (`useEffect`)
- Event handlers (`onClick`, `onChange`, form submission)
- Browser-only APIs (`localStorage`, `window`, `IntersectionObserver`)
- React Context consumption, or any hook from a client-only library
- TanStack Query hooks (`useQuery`, `useMutation`) — these require the client-side `QueryClient`

```tsx
// features/users/components/UserListClient.tsx
"use client";

import { useUsers } from "../hooks/useUsers";
import type { User } from "../schemas";

export function UserListClient({ initialUsers }: { initialUsers: User[] }) {
  const { data: users } = useUsers({ initialData: initialUsers });
  // interactive filtering, refetch, etc. happens here
}
```

**Push `"use client"` as far down the tree as possible.** A page can be a Server Component that renders mostly static server-fetched content, with one small interactive island (a filter dropdown, a like button) marked `"use client"` — that's better than marking the whole page client and losing server rendering for everything.

## Where TanStack Query fits alongside Server Components

Server Components already solve *initial* data fetching — you often don't need `useQuery` just to render a page's first paint. TanStack Query earns its place for anything that needs **client-side refetching, caching across navigations, mutations, or interactivity**: pagination, live filters, optimistic updates, polling, or data shared across multiple client components that shouldn't each re-fetch independently.

### Pattern A — Server Component fetches once, hands off as `initialData`

Simplest option for data that doesn't need to be prefetched into the query cache formally — the Server Component fetches, and the Client Component seeds TanStack Query with that value so there's no duplicate request on mount:

```tsx
// app/users/[id]/page.tsx (Server Component)
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await fetchUser(id);
  return <UserDetailClient id={id} initialUser={user} />;
}
```

```tsx
// features/users/components/UserDetailClient.tsx
"use client";
export function UserDetailClient({ id, initialUser }: { id: string; initialUser: User }) {
  const { data: user } = useUser(id, { initialData: initialUser });
  // ...
}
```

### Pattern B — Prefetch into the query cache + hydrate (preferred for anything using the query-key-driven hooks elsewhere)

Prefetch on the server using the *same* `queryOptions`/query key the client hook uses, then dehydrate/hydrate so the client's `useQuery` finds a cache hit instead of refetching:

```tsx
// app/users/page.tsx
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { userQueryOptions } from "@/features/users/query-keys";
import { UserListClient } from "@/features/users/components/UserListClient";

export default async function UsersPage() {
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(userQueryOptions());

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <UserListClient />
    </HydrationBoundary>
  );
}
```

```tsx
// features/users/components/UserListClient.tsx
"use client";
export function UserListClient() {
  const { data: users } = useQuery(userQueryOptions()); // cache hit — no refetch on mount
}
```

Use Pattern B once a feature has more than a single one-off fetch, or when the same query is read from multiple client components — it keeps the query key as the single source of truth instead of threading `initialData` through props everywhere.

### The `QueryClientProvider` itself must be a Client Component

```tsx
// app/providers.tsx
"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
```

```tsx
// app/layout.tsx (Server Component — wraps children in the client Providers)
import { Providers } from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

Create the `QueryClient` inside `useState` (not at module scope) so each request/session gets its own instance — sharing one across requests on the server would leak data between users.

## Server Actions vs Route Handlers

Two ways to run server-side mutation logic; pick one per feature and stay consistent:

- **Server Actions** (`"use server"` functions in `actions.ts`) — best when the mutation is only ever called from your own app's forms/components. Can be passed directly to a `<form action={...}>`, or called from a client component and wired into a TanStack Query `mutationFn`.
- **Route Handlers** (`app/api/.../route.ts`) — best when you need a real HTTP endpoint: called from outside the app, consumed by a mobile client, or needs to be REST-shaped for other reasons.

```ts
// features/users/actions.ts
"use server";
import { userSchema, createUserInputSchema } from "./schemas";

export async function createUserAction(input: unknown) {
  const parsed = createUserInputSchema.parse(input);
  const user = await db.user.create({ data: parsed });
  return userSchema.parse(user);
}
```

```ts
// features/users/hooks/useCreateUser.ts
"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createUserAction } from "../actions";
import { userKeys } from "../query-keys";

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createUserAction,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: userKeys.lists() }),
  });
}
```

A Server Action called through a TanStack Query mutation (rather than a bare `<form action>`) still gets you `isPending`, `error`, and cache invalidation — use this combination whenever the mutation needs those, and reserve plain `<form action={action}>` (with `useFormStatus`/`useActionState`) for simple forms that don't need optimistic UI or query cache updates.

## `loading.tsx` / `error.tsx` vs TanStack Query's states

These solve the same problem at different layers — don't conflate them:

- `loading.tsx` / `error.tsx` handle the **initial server render** of a route segment (shown while the Server Component's `await` is pending, or if it throws).
- TanStack Query's `isPending`/`isError` handle **client-side** refetches, pagination, and mutations *after* the page has loaded.

A page typically needs both: `loading.tsx` for the first navigation, and `isPending` inside the Client Component for anything that refetches afterward.
