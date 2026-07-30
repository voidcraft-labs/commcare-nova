import { describe, expect, it } from "vitest";
import { compareUtf8Bytes } from "@/lib/auth/migrations/20260728010000_apps_project_tenancy";

describe("Project-reference tenancy frozen ordering", () => {
	it("orders names by explicit UTF-8 bytes instead of the host locale", () => {
		const names = ["éclair", "zebra", "ábaco", "alpha", "Zulu"];

		expect([...names].sort(compareUtf8Bytes)).toEqual([
			"Zulu",
			"alpha",
			"zebra",
			"ábaco",
			"éclair",
		]);
	});
});
