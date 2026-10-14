import { errorMessage, isApiError } from "@/lib/api/errors";

export type AiErrorKind =
  | "not_configured"
  | "limit_reached"
  | "feature_unavailable"
  | "provider_error"
  | "provider_config"
  | "rate_limited"
  | "forbidden"
  | "invalid"
  | "conflict"
  | "unknown";

export interface AiErrorInfo {
  kind: AiErrorKind;
  title: string;
  message: string;
  /** Link to billing when a plan change would help. */
  billingLink: boolean;
  /** Whether trying again may succeed without changing anything. */
  retryable: boolean;
}

export const AI_NOT_CONFIGURED_HELP =
  "An administrator must set AI_PROVIDER (anthropic or openai_compatible) and AI_API_KEY in the server environment, then restart the backend.";

/**
 * Provider failures by code. The server sends only its own safe message (never the
 * provider's raw response), so that message is shown as is.
 * `admin`: only an administrator can fix it (configuration), so retrying won't help.
 */
const PROVIDER_ERRORS: Record<string, { title: string; retryable: boolean; admin?: boolean }> = {
  ai_configuration_error: { title: "Invalid AI configuration", retryable: false, admin: true },
  ai_model_unavailable: { title: "Invalid AI model configuration", retryable: false, admin: true },
  ai_auth_failed: { title: "AI provider credentials rejected", retryable: false, admin: true },
  ai_permission_denied: { title: "AI provider access denied", retryable: false, admin: true },
  ai_billing: { title: "AI provider account needs attention", retryable: false, admin: true },
  ai_rate_limited: { title: "AI provider is busy", retryable: true },
  ai_unavailable: { title: "AI provider temporarily unavailable", retryable: true },
  ai_unreachable: { title: "Can't reach the AI provider", retryable: true },
  ai_timeout: { title: "The AI provider timed out", retryable: true },
  ai_invalid_request: { title: "AI request could not be processed", retryable: false },
  ai_invalid_output: { title: "The AI response was not usable", retryable: true },
  ai_refused: { title: "The AI model declined this request", retryable: false },
  ai_truncated: { title: "The AI response was cut off", retryable: true },
  ai_provider_error: { title: "AI provider error", retryable: true },
};

export const AI_ADMIN_FIX_HINT = "An administrator needs to fix the server's AI settings; trying again won't help until then.";

/**
 * Maps AI endpoint failures to distinct, user-facing states:
 * 503 ai_not_configured, 402 plan limit / feature not in plan, 502 provider
 * errors, 429 rate limiting, 403 role, 422 validation.
 */
export function describeAiError(error: unknown): AiErrorInfo {
  const message = errorMessage(error);
  if (!isApiError(error)) {
    return { kind: "unknown", title: "Something went wrong", message, billingLink: false, retryable: true };
  }
  if (error.code === "ai_not_configured") {
    return { kind: "not_configured", title: "AI provider not configured", message: AI_NOT_CONFIGURED_HELP, billingLink: false, retryable: false };
  }
  if (error.status === 402 && error.code === "feature_not_available") {
    return {
      kind: "feature_unavailable",
      title: "AI is not included in your plan",
      message: "Switch to a plan with AI assistance to use this feature.",
      billingLink: true,
      retryable: false,
    };
  }
  if (error.status === 402) {
    return { kind: "limit_reached", title: "Monthly AI limit reached", message, billingLink: true, retryable: false };
  }
  const provider = PROVIDER_ERRORS[error.code];
  if (provider || error.status === 502) {
    const known = provider ?? PROVIDER_ERRORS.ai_provider_error;
    return {
      kind: known.admin ? "provider_config" : "provider_error",
      title: known.title,
      message: known.admin ? `${message} ${AI_ADMIN_FIX_HINT}` : message,
      billingLink: false,
      retryable: known.retryable,
    };
  }
  if (error.status === 429) {
    return { kind: "rate_limited", title: "Too many requests", message, billingLink: false, retryable: true };
  }
  if (error.status === 403) {
    return { kind: "forbidden", title: "Manager role required", message: "Only managers, admins and owners can run AI features.", billingLink: false, retryable: false };
  }
  if (error.status === 422) {
    return { kind: "invalid", title: "Check your input", message, billingLink: false, retryable: false };
  }
  if (error.status === 409) {
    return { kind: "conflict", title: "Can't do that right now", message, billingLink: false, retryable: false };
  }
  return { kind: "unknown", title: "Something went wrong", message, billingLink: false, retryable: true };
}

/** The advisory label every AI-generated output must carry. */
export const AI_ADVISORY_LABEL = "AI-generated · advisory — verify before relying on it. Not legal advice.";
