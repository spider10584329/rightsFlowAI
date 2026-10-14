// @vitest-environment node
import { describe, expect, it } from "vitest";

import { proxiedResponseHeaders } from "@/lib/server/proxy-request";

describe("proxiedResponseHeaders (audit AF-14)", () => {
  it("sandboxes every proxied response, even when the backend sent an HTML file", () => {
    const upstream = new Headers({
      "content-type": "text/html",
      "content-disposition": 'attachment; filename="x.html"',
      "set-cookie": "evil=1",
      "content-security-policy": "default-src *",
    });
    const headers = proxiedResponseHeaders(upstream, "req-12345678");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-security-policy")).toContain("sandbox");
    expect(headers.get("content-security-policy")).not.toContain("default-src *");
    expect(headers.get("content-disposition")).toContain("attachment");
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("x-request-id")).toBe("req-12345678");
    expect(headers.get("cache-control")).toBe("no-store");
  });
});
