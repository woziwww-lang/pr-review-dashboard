// Next.js compiles this file for BOTH the Node.js and Edge runtimes. All
// of our actual startup logic (better-sqlite3, node-cron, node:child_process
// via gh/repoCache/reviewRunner) is Node-only and would fail to bundle for
// the Edge runtime, so it lives behind a dynamic import in
// instrumentation-node.ts that's only ever reached when NEXT_RUNTIME is
// 'nodejs'. See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { register: registerNode } = await import('./instrumentation-node');
    await registerNode();
  }
}
