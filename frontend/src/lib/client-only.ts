/**
 * Error that tells Next.js to render the nearest `<Suspense>` boundary on the
 * client only. It carries the same digest Next.js uses for
 * `next/dynamic(..., { ssr: false })`, so it is not reported as a server error
 * and the boundary's fallback becomes part of the prerendered static shell.
 */
const BAILOUT_TO_CSR = "BAILOUT_TO_CLIENT_SIDE_RENDERING";

export function clientOnlyBailout(reason: string): Error {
  const error = new Error(`Bail out to client-side rendering: ${reason}`) as Error & { digest: string };
  error.digest = BAILOUT_TO_CSR;
  return error;
}

/**
 * A promise that also carries React's thenable `status` field, so `use()`
 * reads it synchronously once fulfilled instead of suspending for a tick.
 */
export type TrackedPromise = Promise<void>;
type AnnotatedPromise = Promise<void> & { status?: "pending" | "fulfilled"; value?: undefined };

export interface Deferred {
  promise: TrackedPromise;
  /** Idempotent. Marks the promise fulfilled synchronously, then resolves it. */
  resolve: () => void;
}

/** A promise plus its resolver, used to suspend consumers until data is ready. */
export function createDeferred(): Deferred {
  let settle: () => void = () => undefined;
  const promise: AnnotatedPromise = new Promise<void>((res) => {
    settle = res;
  });
  promise.status = "pending";
  return {
    promise,
    resolve: () => {
      if (promise.status === "fulfilled") return;
      promise.status = "fulfilled";
      promise.value = undefined;
      settle();
    },
  };
}
