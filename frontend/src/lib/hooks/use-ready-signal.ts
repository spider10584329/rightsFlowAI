"use client";

import { useState } from "react";

import { createDeferred, type Deferred, type TrackedPromise } from "@/lib/client-only";

/**
 * Returns a promise that is pending while `ready` is false and already
 * fulfilled once it is true. Consumers call `use()` on it unconditionally:
 * they suspend while it is pending and read it synchronously afterwards.
 * If `ready` flips back to false, a fresh pending promise is issued.
 */
export function useReadySignal(ready: boolean): TrackedPromise {
  const [state, setState] = useState<{ deferred: Deferred; ready: boolean }>(() => ({ deferred: createDeferred(), ready: false }));

  let current = state;
  if (state.ready !== ready) {
    // Derived-state update during render (React re-renders before children see it).
    current = { deferred: ready ? state.deferred : createDeferred(), ready };
    setState(current);
  }
  // Settling is idempotent and only flips the thenable status React reads.
  if (ready) current.deferred.resolve();
  return current.deferred.promise;
}
