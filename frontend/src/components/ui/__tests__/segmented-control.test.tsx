import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "@/components/ui/segmented-control";

const OPTIONS = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
] as const;

describe("SegmentedControl", () => {
  it("renders a labelled group of toggle buttons without tab semantics", () => {
    render(<SegmentedControl aria-label="Show notifications" value="all" onValueChange={() => undefined} options={OPTIONS} />);
    const group = screen.getByRole("group", { name: "Show notifications" });
    expect(group).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "false");
    for (const button of screen.getAllByRole("button")) expect(button).not.toHaveAttribute("aria-controls");
  });

  it("reports a new choice only", async () => {
    const onValueChange = vi.fn();
    render(<SegmentedControl aria-label="Show notifications" value="all" onValueChange={onValueChange} options={OPTIONS} />);
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onValueChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Unread" }));
    expect(onValueChange).toHaveBeenCalledWith("unread");
  });
});
