import type { ReactNode } from 'react';

/**
 * The one page wrapper for the operator pages (widescreen plan, Phase 0): the page's
 * own scroll column, 24 px gutters, and the content width. Wide pages fill the
 * operator's 2560 px viewport minus the sidebar; `narrow` is for reading pages
 * (the Briefing) where prose wants a measure.
 */
export function PageFrame({
  narrow = false,
  className = '',
  children,
}: {
  narrow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className={`${narrow ? 'max-w-3xl' : 'max-w-[2240px]'} mx-auto w-full ${className}`.trim()}>{children}</div>
    </div>
  );
}
