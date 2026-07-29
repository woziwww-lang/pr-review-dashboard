import type Database from 'better-sqlite3';
import { fetchOpenPrs, getPrFinalState } from './gh';
import { ensureBareRepo, addOrUpdateWorktree, resolveLocalBaseSha } from './repoCache';
import { runReview } from './reviewRunner';
import { buildReviewPrompt } from './reviewPrompt';
import { parseReviewOutput } from './parseReviewOutput';
import { decidePrAction } from './decision';
import { setConfig } from '../db/config';
import {
  upsertOpenPr,
  markClosedExcept,
  markPending,
  markReviewing,
  markDone,
  markFailed,
  getByNumber,
  getPendingPrs,
  deleteStaleClosedPrs,
} from '../db/pullRequests';
import { replaceFindings, type FindingInput } from '../db/findings';

const REVIEW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, per spec

export async function runPollTick(db: Database.Database, repo: string): Promise<void> {
  const previouslyOpenPrNumbers = (
    db.prepare(`SELECT pr_number FROM pull_requests WHERE repo = ? AND pr_state = 'open'`).all(repo) as
      { pr_number: number }[]
  ).map((row) => row.pr_number);

  let prs;
  try {
    prs = await fetchOpenPrs(repo);
  } catch (err) {
    setConfig(db, 'last_poll_status', 'error');
    setConfig(db, 'last_poll_error', err instanceof Error ? err.message : String(err));
    return; // this tick's upsert/close/enqueue step is skipped entirely
  }

  const finalStates: Record<number, 'merged' | 'closed'> = {};
  const keepPrNumbers: number[] = [];
  for (const pr of prs) {
    keepPrNumbers.push(pr.number);
    const existing = getByNumber(db, repo, pr.number);
    const previousHeadSha = existing?.head_sha ?? null;
    const reviewStatus = existing?.review_status ?? null;

    upsertOpenPr(db, {
      repo,
      prNumber: pr.number,
      title: pr.title,
      author: pr.author,
      branch: pr.headRefName,
      baseBranch: pr.baseRefName,
      headSha: pr.headRefOid,
      prUrl: pr.url,
      isDraft: pr.isDraft,
    });

    // Brand new rows are already 'pending' from upsertOpenPr's INSERT
    // default; only an *existing* tracked row needs to be explicitly
    // flipped back to 'pending' here.
    if (existing) {
      const decision = decidePrAction({
        isDraft: pr.isDraft,
        previousHeadSha,
        newHeadSha: pr.headRefOid,
        reviewStatus,
      });
      if (decision === 'enqueue') {
        markPending(db, existing.id);
      }
    }
  }

  const keepPrNumberSet = new Set(keepPrNumbers);
  for (const prNumber of previouslyOpenPrNumbers) {
    if (keepPrNumberSet.has(prNumber)) continue;
    try {
      finalStates[prNumber] = await getPrFinalState(repo, prNumber);
    } catch {
      finalStates[prNumber] = 'closed';
    }
  }

  markClosedExcept(db, repo, keepPrNumbers, finalStates);
  deleteStaleClosedPrs(db);
  setConfig(db, 'last_poll_at', new Date().toISOString());
  setConfig(db, 'last_poll_status', 'ok');
  setConfig(db, 'last_poll_error', '');

  await processQueue(db, repo);
}

async function processQueue(db: Database.Database, repo: string): Promise<void> {
  // Re-read the queue before each item: this loop only ever runs within
  // a single poll tick (or a single manual re-check, in Chunk 5), so no
  // other writer can enqueue more work concurrently in-process.
  for (const pr of getPendingPrs(db, repo)) {
    await processOnePr(db, repo, pr.id, pr.pr_number, pr.title, pr.branch, pr.base_branch, pr.head_sha);
  }
}

export async function processOnePr(
  db: Database.Database,
  repo: string,
  id: number,
  prNumber: number,
  title: string,
  branch: string,
  baseBranch: string,
  headSha: string
): Promise<void> {
  markReviewing(db, id);

  let worktreeDir: string;
  let baseSha: string;
  try {
    await ensureBareRepo(repo);
    worktreeDir = await addOrUpdateWorktree(repo, prNumber, headSha);
    baseSha = await resolveLocalBaseSha(repo, baseBranch);
  } catch (err) {
    markFailed(db, id, err instanceof Error ? err.message : String(err));
    return;
  }

  const prompt = buildReviewPrompt({ repo, prNumber, title, branch, baseBranch, baseSha });
  const result = await runReview(worktreeDir, prompt, REVIEW_TIMEOUT_MS);

  if (!result.success) {
    markFailed(db, id, result.errorMessage ?? 'Review failed for an unknown reason');
    return;
  }

  const parsed = parseReviewOutput(result.output);
  const findingInputs: FindingInput[] = parsed.findings.map((f) => ({
    file: f.file ?? '',
    line: f.line ?? 0,
    severity: f.severity,
    summary: f.summary,
    failureScenario: f.failureScenario ?? '',
    evidence: f.evidence ?? '',
    fixSuggestion: f.fixSuggestion ?? '',
    codeSnippet: f.codeSnippet ?? '',
  }));

  replaceFindings(db, id, findingInputs);
  markDone(db, id, {
    verdict: parsed.verdict,
    severityCritical: countSeverity(parsed.findings, 'CRITICAL'),
    severityHigh: countSeverity(parsed.findings, 'HIGH'),
    severityMedium: countSeverity(parsed.findings, 'MEDIUM'),
    severityLow: countSeverity(parsed.findings, 'LOW'),
    reviewedHeadSha: headSha,
    rawReportMd: parsed.rawReportMd,
  });
}

function countSeverity(findings: { severity: string }[], severity: string): number {
  return findings.filter((f) => f.severity === severity).length;
}
