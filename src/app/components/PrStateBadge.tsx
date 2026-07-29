import { GitMerge, GitPullRequestClosed } from 'lucide-react';
import { Badge } from './ui/badge';

export type PrState = 'merged' | 'closed';

const LABELS: Record<PrState, string> = {
  merged: 'Merged',
  closed: 'Closed',
};

const ICONS: Record<PrState, typeof GitMerge> = {
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

const CLASSES: Record<PrState, string> = {
  merged: 'bg-gradient-to-r from-[#A78BFA] to-[#8B5CF6] text-white border-transparent',
  closed: 'bg-[#3F3F46] text-[#A1A1AA] border-transparent',
};

export function PrStateBadge({ state }: { state: PrState }) {
  const Icon = ICONS[state];

  return (
    <Badge className={CLASSES[state]}>
      <Icon className="h-3 w-3" />
      {LABELS[state]}
    </Badge>
  );
}
