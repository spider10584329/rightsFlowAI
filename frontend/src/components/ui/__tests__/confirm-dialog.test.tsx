import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ApiError } from "@/lib/api/errors";

function Harness({ onConfirm, confirmText }: { onConfirm: () => unknown; confirmText?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete work?"
        description="This cannot be undone."
        confirmLabel="Delete"
        confirmText={confirmText}
        onConfirm={onConfirm}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("renders an accessible alert dialog and confirms", async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(/Delete work\?/);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("closed"));
  });

  it("requires the typed confirmation text", async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} confirmText="acme-music" />);
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    const input = screen.getByLabelText(/to confirm/);
    await userEvent.type(input, "acme-musi");
    expect(confirm).toBeDisabled();
    await userEvent.type(input, "c");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("stays open and shows the error when confirmation fails", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError({ status: 409, code: "conflict", message: "Work is referenced by a contract" }));
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Work is referenced by a contract")).toBeInTheDocument();
    expect(screen.getByTestId("state")).toHaveTextContent("open");
  });

  it("closes on cancel without confirming", async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
  });
});
