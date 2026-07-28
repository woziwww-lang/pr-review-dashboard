import { NextResponse } from 'next/server';
import { getDb } from '../../../../db/client';
import { getConfig } from '../../../../db/config';
import { forceRecheck } from '../../../../lib/recheck';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ number: string }> }
) {
  const db = getDb();
  const repo = getConfig(db, 'target_repo');
  if (!repo) {
    return NextResponse.json({ error: 'target_repo is not configured' }, { status: 500 });
  }

  const { number } = await params;
  const prNumber = Number(number);
  if (!Number.isInteger(prNumber)) {
    return NextResponse.json({ error: 'invalid PR number' }, { status: 400 });
  }

  const outcome = await forceRecheck(db, repo, prNumber);
  switch (outcome.status) {
    case 'started':
      return NextResponse.json({ status: 'started' }, { status: 202 });
    case 'queued':
      return NextResponse.json({ status: 'queued', message: outcome.message }, { status: 202 });
    case 'already-in-progress':
      return NextResponse.json({ status: 'already-in-progress' }, { status: 409 });
    case 'not-found':
      return NextResponse.json({ error: 'PR not found or no longer open' }, { status: 404 });
    case 'error':
      return NextResponse.json({ error: outcome.message }, { status: 502 });
  }
}
