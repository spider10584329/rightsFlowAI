import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AllocationExplanation, explainAllocation, explanationItems } from "@/components/royalties/allocation-explanation";
import type { Allocation } from "@/lib/api/hooks/royalties";

function allocation(overrides: Partial<Allocation>): Allocation {
  return {
    id: "a1",
    line_id: "line-123456789",
    allocation_type: "payable",
    ownership_share_id: "s1",
    contract_term_id: null,
    party_id: "p1",
    party_name: "Sample Artist",
    payee_id: null,
    work_id: null,
    recording_id: "r1",
    rights_type: "master",
    territory: "US",
    share_percent: "50.0000",
    rate_percent: "100",
    base_amount: "24.00000000",
    amount: "24.00000000",
    currency: "USD",
    reason: null,
    explanation: null,
    ...overrides,
  };
}

describe("explanationItems", () => {
  it("renders share, basis, rate and contract term in plain language", () => {
    const items = explanationItems(
      allocation({
        contract_term_id: "term-abcdef12",
        rate_percent: "80",
        explanation: {
          party: "Sample Artist",
          share_percent: "50.0000",
          basis: "controlled_pro_rata",
          portion: "24.00000000",
          controlled_total_percent: "100.0000",
          rate_percent: "80",
          contract_term_id: "term-abcdef12",
          rate_source: "contract_term",
          payable: "19.20000000",
        },
      }),
    );
    const byLabel = Object.fromEntries(items.map((item) => [item.label, item]));
    expect(byLabel["Party"].value).toBe("Sample Artist");
    expect(byLabel["Ownership share"].value).toBe("50%");
    expect(byLabel["Ownership share"].hint).toMatch(/100% controlled/);
    expect(byLabel["Split basis"].value).toBe("Controlled pro-rata");
    expect(byLabel["Royalty rate"].value).toBe("80%");
    expect(byLabel["Royalty rate"].hint).toMatch(/contract royalty term/);
    expect(byLabel["Contract term"].value).toBe("term-abc");
    expect(byLabel["Payable from portion"].value).toMatch(/19\.20/);
  });

  it("includes unknown keys rather than dropping them", () => {
    const items = explanationItems(allocation({ explanation: { custom_note: "Check me" } }));
    expect(items.find((item) => item.label === "Custom Note")?.value).toBe("Check me");
  });
});

describe("explainAllocation", () => {
  it("explains a payable allocation without a contract term", () => {
    const text = explainAllocation(
      allocation({ explanation: { party: "Sample Artist", share_percent: "50", portion: "24.00000000", rate_source: "no_contract_term_full_share", rate_percent: "100" } }),
    );
    expect(text).toMatch(/Sample Artist holds 50%/);
    expect(text).toMatch(/full .*24\.00 is payable/);
  });

  it("explains contract retention", () => {
    const text = explainAllocation(
      allocation({ allocation_type: "retained", reason: "contract_retention", amount: "4.80000000", rate_percent: "80", explanation: { share_percent: "50", rate_percent: "80" } }),
    );
    expect(text).toMatch(/contract pays 80%/);
    expect(text).toMatch(/4\.80 is retained/);
  });

  it("uses the engine message for held income", () => {
    const text = explainAllocation(
      allocation({ allocation_type: "unallocated", reason: "missing_ownership", explanation: { message: "No active master ownership covers territory FR on 2026-03-31." } }),
    );
    expect(text).toBe("No active master ownership covers territory FR on 2026-03-31.");
  });
});

describe("<AllocationExplanation />", () => {
  it("shows the recommended action for held income", () => {
    render(<AllocationExplanation allocation={allocation({ allocation_type: "unallocated", reason: "missing_ownership", explanation: { message: "No ownership." } })} />);
    expect(screen.getByText("No ownership.")).toBeInTheDocument();
    expect(screen.getByText(/Add ownership shares/)).toBeInTheDocument();
  });
});
