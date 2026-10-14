import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiStatusBanner, connectivityBadge } from "@/components/ai/status-banner";
import type { AIStatus } from "@/lib/api/hooks/ai";

const baseStatus: AIStatus = {
  configured: true,
  provider: "anthropic",
  model: "claude-opus-5-5",
  connectivity: { state: "unverified", last_success_at: null, last_error_code: null, last_error_message: null, last_error_at: null },
  plan_allows_ai: true,
  requests_this_month: 3,
  monthly_limit: 500,
  tokens_this_month: 0,
  estimated_cost_this_month: "0.00",
  advisory_notice: "Advisory.",
};

function renderBanner(status: AIStatus, props: Partial<Parameters<typeof AiStatusBanner>[0]> = {}) {
  return render(<AiStatusBanner status={status} isLoading={false} error={null} onRetry={() => {}} onOpenTab={() => {}} {...props} />);
}

describe("connectivityBadge", () => {
  it("never claims readiness before the provider has answered", () => {
    expect(connectivityBadge(baseStatus.connectivity)).toEqual({
      title: "AI assistant configured",
      label: "Configured · not yet verified",
      tone: "neutral",
    });
    expect(connectivityBadge({ ...baseStatus.connectivity, state: "verified" }).label).toBe("Connected");
    expect(connectivityBadge({ ...baseStatus.connectivity, state: "failing" }).tone).toBe("danger");
  });
});

describe("AiStatusBanner", () => {
  it("shows the failing state with the server's safe reason", () => {
    renderBanner({
      ...baseStatus,
      connectivity: {
        state: "failing",
        last_success_at: null,
        last_error_code: "ai_configuration_error",
        last_error_message: "The AI API key is not scoped to a workspace.",
        last_error_at: new Date().toISOString(),
      },
    });
    expect(screen.getByText("AI provider not working")).toBeInTheDocument();
    expect(screen.getByText("Not working")).toBeInTheDocument();
    expect(screen.getByText(/not scoped to a workspace/)).toBeInTheDocument();
    expect(screen.queryByText("AI assistant ready")).not.toBeInTheDocument();
  });

  it("says ready only once a request has succeeded", () => {
    renderBanner({ ...baseStatus, connectivity: { ...baseStatus.connectivity, state: "verified", last_success_at: new Date().toISOString() } });
    expect(screen.getByText("AI assistant ready")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("offers Test connection to admins only", () => {
    const onCheck = vi.fn();
    const { unmount } = renderBanner(baseStatus, { canCheck: false, onCheckConnection: onCheck });
    expect(screen.queryByRole("button", { name: /test connection/i })).not.toBeInTheDocument();
    unmount();
    renderBanner(baseStatus, { canCheck: true, onCheckConnection: onCheck });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });
});
