import { test, expect } from "bun:test";
import {
  decide,
  isSecureRequest,
  secureHostFrom,
  type GuardInput,
} from "./guard";

const allow = {
  allowedHosts: ["100.100.100.100:4444", "dev.your-tailnet.ts.net:8444"],
  allowedOrigins: ["http://100.100.100.100:4444", "https://dev.your-tailnet.ts.net:8444"],
};

// A well-formed authenticated API request, with per-test overrides.
const api = (over: Partial<GuardInput> = {}) =>
  decide({
    pathname: "/api/state",
    host: allow.allowedHosts[0],
    origin: null,
    tokenValid: false,
    ...allow,
    ...over,
  });

test("static shell is served without a token, from any host", () => {
  expect(decide({ pathname: "/", host: null, origin: null, tokenValid: false, ...allow }).allow).toBe(true);
  expect(decide({ pathname: "/assets/index.js", host: "evil.com", origin: null, tokenValid: false, ...allow }).allow).toBe(true);
});

test("health is always open", () => {
  expect(decide({ pathname: "/api/health", host: "anything", origin: null, tokenValid: false, ...allow }).allow).toBe(true);
});

test("api without a token → 401", () => {
  const v = api();
  expect(v.allow).toBe(false);
  if (!v.allow) {
    expect(v.status).toBe(401);
    expect(v.reason).toBe("no-token");
  }
});

test("api with a valid token → allowed", () => {
  expect(api({ tokenValid: true }).allow).toBe(true);
});

test("bad host → 403 (anti-rebind), even with a valid token", () => {
  const v = api({ host: "10.0.0.1:4444", tokenValid: true });
  expect(v.allow).toBe(false);
  if (!v.allow) {
    expect(v.status).toBe(403);
    expect(v.reason).toBe("bad-host");
  }
});

test("missing host on an api call → 403", () => {
  const v = api({ host: null, tokenValid: true });
  expect(v.allow).toBe(false);
  if (!v.allow) expect(v.status).toBe(403);
});

test("cross-origin → 403 (anti-CSRF), even with a valid token", () => {
  const v = api({ origin: "https://evil.example", tokenValid: true });
  expect(v.allow).toBe(false);
  if (!v.allow) {
    expect(v.status).toBe(403);
    expect(v.reason).toBe("bad-origin");
  }
});

test("same-origin (no Origin header) with a token → allowed", () => {
  expect(api({ origin: null, tokenValid: true }).allow).toBe(true);
});

test("an allowlisted Origin → allowed", () => {
  expect(api({ origin: allow.allowedOrigins[1], tokenValid: true }).allow).toBe(true);
});

test("enroll is reachable without a token, but host/origin are enforced", () => {
  const good = decide({
    pathname: "/api/enroll",
    host: allow.allowedHosts[0],
    origin: allow.allowedOrigins[0],
    tokenValid: false,
    ...allow,
  });
  expect(good.allow).toBe(true);

  const badHost = decide({
    pathname: "/api/enroll",
    host: "evil:4444",
    origin: null,
    tokenValid: false,
    ...allow,
  });
  expect(badHost.allow).toBe(false);
  if (!badHost.allow) expect(badHost.status).toBe(403);
});

test("isSecureRequest: true on https proto or a matching secure Host, else false", () => {
  const sh = "dev.your-tailnet.ts.net:8444";
  expect(isSecureRequest("https", null, sh)).toBe(true); // proxy set proto
  expect(isSecureRequest(null, sh, sh)).toBe(true); // Host matches (the real path)
  expect(isSecureRequest(null, "100.100.100.100:4444", sh)).toBe(false); // raw http host
  expect(isSecureRequest(null, null, sh)).toBe(false); // no host
  expect(isSecureRequest(null, "anything", "")).toBe(false); // secureHost unconfigured
});

// HSTS is only honest on a route that really is HTTPS. The enroll URL is the
// only place the secure Host comes from, so a non-HTTPS one must designate
// nothing — otherwise a plaintext response carries a strict-transport promise.
test("secureHostFrom accepts only an https enroll URL", () => {
  expect(secureHostFrom("https://dev.your-tailnet.ts.net:8444")).toBe(
    "dev.your-tailnet.ts.net:8444",
  );
  expect(secureHostFrom("http://dev.your-tailnet.ts.net:8444")).toBe("");
  expect(secureHostFrom("http://127.0.0.1:4455")).toBe("");
  expect(secureHostFrom("")).toBe("");
  expect(secureHostFrom("not a url")).toBe("");
});

test("a plaintext enroll URL cannot make its own host secure", () => {
  const sh = secureHostFrom("http://127.0.0.1:4455");
  expect(isSecureRequest(null, "127.0.0.1:4455", sh)).toBe(false);
});

test("empty allowlists fail closed — every api call denied", () => {
  const v = decide({
    pathname: "/api/state",
    host: "100.100.100.100:4444",
    origin: null,
    tokenValid: true,
    allowedHosts: [],
    allowedOrigins: [],
  });
  expect(v.allow).toBe(false); // host not in (empty) allowlist
});
