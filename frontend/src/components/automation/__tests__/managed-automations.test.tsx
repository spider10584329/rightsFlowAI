import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseThresholds, runOutcomeText } from "../automation-format";
import { ManagedAutomationsPanel } from "../managed-automations";
import { RunOutputs } from "../run-outputs";
import type { AutomationRunDetail, ManagedAutomation, ManagedAutomationOverview } from "@/lib/api/hooks/automation";

const updateMutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const runMutation = { mutate: vi.fn(), isPending: false };
const disableAllMutation = { mutateAsync: vi.fn(), isPending: false };
const repairMutation = { mutate: vi.fn(), isPending: false };
let runDetail: AutomationRunDetail | undefined;

vi.mock("@/lib/api/hooks/automation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/hooks/automation")>();
  return {
    ...actual,
    useUpdateManagedAutomation: () => updateMutation,
    useRunManagedAutomation: () => runMutation,
    useDisableAllAutomations: () => disableAllMutation,
    useRepairAutomation: () => repairMutation,
    useAutomationRunDetail: () => ({ data: runDetail, isLoading: false, error: null, refetch: vi.fn() }),
  };
});

const downloadFile = vi.fn();
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, downloadFile: (...args: unknown[]) => downloadFile(...args) };
});

function automation(overrides: Partial<ManagedAutomation>): ManagedAutomation {
  return {
    key: "royalty_import",
    label: "Statement processing",
    description: "Processes royalty statements uploaded in RightsFlow.",
    enabled: false,
    status: "disabled",
    settings: { process_on_upload: true, interval_minutes: 15 },
    schedule: { cron: "3,18,33,48 * * * *", description: "Every 15 minutes" },
    next_run_at: null,
    last_run: null,
    last_error: null,
    provisioned_at: null,
    last_triggered_at: null,
    updated_at: "2026-10-15T10:00:00",
    can_run_now: false,
    ...overrides,
  };
}

function overview(overrides: Partial<ManagedAutomationOverview> = {}): ManagedAutomationOverview {
  return {
    mode: "managed",
    available: true,
    connection: { status: "active", last_error: null, last_reconciled_at: "2026-10-15T10:00:00", key: null },
    automations: [
      automation({
        enabled: true,
        status: "active",
        can_run_now: true,
        next_run_at: "2099-01-01T00:00:00",
        last_run: {
          id: "run-1",
          workflow: "royalty-import",
          execution_id: "41",
          trigger_type: "event",
          status: "succeeded",
          retry_count: 0,
          summary: { statements: 2, needing_review: 1 },
          error_code: null,
          error_message: null,
          correlation_id: null,
          started_at: "2026-10-15T09:00:00",
          finished_at: "2026-10-15T09:01:00",
        },
      }),
      automation({
        key: "contract_expiration",
        label: "Contract expiration reminders",
        settings: { thresholds: [30, 14, 7], hour_utc: 7 },
        schedule: { cron: "5 7 * * *", description: "Daily at 07:05 UTC" },
      }),
    ],
    manual_keys: 0,
    report_types: [{ value: "revenue_by_source", label: "Reported revenue by income source" }],
    ...overrides,
  };
}

function renderPanel(data: ManagedAutomationOverview) {
  return render(<ManagedAutomationsPanel orgId="org-1" data={data} isLoading={false} error={null} onRetry={vi.fn()} />);
}

beforeEach(() => {
  updateMutation.mutate.mockReset();
  runMutation.mutate.mockReset();
  disableAllMutation.mutateAsync.mockReset().mockResolvedValue(undefined);
  repairMutation.mutate.mockReset();
  downloadFile.mockReset().mockResolvedValue(undefined);
  runDetail = undefined;
});

describe("ManagedAutomationsPanel", () => {
  it("shows each automation's state, schedule and last run, without keys or setup commands", () => {
    renderPanel(overview());
    expect(screen.getByText("Statement processing")).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText("Every 15 minutes")).toBeInTheDocument();
    expect(screen.getByText("Processes uploads right away")).toBeInTheDocument();
    expect(screen.getByText(/2 statements, 1 need review/)).toBeInTheDocument();
    expect(screen.getByText("Reminds 30, 14, 7 days before the end date")).toBeInTheDocument();
    expect(screen.queryByText(/powershell/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/rfa_/)).not.toBeInTheDocument();
  });

  it("switches an automation on", async () => {
    renderPanel(overview());
    await userEvent.click(screen.getByRole("switch", { name: "Contract expiration reminders: off" }));
    expect(updateMutation.mutate).toHaveBeenCalledWith({ key: "contract_expiration", input: { enabled: true } }, expect.anything());
  });

  it("runs an active automation now; inactive ones can't be started", async () => {
    renderPanel(overview());
    const [first, second] = screen.getAllByRole("button", { name: "Run now" });
    expect(second).toBeDisabled();
    await userEvent.click(first);
    expect(runMutation.mutate).toHaveBeenCalledWith("royalty_import", expect.anything());
  });

  it("validates and saves reminder thresholds", async () => {
    renderPanel(overview());
    await userEvent.click(screen.getAllByRole("button", { name: "Settings" })[1]);
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: /Remind before the end date/ });
    await userEvent.clear(input);
    await userEvent.type(input, "30, 0");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));
    expect(within(dialog).getByText(/Enter 1 to 5 numbers of days/)).toBeInTheDocument();
    expect(updateMutation.mutate).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, "60, 7");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));
    expect(updateMutation.mutate).toHaveBeenCalledWith(
      { key: "contract_expiration", input: { settings: { thresholds: [60, 7], hour_utc: 7 } } },
      expect.anything(),
    );
  });

  it("explains an unconfigured server and keeps switches off", () => {
    renderPanel(overview({ available: false, connection: null, automations: [automation({})] }));
    expect(screen.getByText("Automation isn't set up on this server yet")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Statement processing: off" })).toBeDisabled();
  });

  it("offers a repair when the connection failed", async () => {
    renderPanel(overview({ connection: { status: "error", last_error: "n8n is unreachable", last_reconciled_at: null, key: null } }));
    expect(screen.getByText("n8n is unreachable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(repairMutation.mutate).toHaveBeenCalled();
  });

  it("confirms before switching everything off", async () => {
    renderPanel(overview());
    await userEvent.click(screen.getByRole("button", { name: "Switch everything off" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Your data, run history and review queue stay as they are/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch everything off" }));
    await waitFor(() => expect(disableAllMutation.mutateAsync).toHaveBeenCalled());
  });
});

describe("RunOutputs", () => {
  it("links processed statements and review tasks and downloads report files", async () => {
    runDetail = {
      id: "run-1",
      workflow: "monthly-reporting",
      automation: "monthly_reporting",
      execution_id: "7",
      trigger_type: "manual",
      status: "succeeded",
      retry_count: 0,
      summary: {},
      error_code: null,
      error_message: null,
      correlation_id: null,
      started_at: "2026-10-15T09:00:00",
      finished_at: "2026-10-15T09:01:00",
      outputs: {
        statements: [{ id: "st-1", source_name: "Distro Inc", status: "processed", period_start: "2026-03-01", period_end: "2026-03-31" }],
        review_tasks: [
          {
            id: "t-1",
            kind: "statement_review",
            status: "open",
            title: "Check 3 unmatched lines",
            subject_type: "statement",
            subject_id: "st-1",
            link: "/royalties/statements/st-1",
            details: null,
            resolved_at: null,
            resolution_note: null,
            created_at: "2026-10-15T09:01:00",
            updated_at: "2026-10-15T09:01:00",
          },
        ],
        deliveries: [],
        files: [{ id: "f-1", filename: "revenue_by_source-2026-10-15.csv", size_bytes: 146, created_at: "2026-10-15T09:01:00" }],
      },
    };
    render(<RunOutputs orgId="org-1" runId="run-1" />);
    expect(screen.getByRole("link", { name: /Distro Inc/ })).toHaveAttribute("href", "/royalties/statements/st-1");
    expect(screen.getByRole("link", { name: "Check 3 unmatched lines" })).toHaveAttribute("href", "/royalties/statements/st-1");
    await userEvent.click(screen.getByRole("button", { name: "revenue_by_source-2026-10-15.csv" }));
    expect(downloadFile).toHaveBeenCalledWith("/organizations/org-1/files/f-1/download", "revenue_by_source-2026-10-15.csv");
  });
});

describe("format helpers", () => {
  it("parses reminder thresholds", () => {
    expect(parseThresholds("7, 30 14")).toEqual([30, 14, 7]);
    expect(parseThresholds("30,30")).toEqual([30]);
    expect(parseThresholds("")).toBeNull();
    expect(parseThresholds("0")).toBeNull();
    expect(parseThresholds("1,2,3,4,5,6")).toBeNull();
    expect(parseThresholds("ten")).toBeNull();
  });

  it("summarises runs", () => {
    expect(runOutcomeText({ workflow: "royalty-import", summary: { statements: 0 } })).toBe("Nothing to process");
    expect(runOutcomeText({ workflow: "contract-expiration", summary: { contracts: 2, sent: 2 } })).toBe("2 reminders sent");
    expect(runOutcomeText({ workflow: "monthly-reporting", summary: { period: "2026-09" } })).toBe("Report for 2026-09");
    expect(runOutcomeText({ workflow: "unknown", summary: null })).toBeNull();
  });
});
