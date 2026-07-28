import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(signal?: string) {
    this.killed = true;
    this.emit('__killed__', signal);
  }
}

let fakeChild: FakeChildProcess;
const spawnMock = vi.fn(() => fakeChild);
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { runReview } = await import('./reviewRunner');

describe('runReview', () => {
  beforeEach(() => {
    fakeChild = new FakeChildProcess();
    spawnMock.mockClear();
  });

  it('resolves success=true with captured stdout on a zero exit code', async () => {
    const promise = runReview('/tmp/worktree', 'review this PR');
    fakeChild.stdout.emit('data', Buffer.from('# Report\n'));
    fakeChild.emit('close', 0);

    const result = await promise;
    expect(result).toEqual({ success: true, output: '# Report\n' });
    expect(spawnMock).toHaveBeenCalledWith(
      'copilot',
      ['-p', 'review this PR', '--allow-all-tools'],
      { cwd: '/tmp/worktree' }
    );
  });

  it('resolves success=false with the exit code and stderr on a non-zero exit', async () => {
    const promise = runReview('/tmp/worktree', 'review this PR');
    fakeChild.stdout.emit('data', Buffer.from('partial output'));
    fakeChild.stderr.emit('data', Buffer.from('boom'));
    fakeChild.emit('close', 1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.output).toBe('partial output');
    expect(result.errorMessage).toContain('exited with code 1');
    expect(result.errorMessage).toContain('boom');
  });

  it('resolves success=false when the process errors to spawn (e.g. binary not found)', async () => {
    const promise = runReview('/tmp/worktree', 'review this PR');
    fakeChild.emit('error', new Error('spawn copilot ENOENT'));

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('spawn copilot ENOENT');
  });

  it('kills the process and resolves success=false after the timeout elapses', async () => {
    vi.useFakeTimers();
    const promise = runReview('/tmp/worktree', 'review this PR', 1000);

    vi.advanceTimersByTime(1000);
    expect(fakeChild.killed).toBe(true);
    fakeChild.emit('close', null); // killed processes report a null exit code

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    vi.useRealTimers();
  });
});
