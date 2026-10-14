// @vitest-environment node
import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/auth/constants";
import { checkSameOrigin, constantTimeEqual, readCookie, verifyCsrf } from "@/lib/server/csrf";
import { validateBackendPath } from "@/lib/server/proxy-request";

function request(method: string, headers: Record<string, string>) {
  return { method, headers: new Headers(headers) };
}

const HOST = "app.rightsflow.test";

describe("constantTimeEqual", () => {
  it("compares strings exactly", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("readCookie", () => {
  it("reads and decodes a cookie from the header", () => {
    expect(readCookie("a=1; rf_csrf=tok%20en; b=2", "rf_csrf")).toBe("tok en");
    expect(readCookie("a=1", "rf_csrf")).toBeUndefined();
    expect(readCookie(null, "rf_csrf")).toBeUndefined();
  });
});

describe("checkSameOrigin", () => {
  it("accepts a matching Origin", () => {
    expect(checkSameOrigin(new Headers({ host: HOST, origin: `https://${HOST}` }))).toEqual({ ok: true });
  });

  it("rejects a foreign or malformed Origin", () => {
    expect(checkSameOrigin(new Headers({ host: HOST, origin: "https://evil.test" }))).toMatchObject({ ok: false, code: "origin_mismatch" });
    expect(checkSameOrigin(new Headers({ host: HOST, origin: "null" }))).toMatchObject({ ok: false });
    expect(checkSameOrigin(new Headers({ host: HOST, origin: `https://${HOST}.evil.test` }))).toMatchObject({ ok: false });
  });

  it("allows a missing Origin only for same-origin fetch metadata", () => {
    expect(checkSameOrigin(new Headers({ host: HOST, "sec-fetch-site": "same-origin" }))).toEqual({ ok: true });
    expect(checkSameOrigin(new Headers({ host: HOST, "sec-fetch-site": "cross-site" }))).toMatchObject({ ok: false, code: "origin_missing" });
    expect(checkSameOrigin(new Headers({ host: HOST }))).toMatchObject({ ok: false, code: "origin_missing" });
  });

  it("accepts explicitly configured public origins", () => {
    const headers = new Headers({ host: "internal:3000", origin: "https://app.example.com" });
    expect(checkSameOrigin(headers)).toMatchObject({ ok: false });
    expect(checkSameOrigin(headers, { allowedOrigins: ["https://app.example.com/"] })).toEqual({ ok: true });
  });
});

describe("verifyCsrf", () => {
  const sameOrigin = { host: HOST, origin: `https://${HOST}` };

  it("lets safe methods through", () => {
    expect(verifyCsrf(request("GET", { host: HOST, origin: "https://evil.test" }), { requireToken: true })).toEqual({ ok: true });
  });

  it("requires the double-submit token for unsafe methods", () => {
    expect(verifyCsrf(request("POST", sameOrigin), { requireToken: true })).toMatchObject({ ok: false, code: "csrf_missing" });
    expect(
      verifyCsrf(request("POST", { ...sameOrigin, cookie: "rf_csrf=abc", "x-csrf-token": "abd" }), { requireToken: true }),
    ).toMatchObject({ ok: false, code: "csrf_invalid" });
    expect(
      verifyCsrf(request("DELETE", { ...sameOrigin, cookie: "rf_csrf=abc", "x-csrf-token": "abc" }), { requireToken: true }),
    ).toEqual({ ok: true });
  });

  it("checks origin before the token", () => {
    const result = verifyCsrf(
      request("PATCH", { host: HOST, origin: "https://evil.test", cookie: "rf_csrf=abc", "x-csrf-token": "abc" }),
      { requireToken: true },
    );
    expect(result).toMatchObject({ ok: false, code: "origin_mismatch" });
  });

  it("only checks origin when the token is not required (login/register)", () => {
    expect(verifyCsrf(request("POST", sameOrigin), { requireToken: false })).toEqual({ ok: true });
    expect(verifyCsrf(request("POST", { host: HOST, origin: "https://evil.test" }), { requireToken: false })).toMatchObject({ ok: false });
  });
});

describe("validateBackendPath", () => {
  it("accepts v1 paths and re-encodes segments", () => {
    expect(validateBackendPath(["v1", "organizations", "abc", "members"])).toEqual({ ok: true, path: "v1/organizations/abc/members" });
    expect(validateBackendPath(["v1", "files", "a b.csv"])).toEqual({ ok: true, path: "v1/files/a%20b.csv" });
  });

  it("rejects other prefixes, traversal and separators", () => {
    expect(validateBackendPath(["v2", "x"]).ok).toBe(false);
    expect(validateBackendPath(["v1"]).ok).toBe(false);
    expect(validateBackendPath(["v1", "..", "health"]).ok).toBe(false);
    expect(validateBackendPath(["v1", "a/../../b"]).ok).toBe(false);
    expect(validateBackendPath(["v1", "a\\b"]).ok).toBe(false);
    expect(validateBackendPath(["v1", "a\u0000b"]).ok).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps in-app paths and rejects open redirects", () => {
    expect(safeNextPath("/settings/team?tab=invitations")).toBe("/settings/team?tab=invitations");
    expect(safeNextPath("https://evil.test")).toBe("/dashboard");
    expect(safeNextPath("//evil.test")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.test")).toBe("/dashboard");
    expect(safeNextPath("/api/auth/logout")).toBe("/dashboard");
    expect(safeNextPath(null, "/onboarding")).toBe("/onboarding");
  });
});
