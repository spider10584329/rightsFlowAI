import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { clampProgress, JobProgress, jobTypeLabel } from "@/components/jobs/job-ui";
import { isJobActive } from "@/lib/api/hooks/jobs";

describe("job helpers", () => {
  it("clamps progress", () => {
    expect(clampProgress(140)).toBe(100);
    expect(clampProgress(-2)).toBe(0);
    expect(clampProgress(undefined)).toBe(0);
    expect(clampProgress(42.6)).toBe(43);
  });

  it("labels known and unknown job types", () => {
    expect(jobTypeLabel("royalty_import")).toBe("Statement import");
    expect(jobTypeLabel("custom_thing")).toBe("Custom Thing");
  });

  it("treats queued and running jobs as active (drives auto-refresh)", () => {
    expect(isJobActive({ status: "queued" })).toBe(true);
    expect(isJobActive({ status: "running" })).toBe(true);
    expect(isJobActive({ status: "failed" })).toBe(false);
  });

  it("renders a progressbar, full for succeeded jobs", () => {
    render(<JobProgress job={{ status: "succeeded", progress: 40 }} label="Import" />);
    expect(screen.getByRole("progressbar", { name: "Import progress" })).toHaveAttribute("aria-valuenow", "100");
  });
});
