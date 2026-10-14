import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders a type=button by default and handles clicks", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled and busy while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Submit
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Submit" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies variant and size classes and merges custom classes", () => {
    render(
      <Button variant="danger" size="lg" className="w-full">
        Delete
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.className).toContain("bg-danger-solid");
    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-full");
  });

  it("supports submit buttons inside forms", async () => {
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Button type="submit">Send</Button>
      </form>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
