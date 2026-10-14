"use client";

import { useRef } from "react";

type AutoFocusHandler = (event: Event) => void;

/**
 * Focus-return handlers for a Radix Dialog `Content`. Our dialogs are opened
 * from state rather than a Radix `Trigger`, so on close Radix focuses a null
 * trigger ref and focus falls to `<body>`. These handlers remember the element
 * that was focused when the dialog opened and refocus it on close (falling
 * back to Radix's default when it is gone). Caller handlers run first; a
 * caller that prevents the close event keeps control of focus.
 */
export function useRestoreFocus({ onOpenAutoFocus, onCloseAutoFocus }: { onOpenAutoFocus?: AutoFocusHandler; onCloseAutoFocus?: AutoFocusHandler } = {}) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      const target = opener.current;
      opener.current = null;
      if (event.defaultPrevented || !target?.isConnected) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
    },
  };
}
