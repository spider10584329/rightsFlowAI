import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ChartCard, DataGrid } from "@/components/dashboard/chart-card";
import { activityLabel } from "@/components/dashboard/activity-lists";

describe("ChartCard", () => {
  it("shows the summary and toggles to an accessible table", async () => {
    render(
      <ChartCard
        title="Royalties over time"
        summary="USD 10.00 reported."
        table={<DataGrid caption="Per month" columns={[{ key: "m", header: "Month" }]} rows={[{ key: "1", cells: { m: "Jan 2026" } }]} />}
      >
        <div>chart-body</div>
      </ChartCard>,
    );
    expect(screen.getByText("USD 10.00 reported.")).toBeInTheDocument();
    expect(screen.getByText("chart-body")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("table", { name: "Per month" })).toBeInTheDocument();
    expect(screen.queryByText("chart-body")).not.toBeInTheDocument();
  });

  it("renders the empty state instead of the chart", () => {
    render(
      <ChartCard title="Top works" isEmpty empty={<p>Import your first statement</p>}>
        <div>chart-body</div>
      </ChartCard>,
    );
    expect(screen.getByText("Import your first statement")).toBeInTheDocument();
    expect(screen.queryByText("chart-body")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Table" })).not.toBeInTheDocument();
  });
});

describe("activityLabel", () => {
  it("humanises audit actions", () => {
    expect(activityLabel("work.created")).toBe("Work created");
    expect(activityLabel("recording.isrc_updated")).toBe("Recording isrc updated");
  });
});
