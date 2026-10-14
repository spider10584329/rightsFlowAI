import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom lacks a few APIs Radix primitives rely on.
if (typeof window !== "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!("ResizeObserver" in window)) {
    Object.defineProperty(window, "ResizeObserver", { value: ResizeObserverStub, writable: true });
  }
  const proto = window.HTMLElement.prototype as HTMLElement & {
    hasPointerCapture?: (id: number) => boolean;
    releasePointerCapture?: (id: number) => void;
    scrollIntoView?: () => void;
  };
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
}
