import { Activity, Briefcase, MessagesSquare, ShieldCheck, ShoppingCart, type LucideIcon } from 'lucide-react';
import type { DeskId } from '../../lib/desks-api';

const ICONS: Record<DeskId, LucideIcon> = {
  content: MessagesSquare,
  bd: Briefcase,
  commerce: ShoppingCart,
  ops: Activity,
  compliance: ShieldCheck,
};

/** Each desk's icon, for its thread header and its roster card. */
export const deskIcon = (desk: DeskId): LucideIcon => ICONS[desk] ?? MessagesSquare;
