import { describe, expect, it } from "vitest";

import { clientContextHeaders, trustedClientIp } from "@/lib/server/backend";

const headers = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

describe("trustedClientIp (audit A-02)", () => {
  it("never forwards a client-supplied X-Forwarded-For when no proxy is trusted", () => {
    expect(trustedClientIp(headers("198.51.100.77"), 0)).toBeNull();
    expect(clientContextHeaders(headers("198.51.100.77"), "req-12345678").get("x-forwarded-for")).toBeNull();
  });

  it("takes the address appended by the trusted proxy, ignoring spoofed entries on the left", () => {
    // Client sent "1.1.1.1"; our load balancer appended the real 203.0.113.9.
    expect(trustedClientIp(headers("1.1.1.1, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(trustedClientIp(headers("1.1.1.1, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
  });

  it("rejects short chains and non-IP values", () => {
    expect(trustedClientIp(headers("203.0.113.9"), 2)).toBeNull();
    expect(trustedClientIp(headers("evil<script>"), 1)).toBeNull();
    expect(trustedClientIp(headers(), 1)).toBeNull();
  });
});
