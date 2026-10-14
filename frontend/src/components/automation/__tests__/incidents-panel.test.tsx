import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IncidentsPanel } from "../incidents-panel";
import type { AutomationIncident } from "@/lib/api/hooks/automation";

const openIncident: AutomationIncident = {
  id: "inc-1",
  workflow: "statement-inbox",
  category: "http_error",
  resource: "statement:abc",
  status: "open",
  title: "Statement inbox upload keeps failing",
  last_error: "502 Bad Gateway",
  last_execution_id: "exec-42",
  occurrences: 7,
  alerts_sent: 2,
  suppressed: 5,
  escalated_at: "2026-10-12T08:00:00",
  first_seen_at: "2026-10-10T08:00:00",
  last_seen_at: "2026-10-13T08:00:00",
  last_alerted_at: "2026-10-12T08:00:00",
  resolved_at: null,
  resolution: null,
};

const resolvedIncident: AutomationIncident = {
  ...openIncident,
  id: "inc-2",
  title: "Monthly report timed out",
  workflow: "monthly-report",
  status: "resolved",
  escalated_at: null,
  resolved_at: "2026-10-11T08:00:00",
  resolution: "Resolved by Ada Admin: workflow retired",
};

const resolveMutation = { mutateAsync: vi.fn(), isPending: false };
const listParams = vi.fn();

vi.mock("@/lib/api/hooks/automation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/hooks/automation")>();
  return {
    ...actual,
    useAutomationIncidents: (_orgId: string, params: { status?: string }) => {
      listParams(params);
      return {
        data: params.status === "resolved" ? [resolvedIncident] : [openIncident],
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: vi.fn(),
      };
    },
    useResolveAutomationIncident: () => resolveMutation,
  };
});

beforeEach(() => {
  resolveMutation.mutateAsync.mockReset().mockResolvedValue({ ...openIncident, status: "resolved" });
  listParams.mockReset();
});

describe("IncidentsPanel", () => {
  it("lists open incidents by default with counts and the escalated marker", () => {
    render(<IncidentsPanel orgId="org-1" />);
    expect(listParams).toHaveBeenLastCalledWith({ status: "open", limit: 100 });
    const row = screen.getByRole("row", { name: /Statement inbox upload keeps failing/ });
    expect(within(row).getByText("statement-inbox")).toBeInTheDocument();
    expect(within(row).getByText("Http Error")).toBeInTheDocument();
    expect(within(row).getByText("7")).toBeInTheDocument();
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("5")).toBeInTheDocument();
    expect(within(row).getByText("Escalated")).toBeInTheDocument();
    expect(within(row).getByText("502 Bad Gateway")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /Mark resolved/ })).toBeInTheDocument();
  });

  it("switches to resolved incidents without a resolve action", async () => {
    render(<IncidentsPanel orgId="org-1" />);
    const group = screen.getByRole("group", { name: "Show incidents" });
    await userEvent.click(within(group).getByRole("button", { name: "Resolved" }));
    expect(listParams).toHaveBeenLastCalledWith({ status: "resolved", limit: 100 });
    const row = screen.getByRole("row", { name: /Monthly report timed out/ });
    expect(within(row).getByText(/workflow retired/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark resolved/ })).not.toBeInTheDocument();
  });

  it("marks an incident resolved with an optional note after confirmation", async () => {
    render(<IncidentsPanel orgId="org-1" />);
    await userEvent.click(screen.getByRole("button", { name: /Mark resolved/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText("Note"), "Upstream fixed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark resolved" }));
    expect(resolveMutation.mutateAsync).toHaveBeenCalledWith({ incidentId: "inc-1", note: "Upstream fixed" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and shows the error when resolving fails", async () => {
    resolveMutation.mutateAsync.mockRejectedValue(new Error("Incident is already resolved"));
    render(<IncidentsPanel orgId="org-1" />);
    await userEvent.click(screen.getByRole("button", { name: /Mark resolved/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark resolved" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Incident is already resolved");
  });
});
