import { describe, expect, it } from "vitest";
import {
	caseOwnerCopy,
	fixedOwnerModeIssue,
	organizationOwnerModeIssue,
	pendingFixedOwnerLabel,
} from "../caseOwnerUi";

const ready = {
	loading: false,
	error: undefined,
	warning: undefined,
	refreshing: false,
};

describe("case owner authoring copy", () => {
	it("distinguishes a create default from an unchanged update owner", () => {
		expect(caseOwnerCopy("create")).toMatchObject({
			clearLabel: "Use the default owner",
			clearConsequence: "The case will belong to whoever submits the form.",
		});
		expect(caseOwnerCopy("update")).toMatchObject({
			clearLabel: "Leave the owner alone",
			clearConsequence: "This change will stop changing the case's owner.",
		});
	});

	it("keeps fixed ownership discoverable with exact unavailability reasons", () => {
		expect(fixedOwnerModeIssue({ ...ready, loading: true }, 1)).toBe(
			"Places are still loading.",
		);
		expect(
			fixedOwnerModeIssue({ ...ready, error: "Connection failed." }, 1),
		).toBe("Places could not be loaded.");
		expect(
			fixedOwnerModeIssue({ ...ready, warning: "Connection failed." }, 1),
		).toBe("Saved places are unavailable until they reload.");
		expect(fixedOwnerModeIssue({ ...ready, refreshing: true }, 1)).toBe(
			"Saved places are being refreshed.",
		);
		expect(fixedOwnerModeIssue(ready, 0)).toBe(
			"Add a live place at a level that owns cases first.",
		);
		expect(fixedOwnerModeIssue(ready, 1)).toBeUndefined();
		expect(organizationOwnerModeIssue(ready)).toBeUndefined();
		expect(pendingFixedOwnerLabel({ ...ready, loading: true })).toBe(
			"Loading saved place",
		);
		expect(
			pendingFixedOwnerLabel({ ...ready, error: "Connection failed." }),
		).toBe("Saved place unavailable until places reload");
		expect(
			pendingFixedOwnerLabel({ ...ready, warning: "Connection failed." }),
		).toBe("Saved place unavailable until places reload");
		expect(pendingFixedOwnerLabel({ ...ready, refreshing: true })).toBe(
			"Refreshing saved place",
		);
		expect(pendingFixedOwnerLabel(ready)).toBeUndefined();
	});
});
