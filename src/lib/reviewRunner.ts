import { spawn } from 'node:child_process';

export interface RunReviewResult {
  success: boolean;
  output: string;
  errorMessage?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, per spec

export function runReview(
  cwd: string,
  prompt: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<RunReviewResult> {
  return new Promise((resolve) => {
    const child = spawn('copilot', ['-p', prompt], { cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const settle = (result: RunReviewResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: Error) => {
      settle({ success: false, output: stdout, errorMessage: err.message });
    });

    child.on('close', (code: number | null) => {
      if (timedOut) {
        settle({
          success: false,
          output: stdout,
          errorMessage: `copilot timed out after ${timeoutMs}ms`,
        });
        return;
      }
      if (code !== 0) {
        settle({
          success: false,
          output: stdout,
          errorMessage: `copilot exited with code ${code}: ${stderr}`,
        });
        return;
      }
      settle({ success: true, output: stdout });
    });
  });
}
