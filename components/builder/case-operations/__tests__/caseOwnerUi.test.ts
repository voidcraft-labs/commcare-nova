import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	actingUser,
	fixedLocation,
	literal,
	ownerLocationAtLevel,
	term,
} from "@/lib/domain/predicate";
import {
	caseOwnerCopy,
	caseOwnerMode,
	caseOwnerModeChange,
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

it("states the complete consequence of clearing each owner action", () => {
	expect(caseOwnerCopy("create")).toEqual({
		description:
			"Ownership decides whose device the case reaches. Without this, a new case belongs to the person who submitted the form.",
		clearLabel: "Use the default owner",
		clearTitle: "Use the default owner?",
		clearConsequence: "The case will belong to whoever submits the form.",
	});
	expect(caseOwnerCopy("update")).toEqual({
		description:
			"Ownership decides whose device the case reaches. Leave it unchanged to keep the case's current owner.",
		clearLabel: "Leave the owner alone",
		clearTitle: "Leave the owner alone?",
		clearConsequence: "This change will stop changing the case's owner.",
	});
});

it.each([
	[
		{ ...ready, loading: true },
		"Places are still loading.",
		"Loading saved place",
	],
	[
		{ ...ready, error: "Connection failed." },
		"Places could not be loaded.",
		"Saved place unavailable until places reload",
	],
	[
		{ ...ready, warning: "Connection failed." },
		"Saved places are unavailable until they reload.",
		"Saved place unavailable until places reload",
	],
	[
		{ ...ready, refreshing: true },
		"Saved places are being refreshed.",
		"Refreshing saved place",
	],
	[ready, undefined, undefined],
] as const)(
	"distinguishes read state from a missing saved place (%#)",
	(state, issue, label) => {
		expect(organizationOwnerModeIssue(state)).toBe(issue);
		expect(fixedOwnerModeIssue(state, 1)).toBe(issue);
		expect(fixedOwnerModeIssue(state, 0)).toBe(
			issue ?? "Add a live place at a level that owns cases first.",
		);
		expect(pendingFixedOwnerLabel(state)).toBe(label);
	},
);

it("stages an available picker without changing the authored value, then yields to a replacement or clear", () => {
	const original = actingUser();
	const fixed = term(fixedLocation(testUuid("place")));
	const reverse = term(ownerLocationAtLevel(testUuid("level"), "patient"));
	expect(caseOwnerMode(undefined)).toBe("expression");
	expect(caseOwnerMode(term(literal("owner-id")))).toBe("expression");
	expect(caseOwnerMode(fixed)).toBe("fixed");
	expect(caseOwnerMode(reverse)).toBe("reverse");
	for (const mode of ["fixed", "reverse"] as const) {
		const change = caseOwnerModeChange(mode, original, {});
		expect(change).toEqual({
			kind: "stage",
			draft: { mode, baseValue: original },
		});
		if (change.kind !== "stage") throw new Error("Expected a staged picker");
		expect(change.draft.baseValue).toBe(original);
		expect(caseOwnerMode(original, change.draft)).toBe(mode);
		expect(caseOwnerMode(fixed, change.draft)).toBe("fixed");
		expect(caseOwnerMode(reverse, change.draft)).toBe("reverse");
		expect(caseOwnerMode(undefined, change.draft)).toBe("expression");
		expect(caseOwnerMode(structuredClone(original), change.draft)).toBe(
			"expression",
		);
	}
	expect(original).toEqual({ kind: "acting-user" });
});

it("refuses unavailable or unknown picker modes and explicitly replaces ownership when returning to an expression", () => {
	const fixed = term(fixedLocation(testUuid("place")));
	for (const mode of ["fixed", "reverse"] as const) {
		expect(caseOwnerModeChange(mode, fixed, { [mode]: "Unavailable" })).toEqual(
			{ kind: "ignore" },
		);
	}
	for (const invalid of [undefined, null, "unknown", 0]) {
		expect(caseOwnerModeChange(invalid, fixed, {})).toEqual({ kind: "ignore" });
	}
	expect(
		caseOwnerModeChange("expression", fixed, {
			fixed: "Loading",
			reverse: "Loading",
		}),
	).toEqual({ kind: "change", value: { kind: "acting-user" } });
});
