import { CircleCheck, TriangleAlert } from 'lucide-react';
import { Badge } from './ui/badge';

export type BadgeVerdict = 'approve' | 'needs_fix' | 'needs_review' | 'failed';

const LABELS: Record<BadgeVerdict, string> = {
  approve: 'Approve',
  needs_fix: 'Needs Fix',
  needs_review: 'Needs Review',
  failed: 'Review Failed',
};

const ICONS: Record<BadgeVerdict, typeof CircleCheck> = {
  approve: CircleCheck,
  needs_review: TriangleAlert,
  needs_fix: TriangleAlert,
  failed: TriangleAlert,
};

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
