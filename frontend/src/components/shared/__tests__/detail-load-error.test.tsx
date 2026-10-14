import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DetailLoadError, detailLoadFailure } from "@/components/shared/detail-load-error";
import { ApiError } from "@/lib/api/errors";

const notFound = new ApiError({ status: 404, code: "not_found", message: "Payout batch not found" });
const serverError = new ApiError({ status: 500, code: "internal_error", message: "Internal server error", requestId: "req-1" });

function renderError(error: unknown) {
  const onRetry = vi.fn();
  render(
    <DetailLoadError error={error} noun="Payout batch" breadcrumbs={[{ label: "Payouts", href: "/payouts" }]} backHref="/payouts" backLabel="Back to payouts" onRetry={onRetry} />,
  );
  return onRetry;
}

describe("detailLoadFailure", () => {
  it("separates missing records from failures", () => {
    expect(detailLoadFailure(notFound)).toBe("not-found");
    expect(detailLoadFailure(null)).toBe("not-found");
    expect(detailLoadFailure(serverError)).toBe("error");
    expect(detailLoadFailure(new ApiError({ status: 403, code: "forbidden", message: "Forbidden" }))).toBe("error");
    expect(detailLoadFailure(new Error("boom"))).toBe("error");
  });
});

describe("DetailLoadError", () => {
  it("shows a not-found page with a heading and a back link, not a retry", () => {
    renderError(notFound);
    expect(screen.getByRole("heading", { level: 1, name: "Payout batch not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to payouts" })).toHaveAttribute("href", "/payouts");
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Not found");
  });

  it("shows the error with a retry and an error breadcrumb for server failures", () => {
    const onRetry = renderError(serverError);
    expect(screen.getByRole("heading", { level: 1, name: "Payout batch" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    screen.getByRole("button", { name: /try again/i }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Error");
    expect(breadcrumb).not.toHaveTextContent("Not found");
  });
});
