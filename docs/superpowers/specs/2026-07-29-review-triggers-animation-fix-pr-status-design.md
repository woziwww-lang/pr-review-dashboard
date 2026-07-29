# Review Triggers Confirmation, List Page Animation Fix, and PR Status Tracking

Date: 2026-07-29

## Context

Three requests came in for pr-review-dashboard:

1. Confirm that auto-review only triggers for a brand-new PR or a new commit on
   an existing PR, and never on every 5-minute poll tick otherwise.
2. Fix a bug where returning to the list page from a PR detail page (via the
   in-app "Back to list" link) sometimes leaves the PR cards nearly invisible
   (very low opacity), even though a hard refresh of the list page looks fine.
3. Show more PR status detail on the list — specifically, keep merged/closed
   PRs visible for a while (instead of disappearing immediately) with a
   status badge, distinguishing "merged" from "closed without merging".

## 1. Auto-review trigger confirmation — no code change

`src/lib/decision.ts`'s `decidePrAction()` already implements exactly the
desired behavior:

- `reviewStatus === null` (brand new PR) → `enqueue`
- `reviewStatus` is `'pending'` or `'reviewing'` (already in flight) → `skip`
  (single-flight)
- Otherwise (`'done'`/`'failed'`), only `enqueue` if `head_sha` changed since
  last tracked; else `skip`.

Every 5-minute cron tick (`src/instrumentation-node.ts`) and every manual
poll still goes through this same decision function
(`src/lib/poller.ts::runPollTick`), so a PR with no new commits is never
silently re-reviewed. The only other trigger is a manual click on
"Re-check now" (`POST /api/recheck/[number]`, `src/lib/recheck.ts`), which
explicitly bypasses this decision (as intended for a manual action).

**No changes are needed for this item.** This section exists purely to
document/confirm the current (correct) behavior for future reference.

## 2. List page fade-in animation getting stuck ("dark cards" bug)

### Root cause

`StaggerReveal` (`src/app/components/StaggerReveal.tsx`) runs a one-shot
GSAP entrance animation on mount:

```ts
gsap.from(el.children, { opacity: 0, y: 8, duration: 0.35, ease: 'power1.out', stagger: 0.05 });
```

This was reproduced live against the running dashboard: navigating from the
list page to a PR detail page and back via the in-app "Back to list" link can
leave the list's card elements with inline styles frozen mid-tween (observed
real values like `opacity: 0.0171`–`0.0674`, confirmed to never progress
further even after waiting). There is no console error — the tween simply
never reaches completion once interrupted, and nothing ever resets the
resulting stale inline styles back to the natural (opacity: 1) state.

The `useEffect` in `StaggerReveal` has no cleanup function at all, so nothing
guards against this class of interruption regardless of what
Next.js/React-internal navigation/caching behavior triggers it.

### Fix (defense in depth)

In `StaggerReveal.tsx`:

1. **Cleanup on unmount**: return a cleanup function from the effect that
   kills any in-flight tween on `el.children` and clears the animation's
   inline styles back to their natural values (`opacity: 1`, no transform),
   so an interrupted animation never leaves stale partial styles behind for
   whatever comes next.
2. **Safety-net timer**: alongside the tween, start a `setTimeout` slightly
   longer than the animation's total duration (`0.35s` + stagger delay for
   the last child, plus margin) that force-clears the same inline styles if
   the tween's `onComplete` hasn't already fired by then. This guarantees
   cards can never be stuck at a partial/invisible opacity indefinitely,
   regardless of the exact interruption mechanism.

`HoverLiftCard.tsx` is lower-risk (it only reacts to hover events, it never
sets an initial "from" opacity), so no change is planned there, but the same
pattern should be considered if a similar bug is ever reported for it.

### Testing

- Manual verification: reproduce the repro steps used during root-cause
  investigation (rapid navigation into a PR and back via "Back to list"
  before the stagger animation finishes) and confirm cards render at full
  opacity afterward.
- No new automated test infra is proposed for this purely visual/animation
  fix, consistent with the rest of the codebase's testing scope (GSAP
  wrapper components currently have no unit tests).

## 3. PR status detail: merged/closed retention + badges

### Data model changes (`src/db/schema.sql`)

- Add `closed_at TEXT` column to `pull_requests` (nullable; set once a PR
  leaves the open state).
- `pr_state` values expand from `'open' | 'closed'` to
  `'open' | 'merged' | 'closed'` (no `CHECK` constraint exists today, so no
  constraint migration is needed — this is purely an application-level
  convention change).
- Existing databases get a small idempotent migration (checked via
  `PRAGMA table_info(pull_requests)`, then `ALTER TABLE ... ADD COLUMN` if
  missing), extracted into a shared `runMigrations(db)` helper in
  `src/db/client.ts` that is called from **both** `getDb()` and
  `createTestDb()` (both currently call `db.exec(readSchema())` directly —
  see `src/db/client.ts:13-23,40-43` — so both call sites must run the
  migration to keep production and test databases consistent).
- `PullRequestRow`'s `pr_state` type (`src/db/pullRequests.ts:26`) is widened
  from `'open' | 'closed'` to `'open' | 'merged' | 'closed'`, and a
  `closed_at: string | null` field is added to match the new column.
- `src/lib/gh.ts` gets a new exported helper, e.g.
  `getPrFinalState(repo, prNumber): Promise<'merged' | 'closed'>`, wrapping
  `gh pr view <number> --repo <repo> --json state` (mapping GitHub's
  `MERGED`/`CLOSED` to our lowercase `pr_state` values), following the same
  `execFileAsync` pattern already used by `fetchOpenPrs` in that file.

### Poller changes (`src/lib/poller.ts`, `src/db/pullRequests.ts`)

- When a previously-tracked **open** PR no longer appears in
  `gh pr list --state open`'s results, call the new `getPrFinalState()`
  helper and set `pr_state` (`'merged'`/`'closed'`) + `closed_at = now` on
  that row, instead of unconditionally marking everything `'closed'` as
  today.
- **Queued/in-flight interaction**: `runPollTick()` calls
  `markClosedExcept()` and then still runs `processQueue()` →
  `getPendingPrs()` in the same tick (`src/lib/poller.ts:68,80`), and
  `getPendingPrs()` currently ignores `pr_state` entirely
  (`src/db/pullRequests.ts:123`). To avoid reviewing a PR that just got
  merged/closed in this same tick, `getPendingPrs()` is updated to only
  return rows where `pr_state = 'open'`. A PR that is already
  `'reviewing'` (child process already spawned) when it merges/closes is
  allowed to finish naturally — its result is still valid historical data
  for the retention window; nothing needs to detect/cancel that in-flight
  process.
- **A row can still be left with `review_status='pending'` when it
  merges/closes** (e.g. it was enqueued for a commit change, then the PR
  merged before `processQueue()` reached it). Rather than inventing a new
  synthetic terminal `review_status` value for this case, all
  "in progress" / recheck-eligibility checks are gated on `pr_state`
  in addition to `review_status`, so a stale `'pending'` on a
  merged/closed row can never present as active:
  - `buildListRowViewModel` (`src/lib/listPageViewModel.ts:28`) and the
    detail page's `isInProgress` computation
    (`src/app/pr/[number]/page.tsx:36`) both change their check from
    `reviewStatus === 'pending' || reviewStatus === 'reviewing'` to also
    require `prState === 'open'` — a merged/closed PR is therefore never
    rendered as "Reviewing…", regardless of its stored `review_status`.
    This requires plumbing `prState` through: `ListPageRowInput` and
    `ListPageRowViewModel` (`src/lib/listPageViewModel.ts:4-13`) both gain
    a `prState` field, and `buildListPageViewModel` (lines 77-88) passes
    `pr.pr_state` through when constructing each row's input, same as it
    already does for `reviewStatus`, `verdict`, etc.
  - `forceRecheck` (`src/lib/recheck.ts:21`) adds a `prState === 'open'`
    guard before its existing "already-in-progress" check, returning the
    existing `not-found`-style outcome for merged/closed PRs instead of a
    misleading `already-in-progress` (409). This is a defensive backstop
    only — the "Re-check now" button is already hidden for merged/closed
    PRs per the UI changes below, so this path shouldn't normally be
    reachable from the UI.
- On every poll tick, **hard-delete** rows where `pr_state` is `'merged'` or
  `'closed'` and `closed_at` is more than 3 days old. `findings` rows for
  that PR cascade-delete automatically via the existing
  `ON DELETE CASCADE` foreign key — no separate cleanup needed there.
- `getOpenPrs` is renamed to `getVisiblePrs` and returns rows where
  `is_draft = 0` AND (`pr_state = 'open'` OR (`pr_state IN ('merged','closed')`
  AND `closed_at` is within the last 3 days)), keeping both the existing
  `is_draft = 0` filter (`src/db/pullRequests.ts:99-100` — drafts stay
  excluded entirely, per Non-goals below) and the existing
  `ORDER BY pr_number DESC`. A separate, narrower `getOpenPrs` query (or an
  inline filter on `getVisiblePrs`'s result) is still used specifically for
  `buildSeveritySummary()` in `src/app/page.tsx:21-29` — the top summary bar
  continues to reflect **open PRs only**, so a merged/closed PR lingering
  in the retention window doesn't skew the live severity counts.

### UI changes

- New `PrStateBadge` component: "Merged" (violet-ish gradient, consistent
  with the existing `VerdictBadge` visual style) and "Closed" (muted grey),
  shown on the list card next to the existing verdict/"Reviewing…"
  indicator.
- List sort order is unchanged (still by PR number descending); merged/closed
  cards are visually de-emphasized with slightly reduced opacity, matching
  how in-progress cards already use `opacity-70`.
- "Re-check now" is hidden (not just disabled) for merged/closed PRs, since
  their branch/worktree no longer exists to review.
- Detail page: still viewable (read-only) during the 3-day retention window,
  showing the same `PrStateBadge`, with "Re-check now" likewise hidden.

### Testing

- Unit tests (Vitest, matching existing patterns in `src/lib/decision.test.ts`
  and `src/lib/listPageViewModel.test.ts`-style files) for:
  - the merged-vs-closed state resolution logic,
  - the 3-day retention/deletion cutoff logic (as a pure function taking a
    "now" timestamp, to keep it deterministic and testable),
  - the updated list/detail view models' new badge and button-visibility
    logic.

## Non-goals

- No manual "delete now" / "restore" UI for merged/closed PRs — the 3-day
  window is fully automatic.
- No change to how drafts are handled (they remain excluded from
  `getVisiblePrs`, unaffected by this work).
- No change to `HoverLiftCard`'s animation logic (see Section 2).
