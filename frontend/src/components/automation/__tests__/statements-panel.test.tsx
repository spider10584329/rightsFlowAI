import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StatementsPanel } from "../statements-panel";
import type { StatementAutomationRecord } from "@/lib/api/hooks/automation";

function record(state: string, name: string, overrides: Partial<StatementAutomationRecord> = {}): StatementAutomationRecord {
  return {
    statement_id: `st-${state}`,
    source: "inbox",
    state,
    attempts: 1,
    max_attempts: 3,
    next_attempt_at: null,
    error_category: null,
    last_error: null,
    updated_at: "2026-10-13T08:00:00",
    source_name: name,
    statement_status: "failed",
    ...overrides,
  };
}

const records: StatementAutomationRecord[] = [
  record("needs_manual_review", "Sony Q3", { attempts: 3, error_category: "invalid_input", last_error: "Missing required column: amount" }),
  record("failed", "Warner Q3"),
  record("retry_waiting", "BMI Q3", { attempts: 2, next_attempt_at: "2099-01-01T00:00:00", error_category: "transient", last_error: "Timed out" }),
  record("awaiting_mapping", "ASCAP Q3", { source: "app", attempts: 0, statement_status: "uploaded" }),
  record("processing", "PRS Q3", { statement_status: "processing" }),
];

const retryMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("@/lib/api/hooks/automation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/hooks/automation")>();
  return {
    ...actual,
    useStatementsNeedingAttention: () => ({ data: records, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
    useAutomationStatements: () => ({ data: undefined, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
    useRetryAutomationStatement: () => retryMutation,
  };
});

beforeEach(() => {
  retryMutation.mutateAsync.mockReset().mockResolvedValue({ ...records[0], state: "processing" });
});

const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

describe("StatementsPanel", () => {
  it("shows state, attempts and error details", () => {
    render(<StatementsPanel orgId="org-1" canAct />);
    const sony = row("Sony Q3");
    expect(within(sony).getByText("Needs manual review")).toBeInTheDocument();
    expect(within(sony).getByText("3 / 3")).toBeInTheDocument();
    expect(within(sony).getByText("Invalid file or mapping")).toBeInTheDocument();
    expect(within(sony).getByText("Missing required column: amount")).toBeInTheDocument();
    expect(within(sony).getByRole("link", { name: "Sony Q3" })).toHaveAttribute("href", "/royalties/statements/st-needs_manual_review");
    expect(within(row("BMI Q3")).getByText("Retry scheduled")).toBeInTheDocument();
  });

  it("offers Retry only for needs_manual_review and failed statements", () => {
    render(<StatementsPanel orgId="org-1" canAct />);
    expect(within(row("Sony Q3")).getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(within(row("Warner Q3")).getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(within(row("BMI Q3")).queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(within(row("PRS Q3")).queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(within(row("ASCAP Q3")).queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  });

  it("links awaiting_mapping statements to the mapping step instead of retrying", () => {
    render(<StatementsPanel orgId="org-1" canAct />);
    expect(within(row("ASCAP Q3")).getByRole("link", { name: /Confirm mapping/ })).toHaveAttribute(
      "href",
      "/royalties/statements/new?statement=st-awaiting_mapping&step=map",
    );
  });

  it("hides Retry and the mapping link from viewers", () => {
    render(<StatementsPanel orgId="org-1" canAct={false} />);
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Confirm mapping/ })).not.toBeInTheDocument();
    expect(within(row("ASCAP Q3")).getByText("A manager must confirm the column mapping")).toBeInTheDocument();
  });

  it("retries after confirmation", async () => {
    render(<StatementsPanel orgId="org-1" canAct />);
    await userEvent.click(within(row("Sony Q3")).getByRole("button", { name: /Retry/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Nothing is imported twice");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry now" }));
    expect(retryMutation.mutateAsync).toHaveBeenCalledWith("st-needs_manual_review");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});
