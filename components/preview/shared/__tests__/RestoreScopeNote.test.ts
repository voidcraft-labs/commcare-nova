// The reveal's copy has to work in two grammatical persons: previewing as
// yourself is second ("your device") and previewing as a persona is third
// ("Amara's device"). Passing a name string and interpolating it produced
// "You would not have them on their device" on the DEFAULT path, which is
// why the label is a discriminant.

import { describe, expect, it } from "vitest";
import {
	type PreviewWorkerLabel,
	restoreScopeEmptyCopy,
} from "@/components/preview/shared/RestoreScopeNote";

const ME: PreviewWorkerLabel = { kind: "me" };
const AMARA: PreviewWorkerLabel = { kind: "persona", name: "Amara" };

describe("restoreScopeEmptyCopy", () => {
	it("addresses the signed-in member in the second person", () => {
		const copy = restoreScopeEmptyCopy(400, ME);
		expect(copy.title).toBe("None of these cases would be on your device");
		expect(copy.title).not.toContain("their");
		// Previewing as yourself IS a worker assigned nowhere, so the reason is
		// the absent assignment, not one that needs changing.
		expect(copy.description).toContain("not assigned to a place");
		expect(copy.description).toContain("Preview as one of your workers");
	});

	it("addresses a persona by name in the third person", () => {
		const copy = restoreScopeEmptyCopy(400, AMARA);
		expect(copy.title).toBe("None of these cases would be on Amara's device");
		expect(copy.description).not.toContain("your");
		expect(copy.description).toContain("Change Amara's assignment");
	});

	it("says how much the project holds, so the emptiness is attributable", () => {
		expect(restoreScopeEmptyCopy(1200, ME).description).toContain("1,200");
	});

	it("agrees in number for a single case", () => {
		const copy = restoreScopeEmptyCopy(1, AMARA);
		expect(copy.description).toContain("1 case ");
		expect(copy.description).not.toContain("1 cases");
	});
});
