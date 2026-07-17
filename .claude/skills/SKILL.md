---
name: frontend-architecture
description: Decide exactly where a new file belongs — and what to name it — before creating it, in a Next.js (App Router)/TypeScript/TanStack Query/shadcn app. Use this every single time before running a file-creation tool in this kind of project — a new component, hook, page, API route, Server Action, schema, test, or utility. Trigger on any coding request, even something as small as "add a component," "create a hook," "make a new page," or "add a util function" — not only when the user explicitly asks about "architecture," "folder structure," or "where should this go." This is a fast lookup — check the decision table before writing any code, not after.
---

# File Placement

One rule underlies everything below: **feature code lives in `src/features/<feature>/`, routing lives in `app/`, and nothing gets promoted to a shared top-level folder until a second feature actually needs it.** If a placement decision doesn't fit the table, fall back to that rule rather than guessing.

## Before creating a file, answer in order

1. **Is it a route segment file** (`page`, `layout`, `loading`, `error`, `route`)? → It goes in `app/`, at the path matching the URL. Stop here — these have fixed names and fixed locations, not a choice.
2. **Is it feature-specific logic or UI** (a component, hook, API call, schema, Server Action, query keys) used by exactly one feature? → `src/features/<feature-name>/`, in the subfolder matching its kind (table below).
3. **Is it a shadcn/ui primitive** (Button, Dialog, Form, ...)? → Generated via `npx shadcn@latest add <name>` into `src/components/ui/`. Don't hand-place these — let the CLI do it, and don't relocate them afterward.
4. **Is it used by two or more features already** (not "might be someday")? → Promote to the matching shared top-level folder: `src/components/`, `src/hooks/`, `src/lib/`, or `src/types/`.
5. **Is it a test?** → Same folder as the file it tests, never a separate `__tests__/` tree, unless it's a shared test helper (not a test itself) — those go in `src/test/`.
6. **Still unclear?** → Default to putting it inside the feature that needs it (rule 2). It's cheap to promote a file to shared later; it's costly to guess wrong and have every feature import from one another's internals.

## Lookup table

| Creating... | Goes in | Name pattern | Example |
|---|---|---|---|
| A page | `app/<route-path>/page.tsx` | fixed: `page.tsx` | `app/users/[id]/page.tsx` |
| A layout for a route segment | `app/<route-path>/layout.tsx` | fixed: `layout.tsx` | `app/(dashboard)/layout.tsx` |
| Loading UI for a route | `app/<route-path>/loading.tsx` | fixed: `loading.tsx` | `app/users/loading.tsx` |
| Error UI for a route | `app/<route-path>/error.tsx` | fixed: `error.tsx` | `app/users/error.tsx` |
| A REST-style endpoint | `app/api/<path>/route.ts` | fixed: `route.ts` | `app/api/users/route.ts` |
| A component used by one feature | `src/features/<feature>/components/` | PascalCase | `features/users/components/UserCard.tsx` |
| A component used by 2+ features | `src/components/` | PascalCase | `src/components/ConfirmDialog.tsx` |
| A shadcn/ui primitive | `src/components/ui/` (via CLI, not by hand) | shadcn's own convention (lowercase) | `src/components/ui/button.tsx` |
| A TanStack Query hook for one feature | `src/features/<feature>/hooks/` | camelCase, `use` prefix | `features/users/hooks/useUsers.ts` |
| A hook used by 2+ features, no server data | `src/hooks/` | camelCase, `use` prefix | `src/hooks/useDebounce.ts` |
| A fetch function / client-side API call | `src/features/<feature>/api.ts` | fixed filename | `features/users/api.ts` |
| A Server Action | `src/features/<feature>/actions.ts` | fixed filename, functions inside are camelCase | `features/users/actions.ts` |
| A Zod schema + inferred type | `src/features/<feature>/schemas.ts` | fixed filename | `features/users/schemas.ts` |
| A TanStack Query key factory | `src/features/<feature>/query-keys.ts` | fixed filename | `features/users/query-keys.ts` |
| A utility function used by one feature | inside that feature (e.g. `schemas.ts`, or a small `utils.ts` in the feature root if it doesn't fit elsewhere) | camelCase | `features/orders/utils.ts` |
| A utility function used by 2+ features | `src/lib/` | camelCase or kebab-case, be consistent | `src/lib/formatDate.ts` |
| The `cn()` helper, HTTP client instance | `src/lib/` | | `src/lib/utils.ts`, `src/lib/http.ts` |
| A type/interface used by 2+ features | `src/types/` | PascalCase | `src/types/pagination.ts` |
| A test for any file above | same folder as the file it tests | `<SourceFile>.test.ts(x)` | `features/users/components/UserCard.test.tsx` |
| A shared test helper (not a test itself) | `src/test/` | descriptive, camelCase or kebab-case | `src/test/renderWithQueryClient.tsx` |
| A Vitest/Playwright/other config | project root | tool's expected filename | `vitest.config.ts` |

## When a feature is too small for subfolders

Don't create `components/`/`hooks/` subfolders inside a feature that only has one or two files of each — flat files directly under `src/features/<feature>/` are correct until there are enough files (roughly 6-8+) that a flat list gets hard to scan. Adding empty-feeling subfolders for a two-file feature is structure for its own sake, not clarity.

## Naming quick reference

| What | Convention |
|---|---|
| Components | PascalCase — `UserCard.tsx` |
| Hooks | camelCase, `use` prefix — `useUsers.ts` |
| Everything else (`api.ts`, `schemas.ts`, utils) | camelCase or kebab-case — pick one per project and stay consistent |
| Types | PascalCase, no `I`/`T` prefix — `User`, not `IUser` |

## If this doesn't match the project

This table assumes the Next.js App Router + `src/features/` layout. If an existing project already uses a different structure (e.g. `pages/` router, no `src/` directory, a different feature-folder name), match the project's existing convention instead of forcing this one — consistency with what's already there beats forcing this exact shape onto an established codebase. For the reasoning behind this structure (not just the lookup), see the `react-frontend-architecture` skill's `folder-structure.md` reference.

## Anti-patterns to flag

- Creating a new top-level folder (`utils/`, `helpers/`, `common/`) instead of using the existing `src/lib/` — multiple "misc" folders is how structure decays.
- Putting a component in `src/components/` "just in case it's reused later" when only one feature currently uses it — wait for the second consumer.
- A test file in a separate `__tests__/` tree instead of colocated with its source file.
- Hand-editing the location of a shadcn/ui-generated file instead of leaving it where the CLI put it.
