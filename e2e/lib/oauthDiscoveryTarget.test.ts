import { expect, it } from "vitest";
import { oauthDiscoveryTarget } from "./oauthDiscoveryTarget";

it("accepts the served local artifact and exact production origin", () => {
	for (const target of [
		"http://localhost:3000",
		"http://127.0.0.1:3100",
		"http://[::1]:3000",
	])
		expect(oauthDiscoveryTarget(target)).toBe("local");
	expect(oauthDiscoveryTarget("https://commcare.app/")).toBe("production");
});

it.each([
	"https://staging.commcare.app",
	"http://192.168.1.25:3000",
	"http://commcare.app",
	"https://commcare.app:8443",
	"https://commcare.app.example.com",
	"https://user:secret@commcare.app",
])(
	"refuses unsupported discovery target %s instead of probing production",
	(target) => {
		expect(() => oauthDiscoveryTarget(target)).toThrow(
			"configured target is unsupported",
		);
	},
);
