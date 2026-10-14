"use client";

import { useEffect, useState } from "react";

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes. Leave this page and discard them?";

/**
 * True when the link click should leave the page and so needs confirming:
 * a plain left click on a same-origin link to a different page. New-tab,
 * download, hash-only and external links are left alone (external ones
 * unload the document, which `beforeunload` covers).
 */
export function isGuardedLinkClick(event: MouseEvent, location: Pick<Location, "href" | "origin" | "pathname" | "search">): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return false;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return false;
  return url.pathname !== location.pathname || url.search !== location.search;
}

/**
 * Warns before discarding unsaved form input while `dirty`: the browser's
 * native prompt on reload/close/external navigation, and a confirm on in-app
 * link clicks (client-side navigations never fire `beforeunload`).
 * Programmatic `router.push` (e.g. after a successful save) is not blocked.
 */
export function useUnsavedChangesWarning(dirty: boolean, message: string = UNSAVED_CHANGES_MESSAGE) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers only show the prompt when returnValue is set.
      event.returnValue = "";
    };
    // Capture phase, so a cancelled click never reaches Next's <Link> handler.
    const onClick = (event: MouseEvent) => {
      if (!isGuardedLinkClick(event, window.location)) return;
      if (window.confirm(message)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);
}

/**
 * Whether `snapshot` (plain form state) differs from its value on the first
 * render. Reverting every edit makes the form clean again.
 */
export function useIsDirty(snapshot: unknown): boolean {
  const [initial] = useState(() => JSON.stringify(snapshot));
  return JSON.stringify(snapshot) !== initial;
}
