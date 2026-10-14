import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { compareLimits, exceededLimits } from "@/components/billing/plan-change";
import { formatUsd, meterPercent, meterStatusText, meterTone } from "@/components/billing/usage";
import { UsageMeter } from "@/components/billing/usage-meter";
import { ApiError } from "@/lib/api/errors";

describe("meterPercent", () => {
  it("clamps to 0..100", () => {
    expect(meterPercent(150, 100, "150.00")).toBe(100);
    expect(meterPercent(5, 10)).toBe(50);
    expect(meterPercent(-3, 10)).toBe(0);
    expect(meterPercent(12, 10)).toBe(100);
  });

  it("prefers the backend percentage string", () => {
    expect(meterPercent(1, 3, "33.33")).toBeCloseTo(33.33);
  });

  it("returns null for unlimited and handles zero limits", () => {
    expect(meterPercent(10, null)).toBeNull();
    expect(meterPercent(0, 0)).toBe(0);
    expect(meterPercent(1, 0)).toBe(100);
  });

  it("derives tone and text without relying on color", () => {
    expect(meterTone(50)).toBe("normal");
    expect(meterTone(85)).toBe("warning");
    expect(meterTone(100)).toBe("danger");
    expect(meterTone(10, true)).toBe("danger");
    expect(meterStatusText(85)).toBe("Nearing limit");
    expect(meterStatusText(100, true)).toBe("Over limit");
    expect(meterStatusText(null)).toBeNull();
  });

  it("formats tiny USD costs", () => {
    expect(formatUsd("0.001234")).toBe("USD 0.0012");
    expect(formatUsd("0")).toBe("USD 0.00");
    expect(formatUsd(null)).toBe("—");
  });
});

describe("UsageMeter", () => {
  it("exposes an accessible meter with clamped value", () => {
    render(<UsageMeter label="Team members" used={12} limit={10} percentage="120.00" exceeded />);
    const meter = screen.getByRole("meter", { name: "Team members" });
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter.getAttribute("aria-valuetext")).toContain("over limit");
    expect(screen.getByText("Over limit")).toBeInTheDocument();
  });

  it("shows unlimited without a meter", () => {
    render(<UsageMeter label="AI requests" used={3} limit={null} />);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.getByText("No limit on this plan")).toBeInTheDocument();
  });
});

describe("plan change helpers", () => {
  it("extracts exceeded limits from 409 plan_limits_exceeded", () => {
    const error = new ApiError({
      status: 409,
      code: "plan_limits_exceeded",
      message: "Current usage exceeds",
      details: { plan_code: "dev-starter", exceeded: [{ limit: "max_users", label: "team members", allowed: 3, current: 5 }] },
    });
    expect(exceededLimits(error)).toEqual([{ limit: "max_users", label: "team members", allowed: 3, current: 5 }]);
    expect(exceededLimits(new ApiError({ status: 409, code: "conflict", message: "x" }))).toBeNull();
  });

  it("compares numeric limits treating null as unlimited", () => {
    const rows = compareLimits({ max_users: 3, max_storage_mb: null }, { max_users: 10, max_storage_mb: 1024 });
    expect(rows).toEqual([
      { key: "max_users", current: 3, target: 10, direction: "up" },
      { key: "max_storage_mb", current: null, target: 1024, direction: "down" },
    ]);
  });
});
