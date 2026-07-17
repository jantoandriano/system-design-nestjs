# shadcn/ui Patterns

## What shadcn/ui actually is

Not an npm component library — the CLI copies component source directly into your project (`components/ui/`). That means:

- **You own and can edit that code.** It's normal to tweak a generated component; don't treat `components/ui/` as untouchable vendor code.
- **Don't hand-write a component shadcn already provides.** Before building a custom modal, dropdown, tooltip, combobox, or toast, check `npx shadcn@latest add <component>` first — reinventing these loses the accessibility work (focus trapping, ARIA, keyboard nav) already built in via Radix primitives.
- Adding a component: `npx shadcn@latest add button dialog form` — this generates the files; it doesn't add a runtime dependency the way installing a package does.

## The `cn()` utility

Every project using shadcn has a `cn()` helper (in `lib/utils.ts`) combining `clsx` and `tailwind-merge`. Use it any time a component accepts a `className` override or combines conditional classes — it resolves Tailwind class conflicts (e.g. two different `px-*` values) correctly, which plain string concatenation doesn't.

```ts
// lib/utils.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

```tsx
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-lg border p-4 shadow-sm", className)} {...props} />;
}
```

## Composition over configuration

shadcn components favor being composed from small parts over one component with a dozen props. Follow the same shape for custom components built on top of them, instead of collapsing everything into a giant prop list.

```tsx
// Prefer — composable
<Card>
  <CardHeader>
    <CardTitle>User settings</CardTitle>
    <CardDescription>Manage your account preferences</CardDescription>
  </CardHeader>
  <CardContent>{/* ... */}</CardContent>
</Card>

// Avoid — one component absorbing every possible variation via props
<Card title="User settings" description="Manage your account preferences" content={...} />
```

## Variants with `cva` (class-variance-authority)

When a component needs multiple visual variants (size, intent/color, state), use `cva` rather than a chain of ternaries in the `className`. This is the same pattern shadcn's own `Button` uses — extend it rather than inventing a different variant mechanism elsewhere in the app.

```tsx
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground",
      success: "bg-green-100 text-green-800",
      destructive: "bg-destructive/10 text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
});

type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
```

## Forms: React Hook Form + Zod + shadcn `Form`

This is the standard shadcn form pattern — one Zod schema drives both validation and the TypeScript type, `useForm` wires it to React Hook Form, and shadcn's `Form*` components handle label/error/description wiring and accessibility automatically.

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useCreateUser } from "../hooks/useCreateUser";

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email"),
});

type FormValues = z.infer<typeof formSchema>;

export function CreateUserForm() {
  const { mutate, isPending } = useCreateUser();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", email: "" },
  });

  function onSubmit(values: FormValues) {
    mutate(values, { onSuccess: () => form.reset() });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="you@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating..." : "Create user"}
        </Button>
      </form>
    </Form>
  );
}
```

Reuse the same `formSchema` (or a variant via `.extend()`/`.omit()`) for the mutation's input type in `schemas.ts`, so the form's validated shape and the API's expected payload can't drift apart.

## Theming

shadcn themes via CSS variables in `globals.css` (`--background`, `--primary`, `--destructive`, etc.), consumed through Tailwind's `hsl(var(--primary))`-style config — not hardcoded hex/Tailwind color classes like `bg-blue-500` sprinkled through components. Use the semantic token (`bg-primary`, `text-muted-foreground`, `border-destructive`) so a theme change or dark-mode toggle updates every component automatically.

```tsx
// Prefer — semantic, theme-aware
<p className="text-muted-foreground">Last updated 2 days ago</p>

// Avoid — bypasses the theme
<p className="text-gray-500">Last updated 2 days ago</p>
```

## Feedback patterns

- **Toasts** for transient, non-blocking feedback (mutation succeeded, item deleted, copied to clipboard) — use shadcn's `sonner` or `toast` component, don't build a custom notification system.
- **Inline `FormMessage`/alert** for validation and errors the user needs to act on before continuing.
- **`Skeleton`** components for loading state on content that has a predictable shape (a card, a table row) — more polished than a bare spinner, and pairs naturally with TanStack Query's `isPending`.
- **`AlertDialog`** (not `Dialog`) for destructive confirmations ("Delete this user?") — it's built for exactly that interruption pattern and forces an explicit choice.

## Accessibility comes for free — don't undo it

shadcn's components are built on Radix UI primitives, which already handle focus trapping, keyboard navigation, and ARIA attributes correctly. When customizing a generated component, keep the underlying Radix primitive and its props intact (don't replace `<Dialog>`'s Radix root with a plain `<div>` to "simplify" it) — that's how accessibility regressions creep in.
