import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewQueue } from "../review-queue";
import type { ReviewTask } from "@/lib/api/hooks/automation";

const tasks: ReviewTask[] = [
  {
    id: "t1",
    kind: "ai_metadata",
    status: "open",
    title: "Metadata review for work 1234abcd: 1 AI suggestion(s), 0 issue(s)",
    subject_type: "work",
    subject_id: "w1",
    link: "/catalog/works/w1",
    details: { outcome: "suggested", suggestion_ids: ["s1"], proposed_fields: ["genre"], deterministic_issues: [], ai_generated: true },
    resolved_at: null,
    resolution_note: null,
    created_at: "2026-10-10T10:00:00",
    updated_at: "2026-10-10T10:00:00",
  },
];

const closeMutation = { mutateAsync: vi.fn(), isPending: false };
const listParams = vi.fn();

vi.mock("@/lib/api/hooks/automation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/hooks/automation")>();
  return {
    ...actual,
    useReviewTasks: (_orgId: string, params: unknown) => {
      listParams(params);
      return { data: tasks, isLoading: false, isFetching: false, error: null, refetch: vi.fn() };
    },
    useCloseReviewTask: () => closeMutation,
  };
});

beforeEach(() => {
  closeMutation.mutateAsync.mockReset().mockResolvedValue({ ...tasks[0], status: "resolved" });
  listParams.mockReset();
});

describe("ReviewQueue", () => {
  it("shows the task, its link and the AI note to viewers without actions", () => {
    render(<ReviewQueue orgId="org-1" canAct={false} />);
    const item = screen.getByRole("heading", { name: /Metadata review for work/ });
    expect(within(item).getByRole("link")).toHaveAttribute("href", "/catalog/works/w1");
    expect(screen.getByText("AI-generated, pending approval")).toBeInTheDocument();
    expect(screen.getByText("1 AI suggestion for genre")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("lets managers resolve with a note", async () => {
    render(<ReviewQueue orgId="org-1" canAct />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText("Note"), "Approved the genre change");
    await userEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));
    expect(closeMutation.mutateAsync).toHaveBeenCalledWith({ taskId: "t1", action: "resolve", note: "Approved the genre change" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("filters by status with a segmented control", async () => {
    render(<ReviewQueue orgId="org-1" canAct={false} />);
    expect(listParams).toHaveBeenLastCalledWith({ status: "open", kind: undefined, limit: 100 });
    const group = screen.getByRole("group", { name: "Show review tasks" });
    await userEvent.click(within(group).getByRole("button", { name: "Dismissed" }));
    expect(within(group).getByRole("button", { name: "Dismissed" })).toHaveAttribute("aria-pressed", "true");
    expect(listParams).toHaveBeenLastCalledWith({ status: "dismissed", kind: undefined, limit: 100 });
  });
});
