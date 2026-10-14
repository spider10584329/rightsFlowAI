import { describe, expect, it } from "vitest";

import { buildHistory, validateQuestion, type ChatMessage } from "@/components/ai/chat";
import { describeAiError } from "@/components/ai/errors";
import { validatePeriod } from "@/components/ai/report-panel";
import { changeRows } from "@/components/ai/suggestions-panel";
import { ApiError } from "@/lib/api/errors";
import type { AssistantResponse } from "@/lib/api/hooks/ai";

const apiError = (status: number, code: string, message = "msg") => new ApiError({ status, code, message });

describe("describeAiError", () => {
  it("maps 503 ai_not_configured to the not-configured state", () => {
    const info = describeAiError(apiError(503, "ai_not_configured"));
    expect(info.kind).toBe("not_configured");
    expect(info.title).toBe("AI provider not configured");
    expect(info.message).toContain("AI_PROVIDER");
    expect(info.message).toContain("AI_API_KEY");
    expect(info.retryable).toBe(false);
  });

  it("distinguishes the 402 monthly limit from a feature missing in the plan", () => {
    const limit = describeAiError(apiError(402, "plan_limit_exceeded", "Your plan allows 50 AI requests"));
    expect(limit.kind).toBe("limit_reached");
    expect(limit.billingLink).toBe(true);
    expect(limit.message).toContain("50");
    const feature = describeAiError(apiError(402, "feature_not_available"));
    expect(feature.kind).toBe("feature_unavailable");
    expect(feature.billingLink).toBe(true);
  });

  it("maps 502 provider errors with specific titles", () => {
    expect(describeAiError(apiError(502, "ai_provider_error")).kind).toBe("provider_error");
    expect(describeAiError(apiError(502, "ai_timeout")).title).toBe("The AI provider timed out");
    const refused = describeAiError(apiError(502, "ai_refused"));
    expect(refused.title).toBe("The AI model declined this request");
    expect(refused.retryable).toBe(false);
  });

  it("gives configuration problems actionable, non-retryable messages for administrators", () => {
    const cases: [string, string][] = [
      ["ai_configuration_error", "Invalid AI configuration"],
      ["ai_model_unavailable", "Invalid AI model configuration"],
      ["ai_auth_failed", "AI provider credentials rejected"],
      ["ai_permission_denied", "AI provider access denied"],
      ["ai_billing", "AI provider account needs attention"],
    ];
    for (const [code, title] of cases) {
      const info = describeAiError(apiError(502, code, "Server-side safe message."));
      expect(info).toMatchObject({ kind: "provider_config", title, retryable: false, billingLink: false });
      expect(info.message).toContain("Server-side safe message.");
      expect(info.message).toContain("administrator");
    }
  });

  it("lets people retry transient provider failures but not invalid requests", () => {
    for (const [code, title] of [
      ["ai_unavailable", "AI provider temporarily unavailable"],
      ["ai_rate_limited", "AI provider is busy"],
      ["ai_unreachable", "Can't reach the AI provider"],
    ]) {
      expect(describeAiError(apiError(502, code))).toMatchObject({ kind: "provider_error", title, retryable: true });
    }
    expect(describeAiError(apiError(502, "ai_invalid_request"))).toMatchObject({
      title: "AI request could not be processed",
      retryable: false,
    });
    // An unknown 502 code still falls back to the generic provider state.
    expect(describeAiError(apiError(502, "something_new")).title).toBe("AI provider error");
  });

  it("maps 429, 403, 422 and unknown errors", () => {
    expect(describeAiError(apiError(429, "rate_limited")).kind).toBe("rate_limited");
    expect(describeAiError(apiError(403, "forbidden")).title).toBe("Manager role required");
    expect(describeAiError(apiError(422, "validation_failed")).kind).toBe("invalid");
    expect(describeAiError(new Error("boom")).kind).toBe("unknown");
  });
});

describe("chat history", () => {
  const response = {} as AssistantResponse;

  it("keeps only the last 10 user/assistant turns and skips errors", () => {
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 8; index += 1) {
      messages.push({ id: `u${index}`, role: "user", content: `q${index}` });
      messages.push({ id: `a${index}`, role: "assistant", content: `a${index}`, response });
    }
    messages.push({ id: "e", role: "error", question: "x", error: new Error("x") });
    const history = buildHistory(messages);
    expect(history).toHaveLength(10);
    expect(history[0]).toEqual({ role: "user", content: "q3" });
    expect(history[9]).toEqual({ role: "assistant", content: "a7" });
  });

  it("trims turns to the 4000-character backend limit", () => {
    const history = buildHistory([{ id: "a", role: "assistant", content: "x".repeat(5000), response }]);
    expect(history[0].content).toHaveLength(4000);
  });

  it("validates question length like the backend", () => {
    expect(validateQuestion(" a ")).not.toBeNull();
    expect(validateQuestion("ok")).toBeNull();
    expect(validateQuestion("x".repeat(2001))).not.toBeNull();
  });
});

describe("suggestion diff and report period", () => {
  it("turns proposed changes into from/to rows", () => {
    expect(changeRows({ title: { from: "hello", to: "Hello" }, raw: "value" })).toEqual([
      { field: "title", from: "hello", to: "Hello", hasFrom: true },
      { field: "raw", from: undefined, to: "value", hasFrom: false },
    ]);
  });

  it("rejects an end date before the start date", () => {
    expect(validatePeriod("2026-02-01", "2026-01-01")).toHaveProperty("period_end");
    expect(validatePeriod("2026-01-01", "2026-02-01")).toEqual({});
    expect(validatePeriod("", "2026-02-01")).toEqual({});
  });
});
