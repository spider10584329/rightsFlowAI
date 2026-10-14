import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateKeyDialog, KeysPanel, RotateKeyDialog } from "../automation-keys";
import type { AutomationCredential } from "@/lib/api/hooks/automation";

const TOKEN = "rfa_k1_s3cr3t-value-shown-once";

const credential: AutomationCredential = {
  id: "cred-1",
  name: "n8n production",
  key_id: "k1",
  key_hint: "rfa_k1_…",
  scopes: ["automation:read", "runs:write"],
  state: "active",
  expires_at: "2027-01-01T00:00:00",
  revoked_at: null,
  revoked_reason: null,
  rotated_from_id: null,
  last_used_at: null,
  created_by_id: "u1",
  created_at: "2026-10-01T00:00:00",
  expiry_level: "ok",
  bound_instance: null,
  instance_bound_at: null,
  instance_last_seen_at: null,
  instance_stale: false,
};

const boundCredential: AutomationCredential = {
  ...credential,
  id: "cred-bound",
  name: "n8n old server",
  expiry_level: "critical",
  bound_instance: "abcd1234…",
  instance_bound_at: "2026-09-01T00:00:00",
  instance_last_seen_at: "2026-09-20T00:00:00",
  instance_stale: true,
};

const createMutation = { mutateAsync: vi.fn(), reset: vi.fn(), isPending: false };
const rotateMutation = { mutateAsync: vi.fn(), reset: vi.fn(), isPending: false };
const releaseMutation = { mutateAsync: vi.fn(), isPending: false };
const revokeMutation = { mutateAsync: vi.fn(), isPending: false };
let credentialList: AutomationCredential[] = [];

vi.mock("@/lib/api/hooks/automation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/hooks/automation")>();
  return {
    ...actual,
    useAutomationScopes: () => ({
      data: [
        { scope: "automation:read", description: "Read health" },
        { scope: "runs:write", description: "Record runs" },
      ],
      isLoading: false,
      error: null,
    }),
    useCreateAutomationCredential: () => createMutation,
    useRotateAutomationCredential: () => rotateMutation,
    useReleaseAutomationInstance: () => releaseMutation,
    useRevokeAutomationCredential: () => revokeMutation,
    useAutomationCredentials: () => ({ data: credentialList, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
  };
});

beforeEach(() => {
  createMutation.mutateAsync.mockReset().mockResolvedValue({ credential, token: TOKEN });
  createMutation.reset.mockReset();
  rotateMutation.mutateAsync.mockReset().mockResolvedValue({ credential: { ...credential, id: "cred-2", rotated_from_id: "cred-1" }, token: TOKEN });
  rotateMutation.reset.mockReset();
  releaseMutation.mutateAsync.mockReset().mockResolvedValue({ ...boundCredential, bound_instance: null, instance_stale: false });
  revokeMutation.mutateAsync.mockReset();
  credentialList = [credential, boundCredential];
});

function CreateHarness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <CreateKeyDialog open={open} onOpenChange={setOpen} orgId="org-1" />
    </>
  );
}

describe("CreateKeyDialog", () => {
  it("sends every scope by default and shows the key once with the setup step", async () => {
    render(<CreateHarness />);
    await userEvent.type(screen.getByLabelText(/^Name/), "n8n production");
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));

    expect(createMutation.mutateAsync).toHaveBeenCalledWith({ name: "n8n production", scopes: ["automation:read", "runs:write"], expires_in_days: 90 });
    expect(await screen.findByLabelText("Automation key")).toHaveValue(TOKEN);
    expect(screen.getByText("This key can't be shown again")).toBeInTheDocument();
    expect(screen.getByLabelText("Setup command")).toHaveTextContent("powershell -ExecutionPolicy Bypass -File scripts\\setup-n8n-automation.ps1 -Token <key>");
  });

  it("clears the token when the dialog closes", async () => {
    render(<CreateHarness />);
    await userEvent.type(screen.getByLabelText(/^Name/), "n8n production");
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));
    await screen.findByLabelText("Automation key");

    await userEvent.click(screen.getByRole("button", { name: "I've stored the key" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(createMutation.reset).toHaveBeenCalled();
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Create automation key");
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("");
  });

  it("requires at least one scope and a valid lifetime", async () => {
    render(<CreateHarness />);
    await userEvent.type(screen.getByLabelText(/^Name/), "n8n");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    const days = screen.getByLabelText(/Expires after/);
    await userEvent.clear(days);
    await userEvent.type(days, "400");
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(screen.getByText("Choose at least one scope.")).toBeInTheDocument();
    expect(screen.getByText("Enter a whole number from 1 to 365.")).toBeInTheDocument();
    expect(createMutation.mutateAsync).not.toHaveBeenCalled();
  });
});

function RotateHarness() {
  const [target, setTarget] = useState<AutomationCredential | null>(credential);
  return (
    <>
      <button type="button" onClick={() => setTarget(credential)}>
        Rotate again
      </button>
      <RotateKeyDialog orgId="org-1" credential={target} onClose={() => setTarget(null)} />
    </>
  );
}

describe("RotateKeyDialog", () => {
  it("rotates with the default 24h grace and forgets the new key on close", async () => {
    render(<RotateHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    expect(rotateMutation.mutateAsync).toHaveBeenCalledWith({ credentialId: "cred-1", graceHours: 24 });
    expect(await screen.findByLabelText("Automation key")).toHaveValue(TOKEN);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(rotateMutation.reset).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Rotate again" }));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Rotate automation key");
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();
  });
});

async function openRowActions(name: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  return screen.findByRole("menu");
}

describe("KeysPanel expiry and instance binding", () => {
  it("shows the expiry level and the bound instance with a stale marker", () => {
    render(<KeysPanel orgId="org-1" />);
    const boundRow = screen.getByRole("row", { name: /n8n old server/ });
    expect(within(boundRow).getByText("Expires very soon")).toBeInTheDocument();
    expect(within(boundRow).getByText("abcd1234…")).toBeInTheDocument();
    expect(within(boundRow).getByText("Stale")).toBeInTheDocument();
    expect(within(boundRow).getByText(/Last seen/)).toBeInTheDocument();

    const plainRow = screen.getByRole("row", { name: /n8n production/ });
    expect(within(plainRow).getByText("OK")).toBeInTheDocument();
    expect(within(plainRow).getByText("Not bound")).toBeInTheDocument();
  });

  it("offers Release instance only for bound keys", async () => {
    render(<KeysPanel orgId="org-1" />);
    const menu = await openRowActions("n8n production");
    expect(within(menu).queryByRole("menuitem", { name: "Release instance" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Rotate key" })).toBeInTheDocument();
  });

  it("asks for confirmation, explains the consequences, then releases", async () => {
    render(<KeysPanel orgId="org-1" />);
    const menu = await openRowActions("n8n old server");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Release instance" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(/Release n8n instance\?/);
    expect(within(dialog).getByText("Only do this if the old n8n instance is gone")).toBeInTheDocument();
    expect(within(dialog).getByText(/The next n8n instance that uses the key will bind to it/)).toBeInTheDocument();
    expect(releaseMutation.mutateAsync).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Release instance" }));
    expect(releaseMutation.mutateAsync).toHaveBeenCalledWith("cred-bound");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("does nothing when the confirmation is cancelled", async () => {
    render(<KeysPanel orgId="org-1" />);
    const menu = await openRowActions("n8n old server");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Release instance" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(releaseMutation.mutateAsync).not.toHaveBeenCalled();
  });
});
