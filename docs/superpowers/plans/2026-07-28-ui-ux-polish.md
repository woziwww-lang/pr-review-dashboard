# PR Review Dashboard — UI/UX Visual & Interaction Polish Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the existing PR Review Dashboard (List Page + Detail Page) into a dark-mode-only "Modern SaaS Cards" visual design using Tailwind CSS v4 + shadcn/ui + lucide-react, and replace the "Re-check now" native-form submission with a proper client-side loading/error interaction — with zero changes to any data logic, view-model shapes, API contracts, or DB schema.

**Architecture:** Presentation-layer-only change on top of the already-shipped dashboard. Add Tailwind v4 + shadcn/ui + lucide-react as new dev/runtime dependencies; restyle existing components in place (same props); add one new shared Client Component (`RecheckButton`) that both pages use for the fetch-based recheck interaction; rebuild the two page files' JSX/markup (not their data-fetching logic).

**Tech Stack:** Next.js 16 (existing), Tailwind CSS v4 (`tailwindcss@4.3.3` + `@tailwindcss/postcss@4.3.3`), shadcn/ui CLI (installs `Button`/`Card`/`Badge` primitives + `class-variance-authority`/`clsx`/`tailwind-merge` as transitive deps), `lucide-react@1.27.0`, Vitest + Testing Library (existing).

**Spec:** `docs/superpowers/specs/2026-07-28-ui-ux-polish-design.md` — read this in full before starting; it is the source of truth for every color/spacing/behavior decision referenced below.

---

## Chunk 1: Tooling Setup — Tailwind CSS v4 + shadcn/ui + lucide-react

This chunk installs and wires up all new tooling with zero real visual
changes yet beyond the base dark palette (just proves the pipeline
works end-to-end), so later chunks are pure component work. **Every
command in this chunk has been dry-run-verified against a disposable
scratch Next.js 16 + Tailwind v4 app during plan-writing** (not just
assumed from documentation), because `shadcn@4.16.0`'s actual CLI
behavior (flags, generated file locations/imports, generated
`globals.css` shape) differs from older/commonly-assumed shadcn
versions in several ways called out below.

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm install)
- Create: `postcss.config.mjs`
- Modify: `src/app/globals.css`
- Modify: `src/app/layout.tsx` (shadcn's init step adds a couple of
  Tailwind utility classes to `<html>`/`<body>`; it does **not** touch
  the existing `Geist`/`Geist_Mono` font setup — verified empirically,
  see Step 5)
- Create: `components.json` (shadcn config)
- Create: `src/app/lib/utils.ts` (shadcn's `cn()` class-merge helper —
  deliberately placed under `src/app/lib/`, **not** `src/lib/`, so it
  does not land inside the business-logic directory the spec's
  Non-Goals says stays untouched; `src/app/lib/` is a new,
  presentation-layer-only directory)
- Create: `src/app/components/ui/button.tsx`, `card.tsx`, `badge.tsx`
  (shadcn-generated primitives, placed under the existing
  `src/app/components/` convention via a custom alias — see Step 7)

- [ ] **Step 1: Install Tailwind CSS v4**

```bash
npm install tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3
```

- [ ] **Step 2: Create the PostCSS config**

Create `postcss.config.mjs`:

```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 3: Add a minimal Tailwind entry point to `globals.css` (temporary — Step 6 replaces this with the final palette)**

Replace the entire contents of `src/app/globals.css` with just:

```css
@import "tailwindcss";
```

- [ ] **Step 4: Verify Tailwind compiles before adding shadcn**

Run: `npm run build`
Expected: build succeeds (exit 0). This isolates any Tailwind-pipeline problem from the shadcn-init step that follows.

- [ ] **Step 5: Initialize shadcn/ui with defaults (non-interactive)**

```bash
npx shadcn@4.16.0 init -d -y
```

`-d`/`--defaults` uses `--template=next --preset=base-nova` and skips
all prompts; `-y` skips the confirmation prompt. Verified behavior on a
Next.js 16 + Tailwind v4 + existing-Geist-fonts project:
- Creates `components.json` at the repo root with
  `"style": "base-nova"`, `"tailwind": { "css": "src/app/globals.css",
  "baseColor": "neutral", "cssVariables": true }`, and default aliases
  pointing at `src/components/ui`, `src/lib/utils`, etc. (these aliases
  get corrected in Step 7, below — don't edit them yet).
- Creates `src/lib/utils.ts` (the `cn()` helper) and
  `src/components/ui/button.tsx` (the default preset always includes
  `Button`) at their *default* locations — both get moved in Step 7.
- **Rewrites `src/app/globals.css` entirely** with its own `base-nova`
  theme (imports `tw-animate-css` + `shadcn/tailwind.css`, a full
  `@theme inline {...}` token map, and separate light `:root {...}` /
  `.dark {...}` OKLCH color blocks toggled by a `.dark` class) — this
  is expected; Step 6 below replaces the color values with this
  project's exact dark-only palette from the spec.
- **Modifies `src/app/layout.tsx`**: adds `h-full antialiased` classes
  to `<html>` and `min-h-full flex flex-col` to `<body>` — verified it
  does **not** remove or alter the existing `Geist`/`Geist_Mono`
  `next/font/google` calls or their `--font-geist-sans`/
  `--font-geist-mono` CSS variable names at all (confirmed by diffing a
  before/after `layout.tsx` on a project with pre-existing Geist fonts
  during plan verification). After this step, manually re-check
  `src/app/layout.tsx` and confirm the two `next/font/google` imports
  and their `variable` options are still exactly as they were before —
  if the installed shadcn version's behavior has changed and it *did*
  strip the font setup, manually restore the original two `const
  geistSans = Geist(...)` / `const geistMono = Geist_Mono(...)`
  declarations and their `variable` props on `<html>`.
- Adds `@base-ui/react`, `class-variance-authority`, `clsx`,
  `tailwind-merge`, `tw-animate-css`, `shadcn`, and `lucide-react` to
  `package.json` `dependencies` (all installed automatically by this
  one `init` command — no separate `npm install lucide-react` step is
  needed later).

- [ ] **Step 6: Move the init-created files into this project's directory convention, and fix the resulting import path**

```bash
mkdir -p src/app/lib src/app/components/ui
mv src/lib/utils.ts src/app/lib/utils.ts
mv src/components/ui/button.tsx src/app/components/ui/button.tsx
rmdir src/lib src/components/ui src/components 2>/dev/null || true
```

Then fix the import inside the moved `button.tsx` (it currently imports
`cn` from `@/lib/utils`, which no longer exists at that path):

```bash
sed -i '' 's#@/lib/utils#@/app/lib/utils#' src/app/components/ui/button.tsx
```

(On Linux, drop the empty `''` argument to `sed -i`.)

- [ ] **Step 7: Point `components.json`'s aliases at the new locations, so future `shadcn add` commands generate files in the right place**

Edit `components.json`, changing only the `aliases` object to:

```json
{
  "aliases": {
    "components": "@/app/components",
    "utils": "@/app/lib/utils",
    "ui": "@/app/components/ui",
    "lib": "@/app/lib",
    "hooks": "@/app/hooks"
  }
}
```

(Leave every other field in `components.json` — `style`, `rsc`, `tsx`,
`tailwind`, `iconLibrary`, etc. — exactly as `init` generated them.)

- [ ] **Step 8: Add the remaining two primitives**

```bash
npx shadcn@4.16.0 add card badge -y
```

Verified this creates `src/app/components/ui/card.tsx` and `badge.tsx`
directly at the corrected location, already importing `cn` from
`@/app/lib/utils` (no further path-fixing needed, since the alias
correction in Step 7 happened before this command ran).

- [ ] **Step 9: Replace `src/app/globals.css`'s color tokens with this project's exact dark-only palette**

The file at this point still has the `base-nova` light/dark toggle
structure from Step 5. Replace its entire contents with:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
  --font-heading: var(--font-geist-sans);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
  --background: #09090b;
  --foreground: #fafafa;
  --card: #18181b;
  --card-foreground: #fafafa;
  --popover: #18181b;
  --popover-foreground: #fafafa;
  --primary: #3b82f6;
  --primary-foreground: #fafafa;
  --secondary: #27272a;
  --secondary-foreground: #fafafa;
  --muted: #27272a;
  --muted-foreground: #a1a1aa;
  --accent: #27272a;
  --accent-foreground: #fafafa;
  --destructive: #dc2626;
  --border: #27272a;
  --input: #27272a;
  --ring: #3b82f6;
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --radius: 0.75rem;
  --sidebar: #18181b;
  --sidebar-foreground: #fafafa;
  --sidebar-primary: #3b82f6;
  --sidebar-primary-foreground: #fafafa;
  --sidebar-accent: #27272a;
  --sidebar-accent-foreground: #fafafa;
  --sidebar-border: #27272a;
  --sidebar-ring: #3b82f6;
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
    color-scheme: dark;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Key differences from the `base-nova` default that this intentionally
introduces:
- The separate light `:root {...}` and `.dark {...}` blocks (and the
  `@custom-variant dark (&:is(.dark *));` line that toggled between
  them) are collapsed into a **single unconditional `:root {...}`**
  block containing only the dark values from the spec's palette — this
  is what makes the app dark-mode-only with no toggle and no
  `.dark`-class dependency anywhere, per the spec.
- `--font-sans`/`--font-heading` are pointed at `var(--font-geist-sans)`
  (this project's actual existing font variable name from
  `layout.tsx`), not the generic `var(--font-sans)` `base-nova` assumes
  by default.
- `html { color-scheme: dark; }` is added, unconditionally (not inside
  any media query), so native form controls/scrollbars also render
  dark.
- Sidebar/chart tokens are left populated (matching the palette) but
  are otherwise unused dead CSS in this project — harmless, not worth
  the risk of deleting since `card.tsx`/other generated primitives may
  reference `--radius-*` values derived from the same `@theme` block.

- [ ] **Step 10: Verify the palette change compiles and existing pages still work**

Run: `npm run build && npm run lint && npm test`
Expected: build succeeds, lint reports 0 errors/0 warnings, all 106
existing tests still pass. No test or component changes have been made
yet in this chunk beyond tooling/CSS, so any failure here is a
regression from the tooling change itself and must be root-caused
before moving on. If `npm run lint` flags anything in the newly
generated `src/app/components/ui/*.tsx` files (e.g. an
`eslint-disable` needed for a generated pattern), fix it directly in
those files — this is expected/normal for freshly scaffolded code.

- [ ] **Step 11: Manually re-verify `src/app/layout.tsx` still configures Geist fonts correctly**

Run: `grep -n "Geist" src/app/layout.tsx`
Expected: both `Geist` and `Geist_Mono` imports/usages are still
present, each still setting a `variable` (`--font-geist-sans` /
`--font-geist-mono`). This is the manual check flagged in Step 5 — do
not skip it.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json postcss.config.mjs src/app/globals.css src/app/layout.tsx components.json src/app/lib/ src/app/components/ui/
git commit -m "chore: add Tailwind CSS v4 + shadcn/ui + lucide-react tooling"
```

---

## Chunk 2: `RecheckButton` Shared Component (TDD)

Build the new shared Client Component in isolation, fully tested, before wiring it into either page. This is the highest-risk piece of new logic in the whole plan (the only real behavior change, per the spec), so it gets built test-first.

**Files:**
- Create: `src/app/components/RecheckButton.tsx`
- Create: `src/app/components/RecheckButton.test.tsx`

Read first: the `forceRecheck`/`route.ts` outcome-to-status-code mapping in `src/lib/recheck.ts` and `src/app/api/recheck/[number]/route.ts` (202 `started`/`queued`, 409 `already-in-progress`, 404 not-found, 400 invalid number, 502 error) — `RecheckButton` must handle all of these from the client side using only the HTTP status + JSON body, never importing `RecheckOutcome`'s type (that's server-only lib code).

- [ ] **Step 1: Write the failing tests**

Create `src/app/components/RecheckButton.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RecheckButton } from './RecheckButton';

const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

describe('RecheckButton', () => {
  beforeEach(() => {
    mockRefresh.mockClear();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders enabled with default label when not disabled', () => {
    render(<RecheckButton prNumber={42} disabled={false} />);
    const button = screen.getByRole('button', { name: /re-check now/i });
    expect(button).toBeEnabled();
  });

  it('renders disabled when disabled prop is true', () => {
    render(<RecheckButton prNumber={42} disabled={true} />);
    const button = screen.getByRole('button', { name: /re-check now/i });
    expect(button).toBeDisabled();
  });

  it('shows a loading state while the request is in flight, then a success flash, calling refresh immediately on 202 started', async () => {
    let resolveFetch: (value: unknown) => void;
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    render(<RecheckButton prNumber={42} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(/re-checking/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-checking/i })).toBeDisabled();

    resolveFetch!({
      ok: true,
      status: 202,
      json: async () => ({ status: 'started' }),
    });

    // Success flash renders, and refresh() fires right away (not
    // delayed) - the component doesn't reset to idle on its own, since
    // it can't know when the refreshed data has landed; it waits for the
    // `disabled` prop to flip to true instead (see the next test).
    expect(await screen.findByText(/started/i)).toBeInTheDocument();
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /started/i })).toBeDisabled();
  });

  it('hands off from the success flash to the disabled prop once the parent re-renders as in-progress', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'started' }),
    });

    const { rerender } = render(<RecheckButton prNumber={42} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    await screen.findByText(/started/i);

    // Simulate the parent Server Component re-rendering with fresh data
    // (post router.refresh()) that now shows this PR as in-progress.
    rerender(<RecheckButton prNumber={42} disabled={true} />);

    const button = await screen.findByRole('button', { name: /re-check now/i });
    expect(button).toBeDisabled();
  });

  it('falls back to idle after a timeout if disabled never flips true', async () => {
    vi.useFakeTimers();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'started' }),
    });

    render(<RecheckButton prNumber={42} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    await vi.waitFor(() => screen.getByText(/started/i));

    vi.advanceTimersByTime(3000);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /re-check now/i })).toBeEnabled());

    vi.useRealTimers();
  });

  it('refreshes on 202 queued the same as 202 started', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'queued', message: 'a poll tick is already running' }),
    });

    render(<RecheckButton prNumber={7} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    await screen.findByText(/started/i);
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it('shows an inline "already in progress" message on 409 without calling refresh', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ status: 'already-in-progress' }),
    });

    render(<RecheckButton prNumber={7} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(/already in progress/i)).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows an inline error message on a 404 error response and re-enables the button', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'PR not found or no longer open' }),
    });

    render(<RecheckButton prNumber={99} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(/PR not found or no longer open/i)).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: /re-check now/i });
    expect(button).toBeEnabled();
  });

  it.each([400, 500, 502])('shows an inline error message on a %d error response', async (status) => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status,
      json: async () => ({ error: `error for status ${status}` }),
    });

    render(<RecheckButton prNumber={99} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(new RegExp(`error for status ${status}`, 'i'))).toBeInTheDocument();
  });

  it('shows a generic error message when fetch itself rejects (network failure)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));

    render(<RecheckButton prNumber={99} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /re-check now/i }));

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/components/RecheckButton.test.tsx`
Expected: FAIL — `Cannot find module './RecheckButton'` (component doesn't exist yet).

- [ ] **Step 3: Implement `RecheckButton`**

Create `src/app/components/RecheckButton.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CircleCheck } from 'lucide-react';
import { Button } from './ui/button';

type UiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success' }
  | { kind: 'already-in-progress' }
  | { kind: 'error'; message: string };

// Fallback safety net: if the parent's `disabled` prop never flips to
// true after a successful recheck (e.g. the review resolved before this
// component's next render, or a caller doesn't pass live per-PR data),
// don't get stuck showing the "Started" success state forever.
const SUCCESS_FALLBACK_TIMEOUT_MS = 3000;

export function RecheckButton({ prNumber, disabled }: { prNumber: number; disabled: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<UiState>({ kind: 'idle' });

  async function handleClick() {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/recheck/${prNumber}`, { method: 'POST' });
      const body = await res.json();

      if (res.status === 202) {
        // Both 'started' and 'queued' mean the PR will be reviewed - show
        // a brief success flash immediately, and kick off a refresh so
        // the enclosing Server Component re-fetches DB state. Do NOT
        // reset to 'idle' here: router.refresh() is fire-and-forget (it
        // doesn't return a promise we can await to know when the new
        // server data has landed), so resetting synchronously would let
        // the button flash back to "Re-check now" and become
        // re-clickable before the parent's `disabled` prop actually
        // reflects the new in-progress state. The effect below handles
        // the handoff once fresh data arrives (or a fallback timeout).
        setState({ kind: 'success' });
        router.refresh();
        return;
      }

      if (res.status === 409) {
        setState({ kind: 'already-in-progress' });
        return;
      }

      setState({ kind: 'error', message: body?.error ?? `Re-check failed (HTTP ${res.status})` });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Once the parent re-renders with `disabled: true` (meaning the
  // refreshed server data now shows this PR as in-progress), hand off
  // from our own transient "success" overlay to the parent-driven
  // disabled state. Also guards against the fallback case via a timeout.
  // Both branches schedule the state update via `setTimeout` (rather
  // than calling `setState` synchronously in the effect body) to
  // satisfy the `react-hooks/set-state-in-effect` lint rule (part of
  // this project's `eslint-config-next` core-web-vitals config, error
  // level) - calling setState directly and synchronously within an
  // effect body triggers a same-commit cascading re-render, which the
  // rule flags even when, as here, the update is otherwise correct and
  // intentional. A `0ms` timeout for the `disabled: true` branch defers
  // the update by one tick (imperceptible to the user - `findBy`/
  // `waitFor` queries in tests correctly await it) without changing the
  // actual handoff behavior.
  useEffect(() => {
    if (state.kind !== 'success') return;
    if (disabled) {
      const id = setTimeout(() => setState({ kind: 'idle' }), 0);
      return () => clearTimeout(id);
    }
    const timeout = setTimeout(() => setState({ kind: 'idle' }), SUCCESS_FALLBACK_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [disabled, state.kind]);

  const isLoading = state.kind === 'loading' || state.kind === 'success';

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        onClick={handleClick}
        disabled={disabled || isLoading}
        size="sm"
        className="border-transparent bg-gradient-to-r from-[#3B82F6] to-[#2563EB] text-white hover:opacity-90 disabled:opacity-50"
      >
        {state.kind === 'loading' && (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Re-checking…
          </>
        )}
        {state.kind === 'success' && (
          <>
            <CircleCheck className="h-4 w-4" />
            Started
          </>
        )}
        {state.kind !== 'loading' && state.kind !== 'success' && 'Re-check now'}
      </Button>
      {state.kind === 'already-in-progress' && (
        <span className="text-xs text-muted-foreground">Already in progress</span>
      )}
      {state.kind === 'error' && <span className="text-xs text-red-400">{state.message}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/components/RecheckButton.test.tsx`
Expected: PASS (12/12 tests — vitest counts each `it.each` case separately). If the exact count differs slightly due to a vitest version difference in how `it.each` is reported, that is fine — what matters is 0 failures.

Note: if `Button`'s generated shadcn markup doesn't preserve the accessible name across the loading-state's `<Loader2>` + text children (e.g. because of how `asChild`/icon slots render), adjust the test's `name` matcher or the button's children structure — but do not weaken the assertion that the button is disabled and shows "Re-checking…" text while loading.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all previous tests (106) + these new `RecheckButton` tests pass (118 total).

- [ ] **Step 6: Commit**

```bash
git add src/app/components/RecheckButton.tsx src/app/components/RecheckButton.test.tsx
git commit -m "feat: add RecheckButton client component with fetch-based recheck flow"
```

---

## Chunk 3: Restyle `VerdictBadge` and `SeverityBadge`

Full 4-value color mappings per spec, using shadcn's `Badge` component. Props interfaces are unchanged, so existing tests must keep passing without modification (only add new assertions if genuinely needed for new visual states — there are none here, since all 4 values already had tests).

**Files:**
- Modify: `src/app/components/VerdictBadge.tsx`
- Modify: `src/app/components/SeverityBadge.tsx`
- Read (do not modify unless a selector breaks): `src/app/components/VerdictBadge.test.tsx`, `src/app/components/SeverityBadge.test.tsx`

- [ ] **Step 1: Confirm existing tests pass before touching markup (baseline)**

Run: `npx vitest run src/app/components/VerdictBadge.test.tsx src/app/components/SeverityBadge.test.tsx`
Expected: PASS (baseline, before any change).

- [ ] **Step 2: Restyle `VerdictBadge`**

Replace `src/app/components/VerdictBadge.tsx`:

```tsx
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { Badge } from './ui/badge';

export type BadgeVerdict = 'approve' | 'needs_fix' | 'needs_review' | 'failed';

const LABELS: Record<BadgeVerdict, string> = {
  approve: 'Approve',
  needs_fix: 'Needs Fix',
  needs_review: 'Needs Review',
  failed: 'Review Failed',
};

// approve gets CircleCheck; every other verdict (a real problem needing
// attention, or the review process itself erroring) gets TriangleAlert -
// per the spec's icon list (CircleCheck for approve, TriangleAlert for
// needs_review/needs_fix/failed and error banners).
const ICONS: Record<BadgeVerdict, typeof CircleCheck> = {
  approve: CircleCheck,
  needs_review: TriangleAlert,
  needs_fix: TriangleAlert,
  failed: TriangleAlert,
};

// Gradients for real review verdicts; a flat neutral gray for 'failed'
// (the review process itself errored - not a code-quality verdict - so
// it must look visually distinct from needs_fix's red gradient).
const CLASSES: Record<BadgeVerdict, string> = {
  approve: 'bg-gradient-to-r from-[#22C55E] to-[#16A34A] text-white border-transparent',
  needs_review: 'bg-gradient-to-r from-[#FBBF24] to-[#F59E0B] text-[#451A03] border-transparent',
  needs_fix: 'bg-gradient-to-r from-[#F87171] to-[#DC2626] text-white border-transparent',
  failed: 'bg-[#3F3F46] text-[#A1A1AA] border-transparent',
};

export function VerdictBadge({ verdict }: { verdict: BadgeVerdict }) {
  const Icon = ICONS[verdict];
  return (
    <Badge className={CLASSES[verdict]}>
      <Icon className="h-3 w-3" />
      {LABELS[verdict]}
    </Badge>
  );
}
```

- [ ] **Step 3: Restyle `SeverityBadge`**

Replace `src/app/components/SeverityBadge.tsx`:

```tsx
import { Badge } from './ui/badge';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

// Solid (non-gradient) fills, deliberately distinct from VerdictBadge's
// gradients so severity vs. verdict remain visually distinguishable at
// a glance.
const CLASSES: Record<Severity, string> = {
  CRITICAL: 'bg-[#991B1B] text-[#FECACA] border-transparent',
  HIGH: 'bg-[#F87171] text-[#450A0A] border-transparent',
  MEDIUM: 'bg-[#FBBF24] text-[#451A03] border-transparent',
  LOW: 'bg-[#3F3F46] text-[#D4D4D8] border-transparent',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge className={`${CLASSES[severity]} text-xs`}>{severity}</Badge>;
}
```

- [ ] **Step 4: Run the same tests again to confirm no regressions**

Run: `npx vitest run src/app/components/VerdictBadge.test.tsx src/app/components/SeverityBadge.test.tsx`
Expected: PASS, same assertions as Step 1 (text-content queries like `getByText(/approve/i)` don't depend on styling, so no test changes should be needed).

- [ ] **Step 5: Commit**

```bash
git add src/app/components/VerdictBadge.tsx src/app/components/SeverityBadge.tsx
git commit -m "style: restyle VerdictBadge and SeverityBadge with full 4-value gradient/solid mappings"
```

---

## Chunk 4: Restyle `PollStatusBanner` and `FindingCard`

Same pattern: same props, visual-only change, existing tests must keep passing (update only if a specific DOM-structure assertion, not a text assertion, breaks).

**Files:**
- Modify: `src/app/components/PollStatusBanner.tsx`
- Modify: `src/app/components/FindingCard.tsx`
- Read (do not modify unless a selector breaks): `src/app/components/PollStatusBanner.test.tsx`, `src/app/components/FindingCard.test.tsx`

- [ ] **Step 1: Confirm baseline tests pass**

Run: `npx vitest run src/app/components/PollStatusBanner.test.tsx src/app/components/FindingCard.test.tsx`
Expected: PASS (baseline).

- [ ] **Step 2: Restyle `PollStatusBanner`**

Replace `src/app/components/PollStatusBanner.tsx`:

```tsx
import { TriangleAlert } from 'lucide-react';

export function PollStatusBanner({
  lastPollAt,
  lastPollStatus,
  lastPollError,
}: {
  lastPollAt: string | null;
  lastPollStatus: 'ok' | 'error' | null;
  lastPollError: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">Last poll: {lastPollAt ?? 'never'}</p>
      {lastPollStatus === 'error' && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[#451A03] bg-[#FBBF24]/10 px-3 py-2 text-sm text-[#FBBF24]"
        >
          <TriangleAlert className="h-4 w-4 shrink-0" />
          Last poll failed: {lastPollError}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Restyle `FindingCard`**

Replace `src/app/components/FindingCard.tsx`:

```tsx
import { SeverityBadge, type Severity } from './SeverityBadge';

export interface FindingCardInput {
  file: string;
  line: number;
  severity: Severity;
  summary: string;
  failureScenario: string;
  evidence: string;
  fixSuggestion: string;
  codeSnippet: string;
}

// Left border color keyed to severity - independent of SeverityBadge's
// own color mapping so this can use plain border-left CSS instead of
// duplicating the Tailwind color classes.
const BORDER_COLORS: Record<Severity, string> = {
  CRITICAL: '#991B1B',
  HIGH: '#F87171',
  MEDIUM: '#FBBF24',
  LOW: '#3F3F46',
};

export function FindingCard({ finding }: { finding: FindingCardInput }) {
  return (
    <div
      className="mb-2 rounded-lg border border-[#27272A] bg-[#18181B] p-3 pl-4"
      style={{ borderLeft: `3px solid ${BORDER_COLORS[finding.severity]}` }}
    >
      <div className="mb-1 flex items-center gap-2">
        <SeverityBadge severity={finding.severity} /> <strong className="text-[#FAFAFA]">{finding.summary}</strong>
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        {finding.file}:{finding.line}
      </p>
      <p className="mt-2 text-sm text-[#D4D4D8]">
        <em>Failure scenario:</em> {finding.failureScenario}
      </p>
      <p className="mt-1 text-sm text-[#D4D4D8]">
        <em>Evidence:</em> {finding.evidence}
      </p>
      <p className="mt-1 text-sm text-[#D4D4D8]">
        <em>Fix:</em> {finding.fixSuggestion}
      </p>
      <pre className="mt-2 overflow-x-auto rounded bg-[#09090B] p-2 font-mono text-xs">{finding.codeSnippet}</pre>
    </div>
  );
}
```

- [ ] **Step 4: Run the same tests again to confirm no regressions**

Run: `npx vitest run src/app/components/PollStatusBanner.test.tsx src/app/components/FindingCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/PollStatusBanner.tsx src/app/components/FindingCard.tsx
git commit -m "style: restyle PollStatusBanner and FindingCard"
```

---

## Chunk 5: Rebuild the List Page (`src/app/page.tsx`)

Replace the native `<table>` with stacked shadcn `Card` rows, wire in `RecheckButton`. Data-fetching logic (`buildListPageViewModel`, `getOpenPrs`, `getConfig`) is untouched.

**Files:**
- Modify: `src/app/page.tsx`

There is currently no `page.test.tsx` for this file (it's a Server Component doing direct DB reads, exercised only via the manual-verification pattern established in the original build, per the spec's Testing Strategy — no new test file is required here).

- [ ] **Step 1: Read the current file in full**

The current `src/app/page.tsx` (before this chunk's changes) is:

```tsx
import Link from 'next/link';
import { getDb } from '../db/client';
import { getConfig } from '../db/config';
import { getOpenPrs } from '../db/pullRequests';
import { buildListPageViewModel } from '../lib/listPageViewModel';
import { VerdictBadge } from './components/VerdictBadge';
import { PollStatusBanner } from './components/PollStatusBanner';

export const dynamic = 'force-dynamic';

export default function ListPage() {
  const db = getDb();
  const repo = getConfig(db, 'target_repo') ?? '(not configured)';
  const vm = buildListPageViewModel({
    repo,
    lastPollAt: getConfig(db, 'last_poll_at') ?? null,
    lastPollStatus: (getConfig(db, 'last_poll_status') as 'ok' | 'error' | undefined) ?? null,
    lastPollError: getConfig(db, 'last_poll_error') ?? null,
    prs: getOpenPrs(db, repo),
  });

  return (
    <main>
      <h1>{vm.repo}</h1>
      <PollStatusBanner lastPollAt={vm.lastPollAt} lastPollStatus={vm.pollStatus} lastPollError={vm.pollError} />
      <table>
        {/* ...native <table> with one <tr> per row, a full-cell <Link>
            per data cell (so clicking any cell navigates to the detail
            page), and a plain <form method="post"> "Re-check now" button
            in the last cell - this whole <table> is replaced below. */}
      </table>
    </main>
  );
}
```

Re-view the actual file with the `view` tool before editing to confirm it matches this (catch any drift since this plan was written).

- [ ] **Step 2: Replace `src/app/page.tsx`**

```tsx
import Link from 'next/link';
import { getDb } from '../db/client';
import { getConfig } from '../db/config';
import { getOpenPrs } from '../db/pullRequests';
import { buildListPageViewModel } from '../lib/listPageViewModel';
import { VerdictBadge } from './components/VerdictBadge';
import { PollStatusBanner } from './components/PollStatusBanner';
import { RecheckButton } from './components/RecheckButton';
import { Card } from './components/ui/card';

export const dynamic = 'force-dynamic';

export default function ListPage() {
  const db = getDb();
  const repo = getConfig(db, 'target_repo') ?? '(not configured)';
  const vm = buildListPageViewModel({
    repo,
    lastPollAt: getConfig(db, 'last_poll_at') ?? null,
    lastPollStatus: (getConfig(db, 'last_poll_status') as 'ok' | 'error' | undefined) ?? null,
    lastPollError: getConfig(db, 'last_poll_error') ?? null,
    prs: getOpenPrs(db, repo),
  });

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-[#FAFAFA]">{vm.repo}</h1>
        <div className="mt-3">
          <PollStatusBanner lastPollAt={vm.lastPollAt} lastPollStatus={vm.pollStatus} lastPollError={vm.pollError} />
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {vm.rows.map((row) => (
          <Card
            key={row.prNumber}
            className={`relative flex flex-col items-stretch gap-3 border-[#27272A] bg-[#18181B] p-4 transition-colors duration-200 ease-out hover:border-[#3B82F6]/40 sm:flex-row sm:items-center sm:justify-between ${
              row.isInProgress ? 'opacity-70' : ''
            }`}
          >
            {/* Full-card clickable overlay: an absolutely-positioned
                <Link> stretched to cover the entire card (inset-0).
                This is a real, keyboard-focusable, tabbable link (no
                `tabIndex={-1}` - removing it from tab order would make
                the card unreachable by keyboard) with an sr-only label
                for screen readers. The visible content wrapper below it
                has `pointer-events-none` so mouse clicks/taps pass
                *through* the content (title, branch, author, verdict,
                severity count, and the gaps between them) straight to
                this overlay underneath - the content is still visually
                on top (z-[1] > z-0) and fully legible/selectable-looking,
                it just doesn't intercept clicks itself. RecheckButton is
                wrapped in its own `relative z-10 pointer-events-auto`
                container so it re-enables pointer events and sits above
                everything, remaining independently clickable - an
                interactive <button> nested inside an <a> would be
                invalid HTML/inaccessible, so this overlay approach keeps
                them as non-nested siblings while still covering the
                full card for every other click target. */}
            <Link
              href={`/pr/${row.prNumber}`}
              className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B82F6]"
            >
              <span className="sr-only">
                View PR #{row.prNumber}: {row.title}
              </span>
            </Link>

            <div className="pointer-events-none relative z-[1] flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-muted-foreground">#{row.prNumber}</span>
                  <span className="font-medium text-[#FAFAFA]">{row.title}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{row.branch}</span>
                  <span>{row.author}</span>
                  <span>Last reviewed {row.lastReviewedAt ?? '-'}</span>
                </div>
              </div>

              <div className="flex items-center gap-4">
                {row.isInProgress ? (
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-[#3B82F6]" />
                    Reviewing…
                  </span>
                ) : (
                  <VerdictBadge verdict={row.badgeVerdict} />
                )}
                {/* Severity count reflects the last *successful* review
                    (per listPageViewModel's comment on criticalHighCount)
                    and stays visible even mid-recheck, since it's still
                    meaningful reference data while a new review runs.
                    Falls back to '-' (matching the original table cell's
                    behavior) rather than disappearing when null. */}
                <span className="text-sm text-muted-foreground">Crit+High: {row.criticalHighCount ?? '-'}</span>
              </div>
            </div>

            <div className="relative z-10 pointer-events-auto">
              <RecheckButton prNumber={row.prNumber} disabled={row.isInProgress} />
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Run full verification**

Run: `npm run build && npm run lint && npm test`
Expected: build succeeds, lint clean, all tests still pass (this file has no dedicated test, so this step is verifying no other test broke — e.g. any test that imports `page.tsx` indirectly).

- [ ] **Step 4: Manual visual check**

Start the dev server in the background: `npm run dev &` (or use a separate terminal/async shell). **Note:** on first boot, `instrumentation.ts`'s `register()` hook blocks all incoming HTTP requests until it finishes an initial poll tick over every open PR in the configured `TARGET_REPO` (a real, previously-verified architectural characteristic of this Next.js app, not a bug) — this can take anywhere from under a minute (few/no open PRs) to 10+ minutes (many open PRs each requiring a multi-minute `copilot -p` review). Wait for the server to actually respond (poll with `curl -sf http://localhost:3000 -o /dev/null -w '%{http_code}\n'` every 15-30s until it returns `200`) before treating "no response" as an error. Once responsive, open the List Page and visually confirm: cards render, verdict/severity colors match the spec's palette, clicking anywhere on a card except the "Re-check now" button navigates to that PR's detail page, and the in-progress treatment (opacity + pulsing dot + "Reviewing…") is visible if any PR is currently mid-review. Stop the dev server afterward (`kill <PID>`, do not leave it running).

- [ ] **Step 5: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: rebuild List Page with Modern SaaS Cards style and RecheckButton"
```

---

## Chunk 6: Rebuild the Detail Page (`src/app/pr/[number]/page.tsx`)

Same pattern: restyle with `Card`s, add the "← Back to list" link, wire `RecheckButton` with a page-computed `disabled` value derived from the raw `PullRequestRow` (not a `DetailPageViewModel` change).

**Files:**
- Modify: `src/app/pr/[number]/page.tsx`

- [ ] **Step 1: Replace `src/app/pr/[number]/page.tsx`**

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { getDb } from '../../../db/client';
import { getConfig } from '../../../db/config';
import { getByNumber } from '../../../db/pullRequests';
import { getFindingsByPrId } from '../../../db/findings';
import { buildDetailPageViewModel } from '../../../lib/detailPageViewModel';
import { VerdictBadge } from '../../components/VerdictBadge';
import { FindingCard } from '../../components/FindingCard';
import { RecheckButton } from '../../components/RecheckButton';
import { Card } from '../../components/ui/card';

export const dynamic = 'force-dynamic';

export default async function DetailPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const db = getDb();
  const repo = getConfig(db, 'target_repo') ?? '(not configured)';
  const prNumber = Number(number);
  const pr = getByNumber(db, repo, prNumber);
  if (!pr) {
    notFound();
  }

  const findings = getFindingsByPrId(db, pr.id);
  const vm = buildDetailPageViewModel(pr, findings);
  // Page-level presentational computation, not a DetailPageViewModel
  // field - `pr` (the raw PullRequestRow) is already in scope here from
  // getByNumber() above, so no view-model shape change is needed to
  // give RecheckButton the in-progress signal it needs to disable itself.
  const isInProgress = pr.review_status === 'pending' || pr.review_status === 'reviewing';

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <Link href="/" className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-[#FAFAFA]">
        <ArrowLeft className="h-4 w-4" />
        Back to list
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold text-[#FAFAFA]">
          <span className="font-mono text-muted-foreground">#{vm.prNumber}</span> {vm.title}
        </h1>
        <RecheckButton prNumber={vm.prNumber} disabled={isInProgress} />
      </div>

      {vm.failureBanner && vm.state === 'failed-with-prior-success' && (
        <Card
          role="alert"
          className="flex items-start gap-2 border-[#451A03] bg-[#FBBF24]/10 p-4 text-sm text-[#FBBF24]"
        >
          <TriangleAlert className="h-4 w-4 shrink-0 translate-y-0.5" />
          <span>
            Latest re-check failed at {vm.failureBanner.lastAttemptedAt}: {vm.failureBanner.errorMessage}. Showing
            results from the last successful review ({vm.failureBanner.lastReviewedAt}, commit{' '}
            {vm.failureBanner.reviewedHeadSha}).
          </span>
        </Card>
      )}

      {vm.failureBanner && vm.state === 'failed-no-prior-success' && (
        <Card
          role="alert"
          className="flex items-start gap-2 border-[#450A0A] bg-[#F87171]/10 p-4 text-sm text-[#F87171]"
        >
          <TriangleAlert className="h-4 w-4 shrink-0 translate-y-0.5" />
          <span>
            Review failed at {vm.failureBanner.lastAttemptedAt}: {vm.failureBanner.errorMessage}. No successful review
            yet.
          </span>
        </Card>
      )}

      {vm.state !== 'failed-no-prior-success' && (
        <>
          <Card className="flex flex-col gap-2 border-[#27272A] bg-[#18181B] p-4">
            <h2 className="text-sm font-medium text-muted-foreground">Executive Summary</h2>
            {/* Note: DetailPageViewModel has no separate free-text
                "summary" field (verified against src/lib/detailPageViewModel.ts)
                - the verdict badge + severity counts below *are* the
                executive summary. No view-model change is made to
                introduce a summary-text field, per the spec's Non-Goals. */}
            {vm.verdict && <VerdictBadge verdict={vm.verdict as 'approve' | 'needs_fix' | 'needs_review'} />}
            <p className="text-sm text-[#D4D4D8]">
              Critical: {vm.severityCritical}, High: {vm.severityHigh}, Medium: {vm.severityMedium}, Low:{' '}
              {vm.severityLow}
            </p>
          </Card>

          <Card className="flex flex-col gap-2 border-[#27272A] bg-[#18181B] p-4">
            <h2 className="text-sm font-medium text-muted-foreground">Top Risks</h2>
            {vm.topRisks.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </Card>

          <Card className="flex flex-col gap-2 border-[#27272A] bg-[#18181B] p-4 opacity-80">
            <h2 className="text-sm font-medium text-muted-foreground">Medium/Low</h2>
            {vm.mediumLow.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </Card>

          {vm.rawReportMd && (
            <details className="rounded-lg border border-[#27272A] bg-[#18181B] p-4">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground">Raw report</summary>
              <pre className="mt-2 overflow-x-auto text-xs">{vm.rawReportMd}</pre>
            </details>
          )}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Run full verification**

Run: `npm run build && npm run lint && npm test`
Expected: build succeeds, lint clean, all tests pass.

- [ ] **Step 3: Manual visual check**

With `npm run dev` running (same caveats as Chunk 5 Step 4), open a detail page for a real PR and confirm: back link works, executive summary/top risks/medium-low/raw-report render correctly, failure banners (if applicable to any seeded PR) render in the warning/danger card style, and the recheck button shows its loading state on click and disables correctly if the PR is mid-review. Stop the dev server afterward.

- [ ] **Step 4: Commit**

```bash
git add "src/app/pr/[number]/page.tsx"
git commit -m "feat: rebuild Detail Page with card styling, back link, and RecheckButton"
```

---

## Chunk 7: Final Verification and Wrap-Up

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (106 original + 12 new `RecheckButton` tests = 118 total). Record the exact pass count in your completion report — do not estimate.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: exit code 0, no errors.

- [ ] **Step 4: Full manual walkthrough against real (or realistically seeded) data**

Follow the same manual-verification pattern established in the original 27-task dashboard-implementation plan (seed a temp SQLite DB or point at a real configured `TARGET_REPO`, start `npm run dev`, and wait for the server to respond before treating "no response" as an error):

- Next.js's `instrumentation.ts`/`instrumentation-node.ts` `register()` hook is awaited by Next.js *before it begins accepting/serving any HTTP requests* (Next's own documented contract). This project's `register()` implementation runs `await withPollLock(() => runPollTick(db, repo))`, which processes every pending/open PR **sequentially** via `copilot -p` (each taking anywhere from under a minute to 7+ minutes). This means a repo with many open PRs makes the whole dev server unresponsive (connections just hang, no HTTP response at all) for potentially 10+ minutes on every fresh process start — this is a pre-existing, already-reviewed architectural characteristic of the original implementation, not something this UI/UX plan introduces or needs to fix.
- To verify quickly without waiting out a real poll tick, seed a temp SQLite DB directly with rows covering all needed states (see `src/db/pullRequests.ts` for the `PullRequestRow` shape and `upsertOpenPr`/`markPending`/`markDone`/`markFailed` for how to construct valid rows) before starting `npm run dev`, so the initial poll tick has few/no genuinely-pending rows to process and the server becomes responsive quickly.
- Poll for responsiveness with `curl -sf http://localhost:3000 -o /dev/null -w '%{http_code}\n'` every 15-30s until it returns `200`, instead of assuming a fixed wait time.

Once responsive, exercise both pages:
- List Page: verify card layout, all 4 verdict-badge colors (trigger by seeding rows covering each `review_status`/`verdict` combination that `buildListRowViewModel` maps to a distinct `badgeVerdict` — `review_status='done'` with `verdict='approve'`/`'needs_review'`/`'needs_fix'`, and `review_status='failed'` — if no real PR naturally covers all 4; `badgeVerdict` itself is a derived value from `src/lib/listPageViewModel.ts`, not a DB column, so seed the underlying `review_status`/`verdict` columns, not a `badgeVerdict` field directly), the in-progress pulsing-dot treatment (seed a row with `review_status IN ('pending', 'reviewing')` **only after** the dev server has finished starting and is responding to `curl` — `register()` in `src/instrumentation-node.ts` runs `resetStuckReviews()` once at process startup, which flips any `pending`/`reviewing` row to `failed` before the server ever serves a request, so a row seeded *before* startup will not show the in-progress treatment; reload the List Page after seeding to see it), and clicking "Re-check now" (watch the loading spinner, then the success flash, then the page reflecting the new in-progress state after `router.refresh()`).
- Detail Page: verify the back link navigates to `/`, all sections render, the failed-state banners render correctly (seed a `review_status='failed'` row if no real PR is currently in that state), and the `RecheckButton`'s inline error path: click "Re-check now" on a PR row whose underlying DB row you've deleted (or renumbered) *after* the page was server-rendered but before the button is clicked, so the client-side `fetch('/api/recheck/<n>')` call hits the real route and gets back a genuine `404` (`{ error: 'PR not found or no longer open' }`) for the button to render inline — do not rely on directly navigating to a nonexistent PR's detail page URL (that hits `notFound()` in the page component itself, per `src/app/pr/[number]/page.tsx`, and never reaches `RecheckButton` at all) or on curling `/api/recheck/` out-of-band (that verifies the API in isolation, not that the button's own fetch/response-parsing/rendering code path works).
- Confirm `prefers-reduced-motion: reduce` (toggle via browser devtools' rendering emulation panel) actually disables/shortens the card-hover and spinner transitions.
- Kill the dev server and remove any temp DB files afterward — leave no lingering processes or artifacts.

- [ ] **Step 5: Dispatch a `code-review` subagent for a final holistic review**

Provide the subagent with: the diff since the merge-base with `main` before Chunk 1 started (or since commit `c3783ac`, the last commit before this plan's work began), the spec (`docs/superpowers/specs/2026-07-28-ui-ux-polish-design.md`), and this plan file. Ask it to verify: no data/view-model/API contract changes occurred (grep the diff for any change under `src/lib/*ViewModel.ts`, `src/db/`, `src/app/api/`, `src/instrumentation*.ts` — there should be none), all existing test assertions on data/text still hold, and the new `RecheckButton` interaction handles all 5 documented response cases (202 started, 202 queued, 409, 404/502/400/500, and network-level fetch rejection).

- [ ] **Step 6: Fix any issues the reviewer raises, re-run Steps 1-3, and re-dispatch until ✅ Approved** (same review-loop pattern as the brainstorming/writing-plans skills — max 5 iterations before surfacing to the user for guidance).

- [ ] **Step 7: Final commit (if any fixes were made in Step 6) and report to the user**

Report: final test count, lint/build status, confirmation that no data-layer files changed (`git diff --stat c3783ac..HEAD -- src/lib src/db src/app/api src/instrumentation*.ts` should show no output), and a summary of what was visually verified in Step 4.
