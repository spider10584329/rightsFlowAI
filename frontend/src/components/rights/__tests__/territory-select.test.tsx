import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { normalizeScope, scopeError, scopeSummary, toggleExcluded, toggleTerritory } from "../territory-scope";
import { TerritorySelect } from "../territory-select";

vi.mock("@/lib/api/hooks/reference", () => ({
  useReferenceList: () => ({ data: undefined }),
}));

const OPTIONS = [
  { code: "WORLD", name: "Worldwide" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
];

describe("territory scope rules", () => {
  it("keeps WORLD exclusive", () => {
    expect(toggleTerritory(["US", "GB"], "WORLD")).toEqual(["WORLD"]);
    expect(toggleTerritory(["WORLD"], "US")).toEqual(["US"]);
    expect(toggleTerritory(["US"], "GB")).toEqual(["US", "GB"]);
    expect(toggleTerritory(["US", "GB"], "US")).toEqual(["GB"]);
  });

  it("never excludes WORLD and drops exclusions without WORLD", () => {
    expect(toggleExcluded([], "WORLD")).toEqual([]);
    expect(toggleExcluded(["US"], "US")).toEqual([]);
    expect(normalizeScope({ territories: ["US"], excluded: ["GB"] })).toEqual({ territories: ["US"], excluded: [] });
    expect(normalizeScope({ territories: ["WORLD"], excluded: ["GB", "WORLD"] })).toEqual({ territories: ["WORLD"], excluded: ["GB"] });
  });

  it("validates like the backend", () => {
    expect(scopeError({ territories: [], excluded: [] })).toMatch(/at least one/);
    expect(scopeError({ territories: ["WORLD", "US"], excluded: [] })).toMatch(/cannot be combined/);
    expect(scopeError({ territories: ["WORLD"], excluded: ["US"] })).toBeNull();
  });

  it("summarises scopes", () => {
    expect(scopeSummary({ territories: ["WORLD"], excluded: ["US", "GB"] })).toBe("Worldwide excl. US, GB");
    expect(scopeSummary({ territories: ["US", "GB", "DE", "FR"], excluded: [] })).toBe("US, GB +2 more");
  });
});

function Harness({ initial = ["WORLD"] }: { initial?: string[] }) {
  const [value, setValue] = useState(initial);
  const [excluded, setExcluded] = useState<string[]>([]);
  return (
    <>
      <TerritorySelect aria-label="Territories" value={value} onChange={setValue} excluded={excluded} onExcludedChange={setExcluded} options={OPTIONS} />
      <output data-testid="state">{JSON.stringify({ value, excluded })}</output>
    </>
  );
}

describe("TerritorySelect", () => {
  it("selecting a country replaces WORLD", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Territories" }));
    await user.click(screen.getByRole("checkbox", { name: /United States/ }));
    expect(screen.getByTestId("state")).toHaveTextContent(JSON.stringify({ value: ["US"], excluded: [] }));
  });

  it("supports exclusions on a WORLD scope", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Territories" }));
    await user.click(screen.getByRole("radio", { name: /Excluded/ }));
    await user.click(screen.getByRole("checkbox", { name: /Germany/ }));
    expect(screen.getByTestId("state")).toHaveTextContent(JSON.stringify({ value: ["WORLD"], excluded: ["DE"] }));
    // WORLD is not offered as an exclusion.
    expect(screen.queryByRole("checkbox", { name: /Worldwide/ })).not.toBeInTheDocument();
  });

  it("filters the list by search text", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["US"]} />);
    await user.click(screen.getByRole("button", { name: "Territories" }));
    await user.type(screen.getByRole("textbox", { name: "Search territories" }), "king");
    expect(screen.getByRole("checkbox", { name: /United Kingdom/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Germany/ })).not.toBeInTheDocument();
    // Exclusions are disabled without WORLD.
    expect(screen.getByRole("radio", { name: /Excluded/ })).toBeDisabled();
  });
});
