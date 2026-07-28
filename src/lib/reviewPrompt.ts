export interface ReviewPromptInput {
  repo: string;
  prNumber: number;
  title: string;
  branch: string;
  baseBranch: string;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  return `You are reviewing pull request #${input.prNumber} "${input.title}" in ${input.repo}.
Branch: ${input.branch} -> ${input.baseBranch}

This working directory is a local, read-only git worktree checked out at
this PR's head commit. Do not push, commit, or modify any remote branch —
only read the code to produce a review.

Invoke the local-advanced-code-review skill and perform its full review
flow against the diff between ${input.baseBranch} and this branch.

After the normal markdown report, append exactly one trailing fenced code
block labeled \`\`\`json containing ONLY this JSON shape (no commentary
after it, no markdown inside it):

\`\`\`json
{
  "verdict": "approve" | "needs_fix" | "needs_review",
  "findings": [
    {
      "file": "path/to/file",
      "line": 123,
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "summary": "one-line description",
      "failureScenario": "what goes wrong and when",
      "evidence": "why you believe this, e.g. quoted code or trace",
      "fixSuggestion": "concrete suggested fix",
      "codeSnippet": "optional short snippet illustrating the fix"
    }
  ]
}
\`\`\`
`;
}
