import { describe, expect, it } from "vitest";
import { readReactProfilerConfig } from "./reactProfiler";

const enabledEnv: NodeJS.ProcessEnv = {
	NODE_ENV: "development",
	NOVA_REACT_PROFILE: "1",
	NOVA_REACT_PROFILE_PORT: "49152",
	NOVA_REACT_PROFILE_TOKEN: "a".repeat(43),
	NOVA_REACT_PROFILE_ORIGIN: "http://127.0.0.1:3100",
};

describe("readReactProfilerConfig", () => {
	it("admits a complete loopback-only development configuration", () => {
		expect(readReactProfilerConfig(enabledEnv)).toEqual({
			enabled: true,
			bridgeHost: "127.0.0.1",
			bridgePort: 49_152,
			browserOrigin: "http://127.0.0.1:3100",
			token: "a".repeat(43),
			webSocketSource: "ws://127.0.0.1:49152",
		});
	});

	it("stays disabled in production even if every opt-in variable is present", () => {
		expect(
			readReactProfilerConfig({ ...enabledEnv, NODE_ENV: "production" }),
		).toEqual({ enabled: false });
	});

	it("fails closed when an enabled development process lacks its secret", () => {
		expect(() =>
			readReactProfilerConfig({
				...enabledEnv,
				NOVA_REACT_PROFILE_TOKEN: undefined,
			}),
		).toThrow(/NOVA_REACT_PROFILE_TOKEN is missing/);
	});

	it.each([
		"https://127.0.0.1:3100",
		"http://commcare.app",
		"http://127.0.0.1:3100/path",
	])("rejects a non-loopback or non-origin browser address: %s", (origin) => {
		expect(() =>
			readReactProfilerConfig({
				...enabledEnv,
				NOVA_REACT_PROFILE_ORIGIN: origin,
			}),
		).toThrow(/loopback HTTP origin/);
	});
});
