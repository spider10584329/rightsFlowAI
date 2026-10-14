import { act, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { isGuardedLinkClick, useIsDirty, useUnsavedChangesWarning } from "@/lib/hooks/use-unsaved-changes-warning";

// Relative hrefs resolve against jsdom's document URL, so compare against it too.
const LOCATION = window.location;

function clickOn(html: string, init: MouseEventInit = {}) {
  document.body.innerHTML = html;
  const target = document.body.querySelector("[data-target]") as HTMLElement;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("isGuardedLinkClick", () => {
  it("guards plain clicks on same-origin links to another page", () => {
    expect(isGuardedLinkClick(clickOn('<a href="/dashboard"><span data-target>Dashboard</span></a>'), LOCATION)).toBe(true);
    expect(isGuardedLinkClick(clickOn(`<a data-target href="${LOCATION.pathname}?x=1">Same page, new query</a>`), LOCATION)).toBe(true);
  });

  it("ignores modified clicks, new tabs, downloads, hash links, external links and non-links", () => {
    expect(isGuardedLinkClick(clickOn('<a data-target href="/dashboard">x</a>', { metaKey: true }), LOCATION)).toBe(false);
    expect(isGuardedLinkClick(clickOn('<a data-target href="/dashboard">x</a>', { button: 1 }), LOCATION)).toBe(false);
    expect(isGuardedLinkClick(clickOn('<a data-target href="/dashboard" target="_blank">x</a>'), LOCATION)).toBe(false);
    expect(isGuardedLinkClick(clickOn('<a data-target href="/export.csv" download>x</a>'), LOCATION)).toBe(false);
    expect(isGuardedLinkClick(clickOn('<a data-target href="#lines">x</a>'), LOCATION)).toBe(false);
    expect(isGuardedLinkClick(clickOn('<a data-target href="https://example.com/">x</a>'), LOCATION)).toBe(false);
    expect(isGuardedLinkClick(clickOn("<button data-target>x</button>"), LOCATION)).toBe(false);
  });
});

describe("useUnsavedChangesWarning", () => {
  it("blocks unload only while dirty", () => {
    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedChangesWarning(dirty), { initialProps: { dirty: false } });
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    rerender({ dirty: true });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    unmount();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("asks before following an in-app link and cancels when declined", () => {
    const onClick = vi.fn((event: React.MouseEvent) => event.preventDefault());
    function Page({ dirty }: { dirty: boolean }) {
      useUnsavedChangesWarning(dirty);
      return (
        <a href="/dashboard" onClick={onClick}>
          Dashboard
        </a>
      );
    }
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { rerender } = render(<Page dirty />);
    act(() => screen.getByRole("link", { name: "Dashboard" }).click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    act(() => screen.getByRole("link", { name: "Dashboard" }).click());
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<Page dirty={false} />);
    confirm.mockClear();
    act(() => screen.getByRole("link", { name: "Dashboard" }).click());
    expect(confirm).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe("useIsDirty", () => {
  it("compares against the first-render snapshot", () => {
    const { result } = renderHook(() => {
      const [value, setValue] = useState({ name: "", lines: [1] });
      return { dirty: useIsDirty(value), setValue };
    });
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setValue({ name: "Source", lines: [1] }));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.setValue({ name: "", lines: [1] }));
    expect(result.current.dirty).toBe(false);
  });
});
