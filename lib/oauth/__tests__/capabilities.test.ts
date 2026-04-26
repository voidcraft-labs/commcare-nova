import { describe, expect, it } from "vitest";
import { deriveCapabilities } from "../capabilities";

describe("deriveCapabilities", () => {
	it("describes Nova app permissions as first-class apps", () => {
		expect(
			deriveCapabilities(["openid", "profile", "nova.read", "nova.write"]).map(
				(c) => c.label,
			),
		).toEqual([
			"See your name and email",
			"Read your apps",
			"Create and edit apps on your behalf",
		]);
	});
});
