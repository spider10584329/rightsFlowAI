import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";

function StateOpenedDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Invite member
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Invite member">
        <input aria-label="Email" />
      </Dialog>
    </>
  );
}

function StateOpenedConfirm() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Delete work
      </button>
      <ConfirmDialog open={open} onOpenChange={setOpen} title="Delete work?" onConfirm={() => undefined} />
    </>
  );
}

describe("dialog focus return", () => {
  it("returns focus to the opener of a state-controlled dialog on Escape", async () => {
    const user = userEvent.setup();
    render(<StateOpenedDialog />);
    const opener = screen.getByRole("button", { name: "Invite member" });
    opener.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).not.toBe(opener));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("returns focus to the opener after cancelling a confirm dialog", async () => {
    const user = userEvent.setup();
    render(<StateOpenedConfirm />);
    const opener = screen.getByRole("button", { name: "Delete work" });
    await user.click(opener);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
