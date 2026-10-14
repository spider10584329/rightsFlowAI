import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, apiUrl, buildQueryString, filenameFromDisposition, setUnauthorizedHandler } from "@/lib/api/client";
import { ApiError, errorMessage, fieldErrors, parseApiError, validationIssues } from "@/lib/api/errors";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("parseApiError", () => {
  it("reads the RightsFlow error envelope", () => {
    const error = parseApiError(409, {
      error: { code: "conflict", message: "Slug already in use", details: { field: "slug" } },
      detail: "Slug already in use",
      request_id: "req-123456",
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("Slug already in use");
    expect(error.details).toEqual({ field: "slug" });
    expect(error.requestId).toBe("req-123456");
  });

  it("falls back to FastAPI's plain detail shape and the header request id", () => {
    const error = parseApiError(404, { detail: "Not Found" }, "hdr-req-1");
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Not Found");
    expect(error.requestId).toBe("hdr-req-1");
    expect(error.isNotFound).toBe(true);
  });

  it("uses a friendly default for non-JSON bodies", () => {
    const html = parseApiError(502, "<html>Bad gateway</html>");
    expect(html.code).toBe("server_error");
    expect(html.message).toBe("The service is temporarily unreachable.");
    const text = parseApiError(400, "Plain text problem");
    expect(text.message).toBe("Plain text problem");
  });

  it("extracts validation issues and field errors", () => {
    const error = parseApiError(422, {
      error: {
        code: "validation_failed",
        message: "Request validation failed",
        details: [
          { loc: ["body", "slug"], message: "String should match pattern", type: "string_pattern_mismatch" },
          { loc: ["body", "password"], message: "Value error, Password is too repetitive", type: "value_error" },
        ],
      },
      request_id: "r-12345678",
    });
    expect(validationIssues(error)).toHaveLength(2);
    expect(fieldErrors(error)).toEqual({ slug: "String should match pattern", password: "Password is too repetitive" });
    expect(errorMessage(error)).toBe("Request validation failed");
  });

  it("returns a single validation message directly", () => {
    const error = parseApiError(422, {
      error: { code: "validation_failed", message: "Request validation failed", details: [{ loc: ["body", "email"], message: "Invalid email" }] },
    });
    expect(errorMessage(error)).toBe("Invalid email");
  });
});

describe("query helpers", () => {
  it("builds query strings, skipping empty values and expanding arrays", () => {
    expect(buildQueryString({ page: 2, q: "", sort: undefined, unread_only: true, status: ["a", "b"], x: null })).toBe(
      "?page=2&unread_only=true&status=a&status=b",
    );
    expect(buildQueryString(undefined)).toBe("");
    expect(apiUrl("/organizations", { page: 1 })).toBe("/api/backend/v1/organizations?page=1");
    expect(apiUrl("auth/me")).toBe("/api/backend/v1/auth/me");
  });

  it("parses content-disposition filenames", () => {
    expect(filenameFromDisposition('attachment; filename="statement Q1.csv"')).toBe("statement Q1.csv");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe("résumé.pdf");
    expect(filenameFromDisposition(null)).toBeNull();
  });
});

describe("api client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    document.cookie = "rf_csrf=token-abc; path=/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    setUnauthorizedHandler(null);
    document.cookie = "rf_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("calls the BFF and returns JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: "u1" }));
    await expect(api.get<{ id: string }>("/auth/me")).resolves.toEqual({ id: "u1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/backend/v1/auth/me");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).has("x-csrf-token")).toBe(false);
  });

  it("sends JSON bodies with the CSRF header on unsafe methods", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "o1" }));
    await api.post("/organizations", { body: { name: "Acme", slug: "acme" } });
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-csrf-token")).toBe("token-abc");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ name: "Acme", slug: "acme" }));
  });

  it("does not set a content-type for multipart uploads", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const form = new FormData();
    form.append("file", new Blob(["a,b"]), "statement.csv");
    await api.post("/files", { formData: form });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
    expect(init?.body).toBe(form);
  });

  it("throws a typed ApiError from the error envelope", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        403,
        { error: { code: "forbidden", message: "Insufficient organization permissions", details: null }, request_id: "abc-12345" },
        { "x-request-id": "abc-12345" },
      ),
    );
    const error = await api.delete("/organizations/o1/members/m1").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", message: "Insufficient organization permissions", requestId: "abc-12345" });
  });

  it("invokes the unauthorized handler on 401 unless skipped", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockImplementation(async () => jsonResponse(401, { error: { code: "unauthorized", message: "Expired" } }));
    await expect(api.get("/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(api.get("/auth/me", { skipAuthRedirect: true })).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("maps network failures to a network ApiError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await api.get("/organizations").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: "network_error" });
  });

  it("returns null for 204 responses", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.delete("/notifications/n1")).resolves.toBeNull();
  });
});
