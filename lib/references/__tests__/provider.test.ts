import { describe, expect, it } from "vitest";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import {
	type CaseType,
	reachableCaseTypes,
	toReachableIndex,
} from "@/lib/domain";
import { ReferenceProvider } from "../provider";

/** Minimal lint context carrying just the `#form/` slice this suite exercises.
 *  No case type — case refs are covered by the per-type suite below. */
function formCtx(
	formUuid: string,
	entries: Array<[path: string, label: string]>,
): XPathLintContext {
	return {
		formUuid,
		validPaths: new Set(entries.map(([p]) => `/data/${p}`)),
		reachableCaseTypes: undefined,
		formEntries: entries.map(([path, label]) => ({
			path,
			label,
			kind: "text" as const,
		})),
		formType: "followup" as const,
	};
}

/** A lint context for a form on `caseType`, with its reachable case-type index
 *  derived from the shared `caseTypes` list the same way `buildLintContext` does. */
function caseCtx(
	formUuid: string,
	caseType: string,
	caseTypes: CaseType[],
	formType: XPathLintContext["formType"] = "followup",
): XPathLintContext {
	return {
		formUuid,
		validPaths: new Set(),
		reachableCaseTypes: toReachableIndex(
			reachableCaseTypes(caseType, caseTypes),
		),
		formEntries: [],
		formType,
	};
}

describe("ReferenceProvider — form-entry cache is keyed per form", () => {
	/* The cache is a Map keyed by form uuid: the sidebar resolves refs across
	 * many forms in one render, so each form's index lives under its own key and
	 * a form switch never thrashes another form's cache. */
	it("resolves each form's own field against its own scope", () => {
		const contexts: Record<string, XPathLintContext> = {
			formA: formCtx("formA", [["visit_grp/edd_final", "EDD"]]),
			formB: formCtx("formB", [["preg_grp/ga_weeks", "Gestational age"]]),
		};
		const provider = new ReferenceProvider((id) => contexts[id]);

		expect(provider.resolve("#form/visit_grp/edd_final", "formA")?.path).toBe(
			"visit_grp/edd_final",
		);
		expect(provider.resolve("#form/preg_grp/ga_weeks", "formB")?.path).toBe(
			"preg_grp/ga_weeks",
		);
		// Form A's field doesn't resolve against form B's scope.
		expect(provider.resolve("#form/visit_grp/edd_final", "formB")).toBeNull();
	});

	it("rebuilds a form's cache when invalidate() fires (mutation)", () => {
		let entries: Array<[string, string]> = [["g/a", "A"]];
		const provider = new ReferenceProvider(() => formCtx("formA", entries));
		expect(provider.resolve("#form/g/a", "formA")?.path).toBe("g/a");

		// A field added by a mutation. Same form → invalidate is what surfaces it.
		entries = [
			["g/a", "A"],
			["g/b", "B"],
		];
		expect(provider.resolve("#form/g/b", "formA")).toBeNull(); // stale until invalidate
		provider.invalidate();
		expect(provider.resolve("#form/g/b", "formA")?.path).toBe("g/b");
	});

	it("a form ref needs a form scope — no formUuid resolves to null", () => {
		const provider = new ReferenceProvider(() =>
			formCtx("formA", [["g/a", "A"]]),
		);
		expect(provider.resolve("#form/g/a")).toBeNull();
	});
});

describe("ReferenceProvider.parse — namespace classification", () => {
	it("classifies a case-type namespace as a case ref carrying caseType", () => {
		expect(ReferenceProvider.parse("#mother/household_code")).toEqual({
			type: "case",
			caseType: "mother",
			path: "household_code",
		});
	});

	it("classifies the fixed form/user namespaces", () => {
		expect(ReferenceProvider.parse("#form/group1/age")).toEqual({
			type: "form",
			path: "group1/age",
		});
		expect(ReferenceProvider.parse("#user/username")).toEqual({
			type: "user",
			path: "username",
		});
	});

	it("rejects a malformed namespace or empty path", () => {
		expect(ReferenceProvider.parse("#1bad/x")).toBeNull();
		expect(ReferenceProvider.parse("#mother/")).toBeNull();
		expect(ReferenceProvider.parse("no-hash")).toBeNull();
	});
});

describe("ReferenceProvider.resolve — per-case-type scoping", () => {
	// pregnancy → mother (parent); child → mother (parent). So from a pregnancy
	// form, mother is an ancestor (reachable); from a mother form, pregnancy and
	// child are children (NOT reachable).
	const caseTypes: CaseType[] = [
		{
			name: "mother",
			properties: [{ name: "household_code", label: "Household code" }],
		},
		{
			name: "pregnancy",
			parent_type: "mother",
			properties: [{ name: "edd", label: "EDD" }],
		},
		{
			name: "child",
			parent_type: "mother",
			properties: [{ name: "vaccine", label: "Vaccine" }],
		},
	];

	const provider = new ReferenceProvider((formUuid) => {
		if (formUuid === "formMother")
			return caseCtx("formMother", "mother", caseTypes);
		if (formUuid === "formPreg")
			return caseCtx("formPreg", "pregnancy", caseTypes);
		return undefined;
	});

	it("resolves an own-type property to a chip", () => {
		const ref = provider.resolve("#mother/household_code", "formMother");
		expect(ref).toMatchObject({
			type: "case",
			caseType: "mother",
			path: "household_code",
			label: "Household code",
		});
	});

	it("resolves an ancestor-type property from a descendant form", () => {
		const ref = provider.resolve("#mother/household_code", "formPreg");
		expect(ref).toMatchObject({ type: "case", caseType: "mother" });
	});

	it("returns null for an unreachable (non-ancestor) case type", () => {
		// From a mother form, pregnancy is a CHILD, not an ancestor.
		expect(provider.resolve("#pregnancy/edd", "formMother")).toBeNull();
	});

	it("returns null for a child-type property", () => {
		// child's parent is mother, so it's never reachable from a mother form.
		expect(provider.resolve("#child/vaccine", "formMother")).toBeNull();
	});

	it("returns null for a property the reachable type doesn't declare", () => {
		expect(provider.resolve("#mother/nonexistent", "formMother")).toBeNull();
	});

	it("resolves #<type>/case_id as the seeded system property", () => {
		const ref = provider.resolve("#mother/case_id", "formMother");
		expect(ref).toMatchObject({
			type: "case",
			caseType: "mother",
			path: "case_id",
			label: "case id",
		});
	});

	it("narrows resolve on a registration form so chip ⟺ validator agree", () => {
		// On a form that creates the mother case, only case_id resolves — the
		// same narrowing the validator applies, so a chip never renders for a
		// ref the validator would reject.
		const regProvider = new ReferenceProvider((formUuid) =>
			formUuid === "formReg"
				? caseCtx("formReg", "mother", caseTypes, "registration")
				: undefined,
		);
		expect(regProvider.resolve("#mother/case_id", "formReg")).toMatchObject({
			type: "case",
			caseType: "mother",
			path: "case_id",
		});
		// A real mother property, narrowed out at form-init → no chip.
		expect(regProvider.resolve("#mother/household_code", "formReg")).toBeNull();
	});

	it("narrows search + namespaces on a registration form", () => {
		const regProvider = new ReferenceProvider((formUuid) =>
			formUuid === "formReg"
				? caseCtx("formReg", "pregnancy", caseTypes, "registration")
				: undefined,
		);
		// Own type's search yields only case_id; ancestor namespace is dropped.
		expect(
			regProvider.search("pregnancy", "", "formReg").map((r) => r.path),
		).toEqual(["case_id"]);
		expect(regProvider.namespaces("formReg")).toEqual([
			"form",
			"user",
			"pregnancy",
		]);
	});
});
