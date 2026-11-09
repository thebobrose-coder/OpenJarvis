import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type DrawerWidth = 'narrow' | 'wide';

/** 36 rem for a decision or a prospect; 64 rem for an episode or a patch. */
const WIDTH: Record<DrawerWidth, string> = {
  narrow: 'max-w-[36rem]',
  wide: 'max-w-[64rem]',
};

/**
 * The right-hand drawer every overlay uses (widescreen plan, Phase 0): portalled to
 * <body> so it sits above the Layout stack, Escape and the backdrop close it, and the
 * aside scrolls on its own. At 2560 a wide drawer still leaves most of the page in
 * view, so the backdrop is a light tint rather than a modal dim.
 */
export function Drawer({
  open,
  onClose,
  label,
  width = 'narrow',
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** aria-label for the dialog. */
  label: string;
  width?: DrawerWidth;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const drawer = (
    <div className="fixed inset-0 z-[70] flex justify-end" style={{ background: 'rgba(0,0,0,0.2)' }} onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`h-full w-full ${WIDTH[width]} overflow-y-auto flex flex-col gap-4 p-5 text-ui-12-5`}
        style={{ background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </aside>
    </div>
  );
  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body);
}
