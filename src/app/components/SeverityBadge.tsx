import { Badge } from './ui/badge';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

const CLASSES: Record<Severity, string> = {
  CRITICAL: 'bg-[#991B1B] text-[#FECACA] border-transparent',
  HIGH: 'bg-[#F87171] text-[#450A0A] border-transparent',
  MEDIUM: 'bg-[#FBBF24] text-[#451A03] border-transparent',
  LOW: 'bg-[#3F3F46] text-[#D4D4D8] border-transparent',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge className={`${CLASSES[severity]} text-xs`}>{severity}</Badge>;
}
