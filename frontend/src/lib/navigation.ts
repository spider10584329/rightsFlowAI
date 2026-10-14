/**
 * Full-page navigation for auth and tenant boundary changes (sign-in/out,
 * joining, leaving or switching organizations). A document load guarantees
 * that no React state, query cache or preserved (Activity) route from the
 * previous identity survives. Use `useRouter()` for ordinary navigation.
 */
export function hardNavigate(path: string, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  if (options.replace) {
    window.location.replace(path);
    return;
  }
  window.location.assign(path);
}
