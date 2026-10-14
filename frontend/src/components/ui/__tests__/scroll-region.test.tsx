import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Table } from "@/components/ui/table";

function mockWidths(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
}

function renderTable() {
  return render(
    <Table>
      <caption>Ledger entries</caption>
      <tbody>
        <tr>
          <td>Row</td>
        </tr>
      </tbody>
    </Table>,
  );
}

describe("Table scroll region", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a focusable, named region when the table overflows", () => {
    mockWidths(900, 390);
    renderTable();
    const region = screen.getByRole("region", { name: "Ledger entries" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("relative", "overflow-x-auto");
  });

  it("adds no tab stop or landmark when the table fits", () => {
    mockWidths(390, 390);
    const { container } = renderTable();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveAttribute("tabindex");
  });
});
