# Testing with Vitest

## Setup

Vitest needs its own config — it doesn't read Next.js's build config, so path aliases, JSX transform, and the DOM environment all need to be declared explicitly.

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

```ts
// vitest.setup.ts
import "@testing-library/jest-dom/vitest";
```

Server Components (`async` components with no `"use client"`) generally can't be unit-tested with Vitest + RTL the way client components can, since they rely on the Next.js server rendering pipeline. Test them at a higher level instead: extract their data-fetching/business logic into a plain function and unit-test that directly, or cover the route with an E2E tool (Playwright) if full-page behavior matters. Vitest here is for **Client Components, hooks, and pure logic.**

## What to test (and what not to)

- **Hooks with logic** (custom TanStack Query hooks, form validation helpers, data transforms) — high value, cheap to write.
- **Client Components, behavior-focused** — what the user sees and can do, not internal state or class names.
- **Pure utility functions** (`lib/`, data formatters, Zod-schema edge cases) — cheap and catches real bugs.
- Skip testing shadcn/ui's generated components themselves (`components/ui/`) — that's tested upstream. Test how *your* components use them.
- Skip snapshot tests for anything that changes often — they tend to get rubber-stamped-updated rather than actually reviewed, which defeats the purpose.

## Testing a component with React Testing Library

Query by role/text the way a user would find the element, not by test-id or class name unless there's no accessible alternative:

```tsx
// features/users/components/UserCard.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserCard } from "./UserCard";

const mockUser = { id: "1", name: "Ada Lovelace", email: "ada@example.com", role: "admin" as const };

describe("UserCard", () => {
  it("renders the user's name and email", () => {
    render(<UserCard user={mockUser} />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("calls onEdit with the user id when the edit button is clicked", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<UserCard user={mockUser} onEdit={onEdit} />);

    await user.click(screen.getByRole("button", { name: /edit/i }));

    expect(onEdit).toHaveBeenCalledWith("1");
  });
});
```

## Testing components that use TanStack Query

Wrap the component in a real `QueryClientProvider` with a fresh `QueryClient` per test (disable retries so failing-request tests don't hang/slow down), rather than mocking the hook itself — this exercises the real caching/loading behavior your users experience.

```tsx
// test/utils.tsx — shared test wrapper
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

export function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
```

Mock the network boundary (the `api.ts` fetch function, or `fetch` itself via `msw`), not TanStack Query internals:

```tsx
// features/users/components/UserListClient.test.tsx
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "@/test/utils";
import { UserListClient } from "./UserListClient";
import * as api from "../api";

vi.mock("../api");

describe("UserListClient", () => {
  it("shows users once loaded", async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue([
      { id: "1", name: "Ada Lovelace", email: "ada@example.com", role: "admin" },
    ]);

    renderWithQueryClient(<UserListClient />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument());
  });

  it("shows an error state when the request fails", async () => {
    vi.mocked(api.fetchUsers).mockRejectedValue(new Error("Network error"));

    renderWithQueryClient(<UserListClient />);

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });
});
```

For apps with many API calls to mock, `msw` (Mock Service Worker) intercepting at the HTTP layer scales better than mocking each `api.ts` function individually — worth adopting once mocking `api.ts` files by hand starts feeling repetitive.

## Testing hooks in isolation

Use `renderHook` when a hook's logic is complex enough to deserve its own test, separate from any one component that happens to use it:

```ts
// features/users/hooks/useUserFilters.test.ts
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUserFilters } from "./useUserFilters";

describe("useUserFilters", () => {
  it("resets the page to 1 when the search term changes", () => {
    const { result } = renderHook(() => useUserFilters());

    act(() => result.current.setPage(3));
    act(() => result.current.setSearch("ada"));

    expect(result.current.page).toBe(1);
  });
});
```

## Testing Server Actions and pure logic

Server Actions (`"use server"` functions) and API-adjacent logic are plain async functions — test them directly without any rendering, mocking only the actual I/O boundary (database client, external API):

```ts
// features/users/actions.test.ts
import { describe, expect, it, vi } from "vitest";
import { createUserAction } from "./actions";
import { db } from "@/lib/db";

vi.mock("@/lib/db");

describe("createUserAction", () => {
  it("throws when the email is invalid", async () => {
    await expect(createUserAction({ name: "Ada", email: "not-an-email" })).rejects.toThrow();
  });

  it("creates a user with valid input", async () => {
    vi.mocked(db.user.create).mockResolvedValue({ id: "1", name: "Ada", email: "ada@example.com", role: "member", createdAt: new Date().toISOString() });

    const result = await createUserAction({ name: "Ada", email: "ada@example.com" });

    expect(result.name).toBe("Ada");
  });
});
```

## File placement and naming

Colocate test files next to the code they test: `UserCard.tsx` + `UserCard.test.tsx` in the same folder. This makes it obvious which code lacks a test (no matching `.test.tsx` file) and keeps a deleted feature's tests deleted with it. Reserve a top-level `test/` (or `__tests__/`) directory for shared test utilities (`renderWithQueryClient`, mock factories) only — not for the tests themselves.

## Running tests

Add `test` and `test:watch` scripts, and run tests in CI on every PR — a Next.js/TypeScript build passing doesn't catch behavioral regressions the way tests do:

```json
// package.json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```
