import { describe, expect, it } from "vitest";
import { uuidSchema } from "@/lib/domain";
import type { Location } from "@/lib/routing/types";
import { previewModeNavigation } from "../previewModeNavigation";

const moduleUuid = uuidSchema.parse("00000000-0000-7000-8000-000000004911");

describe("preview URL transitions", () => {
	it.each(["search-config", "cases", "detail-config"] as const)(
		"preserves the %s authoring surface on both flips",
		(kind) => {
			const location = { kind, moduleUuid };
			expect(previewModeNavigation(true, location)).toBeUndefined();
			expect(previewModeNavigation(false, location)).toBeUndefined();
		},
	);

	it("replaces a running record URL with its module Details only on exit", () => {
		const location: Location = { kind: "cases", moduleUuid, caseId: "case-1" };
		expect(previewModeNavigation(false, location)).toEqual({
			method: "replace",
			location: { kind: "detail-config", moduleUuid },
		});
		expect(previewModeNavigation(true, location)).toBeUndefined();
	});

	it.each(["app-setup", "project-data"] as const)(
		"pushes home from %s on entry and preserves history on exit",
		(kind) => {
			const location: Location =
				kind === "app-setup" ? { kind, section: "users" } : { kind };
			expect(previewModeNavigation(true, location)).toEqual({
				method: "push",
				location: { kind: "home" },
			});
			expect(previewModeNavigation(false, location)).toBeUndefined();
		},
	);
});
