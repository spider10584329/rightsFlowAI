import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DataTable, type DataTableColumn, type SortState } from "@/components/ui/data-table";

interface Row {
  id: string;
  name: string;
  plays: number;
}

const rows: Row[] = [
  { id: "a", name: "Alpha", plays: 10 },
  { id: "b", name: "Bravo", plays: 5 },
];

const columns: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", sortKey: "name", cell: (row) => row.name },
  { id: "plays", header: "Plays", cell: (row) => row.plays, align: "right" },
];

function ControlledTable({ onSortChange }: { onSortChange: (sort: SortState | null) => void }) {
  const [sort, setSort] = useState<SortState | null>(null);
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      sort={sort}
      onSortChange={(next) => {
        setSort(next);
        onSortChange(next);
      }}
    />
  );
}

describe("DataTable", () => {
  it("renders a row per item", () => {
    render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Bravo")).toBeInTheDocument();
  });

  it("cycles sort asc -> desc -> none and exposes aria-sort", async () => {
    const onSortChange = vi.fn();
    render(<ControlledTable onSortChange={onSortChange} />);
    const header = screen.getByRole("columnheader", { name: /Name/ });
    expect(header).toHaveAttribute("aria-sort", "none");
    // Non-sortable columns do not get a toggle.
    expect(within(screen.getByRole("columnheader", { name: "Plays" })).queryByRole("button")).toBeNull();

    const toggle = within(header).getByRole("button", { name: /Name/ });
    await userEvent.click(toggle);
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", order: "asc" });
    expect(header).toHaveAttribute("aria-sort", "ascending");

    await userEvent.click(toggle);
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", order: "desc" });
    expect(header).toHaveAttribute("aria-sort", "descending");

    await userEvent.click(toggle);
    expect(onSortChange).toHaveBeenLastCalledWith(null);
    expect(header).toHaveAttribute("aria-sort", "none");
  });

  it("shows the empty state when there is no data", () => {
    render(<DataTable columns={columns} data={[]} getRowId={(row) => row.id} emptyState={<p>No works yet</p>} />);
    expect(screen.getByText("No works yet")).toBeInTheDocument();
  });

  it("falls back to a default empty state", () => {
    render(<DataTable columns={columns} data={[]} getRowId={(row) => row.id} />);
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("renders skeleton rows while loading", () => {
    render(<DataTable columns={columns} data={undefined} isLoading skeletonRows={3} getRowId={(row) => row.id} />);
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(3);
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });

  it("shows an error with retry when loading fails", async () => {
    const onRetry = vi.fn();
    render(<DataTable columns={columns} data={undefined} error={new Error("Boom")} onRetry={onRetry} getRowId={(row) => row.id} />);
    expect(screen.getByText("Boom")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("supports row selection and bulk actions", async () => {
    function Selectable() {
      const [selected, setSelected] = useState<Set<string>>(new Set());
      return (
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.name}
          selectable
          selectedIds={selected}
          onSelectionChange={setSelected}
          bulkActions={(items) => <button type="button">Delete {items.length}</button>}
        />
      );
    }
    render(<Selectable />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    expect(screen.getByRole("button", { name: "Delete 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select all rows on this page" }));
    expect(screen.getByRole("button", { name: "Delete 2" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();
  });
});
