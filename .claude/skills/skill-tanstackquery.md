# TanStack Query Patterns

## Core rule

**All server state goes through TanStack Query. No exceptions for "just this one simple fetch."** The moment data comes from an API, it gets a `useQuery`/`useMutation` hook — not a `useEffect` + `fetch` + `useState` combo. You lose caching, request dedup, background refetch, retry, and loading/error state management every time you bypass it.

```tsx
// Avoid
function UserProfile({ id }: { id: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch(`/api/users/${id}`).then(r => r.json()).then(setUser).finally(() => setLoading(false));
  }, [id]);
  // ...
}

// Prefer
function UserProfile({ id }: { id: string }) {
  const { data: user, isPending, isError } = useUser(id);
  // ...
}
```

## Query key factory

Centralize query keys per feature so every hook and every invalidation call uses the exact same key shape. Hand-typed keys scattered across files (`["users"]` here, `["user", "list"]` there) silently break cache invalidation.

```ts
// features/users/query-keys.ts
export const userKeys = {
  all: ["users"] as const,
  lists: () => [...userKeys.all, "list"] as const,
  list: (filters: UserFilters) => [...userKeys.lists(), filters] as const,
  details: () => [...userKeys.all, "detail"] as const,
  detail: (id: string) => [...userKeys.details(), id] as const,
};
```

This hierarchy is what makes broad invalidation possible: `invalidateQueries({ queryKey: userKeys.all })` invalidates every users query, while `invalidateQueries({ queryKey: userKeys.detail(id) })` invalidates just one.

## One custom hook per query, not raw `useQuery` in components

```ts
// features/users/hooks/useUsers.ts
import { useQuery } from "@tanstack/react-query";
import { userKeys } from "../query-keys";
import { fetchUsers } from "../api";
import type { UserFilters } from "../schemas";

export function useUsers(filters: UserFilters = {}) {
  return useQuery({
    queryKey: userKeys.list(filters),
    queryFn: () => fetchUsers(filters),
  });
}
```

```ts
// features/users/hooks/useUser.ts
export function useUser(id: string) {
  return useQuery({
    queryKey: userKeys.detail(id),
    queryFn: () => fetchUser(id),
    enabled: !!id, // guard dependent/conditional queries
  });
}
```

Components call `useUsers()` / `useUser(id)` — they never construct a query key or call `fetchUsers` directly. This keeps the query key and fetch function paired in exactly one place, and means changing how users are fetched never touches component code.

## `queryOptions` for reuse across `useQuery`, prefetch, and `ensureQueryData`

When the same query needs to be prefetched (e.g. on route load) and also used in a component, define it once with `queryOptions` so the key and fn can't drift apart:

```ts
import { queryOptions } from "@tanstack/react-query";

export function userQueryOptions(id: string) {
  return queryOptions({
    queryKey: userKeys.detail(id),
    queryFn: () => fetchUser(id),
    enabled: !!id,
  });
}

// In a hook:
export function useUser(id: string) {
  return useQuery(userQueryOptions(id));
}

// In a route loader (React Router / TanStack Router / Next):
await queryClient.ensureQueryData(userQueryOptions(id));
```

This function can live in `query-keys.ts` alongside the key factory, or its own `query-options.ts` if a feature has many of them — either is fine, just be consistent within the project. In a Next.js App Router project, this is the exact function to reuse for server-side `prefetchQuery` + `HydrationBoundary` — see `references/nextjs-app-router.md` for the full pattern of prefetching in a Server Component and hydrating into a Client Component's `useQuery`.

## Mutations: invalidate (or update) the cache on success

```ts
// features/users/hooks/useCreateUser.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { userKeys } from "../query-keys";
import { createUser } from "../api";

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userKeys.lists() });
    },
  });
}
```

Usage in a component — surface `isPending` on the submit button and `error` near the form, don't swallow either:

```tsx
function CreateUserForm() {
  const { mutate, isPending, error } = useCreateUser();

  return (
    <form onSubmit={(e) => { e.preventDefault(); mutate(formValues); }}>
      {/* fields */}
      {error && <p className="text-destructive text-sm">{error.message}</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Creating..." : "Create user"}
      </Button>
    </form>
  );
}
```

For mutations where you have the full updated object back from the server and want to avoid a refetch round-trip, update the cache directly instead of invalidating:

```ts
onSuccess: (updatedUser) => {
  queryClient.setQueryData(userKeys.detail(updatedUser.id), updatedUser);
  queryClient.invalidateQueries({ queryKey: userKeys.lists() }); // list still needs a refetch to reflect changes
}
```

## Optimistic updates

Only reach for this when the perceived latency genuinely matters (e.g. toggling a like, checking a checkbox) — it adds real complexity (rollback logic) that isn't worth it for most forms, where a loading spinner is perfectly fine.

```ts
export function useToggleFavorite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: toggleFavorite,
    onMutate: async (userId: string) => {
      await queryClient.cancelQueries({ queryKey: userKeys.detail(userId) });
      const previous = queryClient.getQueryData<User>(userKeys.detail(userId));

      queryClient.setQueryData<User>(userKeys.detail(userId), (old) =>
        old ? { ...old, isFavorite: !old.isFavorite } : old
      );

      return { previous }; // passed to onError as `context`
    },
    onError: (_err, userId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(userKeys.detail(userId), context.previous);
      }
    },
    onSettled: (_data, _err, userId) => {
      queryClient.invalidateQueries({ queryKey: userKeys.detail(userId) });
    },
  });
}
```

## Pagination and infinite lists

For page-number pagination, keep the previous page's data visible while the next page loads instead of flashing a spinner:

```ts
import { keepPreviousData, useQuery } from "@tanstack/react-query";

export function useUsers(page: number) {
  return useQuery({
    queryKey: userKeys.list({ page }),
    queryFn: () => fetchUsers({ page }),
    placeholderData: keepPreviousData,
  });
}
```

For "load more" / infinite scroll, use `useInfiniteQuery`:

```ts
export function useInfiniteUsers() {
  return useInfiniteQuery({
    queryKey: userKeys.lists(),
    queryFn: ({ pageParam }) => fetchUsers({ cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
```

## Error handling

Don't only handle the happy path. At minimum, every list/detail query in a component handles three states:

```tsx
function UserList() {
  const { data: users, isPending, isError, error } = useUsers();

  if (isPending) return <UserListSkeleton />;
  if (isError) return <ErrorState message={error.message} />;
  if (users.length === 0) return <EmptyState />;

  return <ul>{users.map((u) => <UserCard key={u.id} user={u} />)}</ul>;
}
```

For app-wide error handling (e.g. redirect to login on 401), set a global default rather than repeating logic in every hook:

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (failureCount, err) => err.status !== 401 && failureCount < 3 },
  },
  queryCache: new QueryCache({
    onError: (err) => {
      if (err instanceof HttpError && err.status === 401) redirectToLogin();
    },
  }),
});
```

## Dependent queries

When one query needs the result of another, use `enabled` rather than nesting `useEffect`s:

```ts
const { data: user } = useUser(userId);
const { data: orders } = useQuery({
  queryKey: orderKeys.byUser(user?.id),
  queryFn: () => fetchOrdersForUser(user!.id),
  enabled: !!user?.id,
});
```

## Suspense (optional)

If the app uses React Suspense boundaries, `useSuspenseQuery` removes the need to check `isPending` at all — the component only renders once data is ready, and the nearest `<Suspense>`/error boundary handles loading/error UI. Use this consistently within a feature rather than mixing `useQuery` and `useSuspenseQuery` for the same kind of data.

## What NOT to put in TanStack Query

Local UI state — a dropdown's open/closed state, form draft values before submit, a selected tab — stays in `useState`/`useReducer` or URL search params. TanStack Query is for data that came from (or is going to) a server; using it as a general state manager fights the library.
