import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ImportJobView, normalizeImportResult } from "@/components/catalog/import-result";
import type { ImportJob } from "@/lib/api/hooks/catalog";

function job(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "job-1",
    job_type: "catalog_import",
    status: "succeeded",
    progress: 100,
    entity_type: "work",
    dry_run: false,
    filename: "works.csv",
    file_id: "f1",
    result: null,
    error: null,
    deduplicated: false,
    created_by_id: "u1",
    created_at: "2026-10-14T03:00:00",
    finished_at: "2026-10-14T03:00:05",
    ...overrides,
  };
}

describe("ImportJobView", () => {
  it("shows progress while running", () => {
    render(<ImportJobView job={job({ status: "running", progress: 40 })} />);
    expect(screen.getByRole("progressbar", { name: "Import progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("Importing rows…")).toBeInTheDocument();
  });

  it("renders counts and the row errors table", () => {
    render(
      <ImportJobView
        job={job({
          result: {
            entity_type: "work",
            dry_run: false,
            total_rows: 4,
            created: 2,
            updated: 1,
            skipped: 0,
            parties_created: 3,
            error_count: 1,
            errors: [{ row: 5, message: "Invalid ISWC" }],
            errors_truncated: false,
            ignored_columns: ["colour"],
          },
        })}
      />,
    );
    expect(screen.getByText("Imported with row errors")).toBeInTheDocument();
    const created = screen.getByText("Created").parentElement as HTMLElement;
    expect(within(created).getByText("2")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("5")).toBeInTheDocument();
    expect(within(table).getByText("Invalid ISWC")).toBeInTheDocument();
    expect(screen.getByText(/colour/)).toBeInTheDocument();
  });

  it("labels dry runs and failures", () => {
    const { unmount } = render(<ImportJobView job={job({ dry_run: true, result: { dry_run: true, created: 3, errors: [] } })} />);
    expect(screen.getByText("Dry run — nothing was saved")).toBeInTheDocument();
    expect(screen.getByText("Would create")).toBeInTheDocument();
    unmount();
    render(<ImportJobView job={job({ status: "failed", error: "File has no header row" })} />);
    expect(screen.getByText("Import failed")).toBeInTheDocument();
    expect(screen.getByText(/File has no header row/)).toBeInTheDocument();
  });

  it("normalizes partial results", () => {
    expect(normalizeImportResult(null)).toBeNull();
    expect(normalizeImportResult({ created: 1, errors: [{ row: 2, message: "x" }] })).toMatchObject({ created: 1, updated: 0, error_count: 1, ignored_columns: [] });
  });
});
