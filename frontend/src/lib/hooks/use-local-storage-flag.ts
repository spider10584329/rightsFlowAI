"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

/**
 * Boolean persisted in localStorage, hydration-safe (server snapshot is
 * `fallback`). Storage failures degrade to in-memory behaviour silently.
 */
export function useLocalStorageFlag(key: string, fallback = false): [boolean, (value: boolean) => void] {
  const subscribe = useCallback(
    (callback: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(callback);
      const onStorage = (event: StorageEvent) => {
        if (event.key === key) callback();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        set.delete(callback);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );

  const read = useCallback(() => {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value === "1";
    } catch {
      return fallback;
    }
  }, [key, fallback]);

  const value = useSyncExternalStore(subscribe, read, () => fallback);

  const setValue = useCallback(
    (next: boolean) => {
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // ignore
      }
      notify(key);
    },
    [key],
  );

  return [value, setValue];
}
