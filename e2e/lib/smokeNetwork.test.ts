import { afterEach, expect, it, vi } from "vitest";
import { smokeNetworkHeaders } from "./smokeNetwork";

afterEach(() => vi.unstubAllEnvs());
it("owns distinct IPv6 subnets through the local two-hop proxy contract", () => {
	vi.stubEnv("SMOKE_MANAGE_SERVER", "1");
	vi.stubEnv("SMOKE_LANE", "app");
	const first = smokeNetworkHeaders("http://localhost:3000")["x-forwarded-for"];
	const second = smokeNetworkHeaders("http://localhost:3000")[
		"x-forwarded-for"
	];
	expect(first).toMatch(/^fd00:(?:[a-f0-9]{1,4}:){3}:1, 127\.0\.0\.1$/);
	expect(first).not.toBe(second);
});
it("does not add a network identity to remote probes, unmanaged servers or component peers", () => {
	vi.stubEnv("SMOKE_MANAGE_SERVER", "1");
	vi.stubEnv("SMOKE_LANE", "app");
	expect(smokeNetworkHeaders("https://nova.dimagi.com")).toEqual({});
	expect(smokeNetworkHeaders(undefined)).toEqual({});
	vi.stubEnv("SMOKE_MANAGE_SERVER", "0");
	expect(smokeNetworkHeaders("http://localhost:3000")).toEqual({});
	vi.stubEnv("SMOKE_MANAGE_SERVER", "1");
	vi.stubEnv("SMOKE_LANE", "browser");
	expect(smokeNetworkHeaders("http://localhost:3000")).toEqual({});
});
