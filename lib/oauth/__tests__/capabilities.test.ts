import { describe, expect, it } from "vitest";
import { deriveCapabilities } from "../capabilities";

describe("deriveCapabilities", () => {
	it("describes Nova app permissions as first-class apps", () => {
		expect(
			deriveCapabilities([
				"openid",
				"offline_access",
				"profile",
				"email",
				"profile",
				"nova.write",
				"nova.read",
				"nova.write",
			]).map((c) => c.label),
		).toEqual([
			"See your name and email",
			"Read your apps",
			"Create and edit apps on your behalf",
		]);
	});
	it("shows no capability for protocol-only or empty scopes", () => {
		expect(deriveCapabilities([])).toEqual([]);
		expect(deriveCapabilities(["openid", "offline_access"])).toEqual([]);
	});

	it("keeps HQ and Project permissions distinct from app permissions", () => {
		const scopes = [
			"nova.hq.read",
			"nova.hq.write",
			"nova.projects.read",
			"nova.projects.write",
		];
		expect(deriveCapabilities(scopes).map(({ key }) => key)).toEqual(scopes);
	});

	it("discloses an unfamiliar scope once alongside known permissions", () => {
		expect(
			deriveCapabilities(["vendor.extra", "nova.read", "vendor.extra"]).map(
				({ key, label }) => ({ key, label }),
			),
		).toEqual([
			{ key: "nova.read", label: "Read your apps" },
			{ key: "unknown:vendor.extra", label: "Access to vendor.extra" },
		]);
	});
});
