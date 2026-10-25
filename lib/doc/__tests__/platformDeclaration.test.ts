/**
 * The one declaration planner (`platformDeclaration.ts`) and its applier.
 *
 * Contract: `planContentDeclaration` gives an undeclared document the
 * platforms its content runs on, Android only where Web Apps can't run a
 * use, Web Apps only where Android can't, both where both run everything,
 * and Web Apps only with every date-and-time question split where that
 * question is the only thing keeping the content off both; any other content
 * that runs on neither is the author's to resolve. A document that already
 * declares is left alone. Every batch it returns passes the commit gate over
 * its document, and a second application plans nothing. `declaredForContent`
 * applies a declared plan and refuses any other by name. The cutover's first
 * step, the fuzz mapping and the test fixtures all read this one planner, so
 * a wrong platform here is a wrong declaration on every app it touches.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planDatetimeSplits } from "@/lib/doc/datetimeSplit";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	declaredForContent,
	PlatformDeclarationBlocked,
	planContentDeclaration,
} from "@/lib/doc/platformDeclaration";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	FIXTURE_FORM,
	FIXTURE_MODULE,
	PLATFORM_FEATURE_FIXTURES,
} from "@/lib/domain/__tests__/platformFeatureFixtures";
import { datetimeSplitFieldUuid } from "@/lib/domain/datetimeSplitIdentity";
import { datetimeSplitOriginal } from "./datetimeSplitFixture";

/** A fixture document with its derived declaration taken off: the shape of
 * an app stored before it declared anything. */
function undeclared(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		delete draft.appSettings.runsOnlyOn;
	});
}

const fixture = (feature: keyof typeof PLATFORM_FEATURE_FIXTURES) =>
	undeclared(PLATFORM_FEATURE_FIXTURES[feature].with());

/** The fixture's follow-up question turned into a date-and-time question. */
function withDatetimeQuestion(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		const question = draft.fieldOrder[FIXTURE_FORM]?.[0];
		const field = question === undefined ? undefined : draft.fields[question];
		if (field === undefined)
			throw new Error("The fixture's form holds no question.");
		draft.fields[field.uuid] = { ...field, kind: "datetime" } as typeof field;
	});
}

function withSearchFirst(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		const module = draft.modules[FIXTURE_MODULE];
		if (module === undefined) throw new Error("No fixture module.");
		module.caseSearchConfig = { searchFirst: true };
	});
}

/** The batch the plan returns passes the gate over its own document. */
function expectAdmitted(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	if (mutations.length === 0) return;
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
}

describe("planContentDeclaration, by the content's platforms", () => {
	it("leaves a document that already declares untouched", () => {
		const declared = PLATFORM_FEATURE_FIXTURES["datetime-question"].with();
		expect(declared.appSettings.runsOnlyOn).toBe("android");
		expect(planContentDeclaration(declared)).toEqual({
			kind: "declared",
			runsOnlyOn: "android",
			causes: [],
			mutations: [],
			splits: [],
		});
		expect(declaredForContent(declared)).toBe(declared);
	});

	it("declares both, writing nothing, for content that runs everywhere", () => {
		const doc = fixture("search");
		expect(planContentDeclaration(doc)).toEqual({
			kind: "declared",
			runsOnlyOn: undefined,
			causes: [],
			mutations: [],
			splits: [],
		});
		expect(declaredForContent(doc)).toBe(doc);
	});

	it.each([
		["a date-and-time question", "datetime-question"],
		["here() in a calculated column", "case-list-here"],
		["a Connect app", "connect-app"],
	] as const)("declares Android only for %s", (_label, feature) => {
		const doc = fixture(feature);
		const plan = planContentDeclaration(doc);
		expect(plan).toEqual({
			kind: "declared",
			runsOnlyOn: "android",
			causes: [feature],
			mutations: [
				{ kind: "setAppSettings", settings: { runsOnlyOn: "android" } },
			],
			splits: [],
		});
		if (plan.kind === "declared") expectAdmitted(doc, plan.mutations);
		expect(declaredForContent(doc).appSettings.runsOnlyOn).toBe("android");
	});

	it.each([
		["Search first", "search-first"],
		["several cases", "several-cases"],
		["a single-date Search field", "search-field-single-date"],
	] as const)("declares Web Apps only for %s", (_label, feature) => {
		const doc = fixture(feature);
		const plan = planContentDeclaration(doc);
		expect(plan).toEqual({
			kind: "declared",
			runsOnlyOn: "web-apps",
			causes: [feature],
			mutations: [
				{ kind: "setAppSettings", settings: { runsOnlyOn: "web-apps" } },
			],
			splits: [],
		});
		if (plan.kind === "declared") expectAdmitted(doc, plan.mutations);
	});

	it("declares a Connect app with a date-and-time question Android only, splitting nothing", () => {
		const doc = produce(fixture("connect-app"), (draft) => {
			const question = draft.fieldOrder[FIXTURE_FORM]?.[0];
			const field = question === undefined ? undefined : draft.fields[question];
			if (field === undefined) throw new Error("No question.");
			draft.fields[field.uuid] = { ...field, kind: "datetime" } as typeof field;
		});
		const plan = planContentDeclaration(doc);
		expect(plan).toMatchObject({
			kind: "declared",
			runsOnlyOn: "android",
			causes: ["datetime-question", "connect-app"],
			splits: [],
		});
		if (plan.kind === "declared") expectAdmitted(doc, plan.mutations);
	});

	it("declares Search first beside a date-and-time question Web Apps only, with the question split", () => {
		const doc = withDatetimeQuestion(fixture("search-first"));
		const question = doc.fieldOrder[FIXTURE_FORM]?.[0] as Uuid;
		const plan = planContentDeclaration(doc);
		const split = planDatetimeSplits(doc);
		if (!split.ok) throw new Error(split.message);
		expect(plan).toEqual({
			kind: "declared",
			runsOnlyOn: "web-apps",
			causes: ["search-first"],
			mutations: [
				{ kind: "setAppSettings", settings: { runsOnlyOn: "web-apps" } },
				...split.mutations,
			],
			splits: split.splits,
		});
		if (plan.kind !== "declared") throw new Error("Expected a declaration.");
		expect(plan.splits).toMatchObject([
			{
				fieldUuid: question,
				dateId: "note_date",
				timeId: "note_time",
				dateUuid: datetimeSplitFieldUuid(doc.appId, question, "date"),
				timeUuid: datetimeSplitFieldUuid(doc.appId, question, "time"),
			},
		]);
		expectAdmitted(doc, plan.mutations);
		const applied = declaredForContent(doc);
		expect(applied.appSettings.runsOnlyOn).toBe("web-apps");
		expect(
			Object.values(applied.fields).filter(
				(field) => field.kind === "datetime",
			),
		).toEqual([]);
	});

	it.each([
		[
			"Search first beside here() in a calculated column",
			() => withSearchFirst(fixture("case-list-here")),
			["case-list-here"],
			["search-first"],
		],
		[
			"a Connect app with Search first",
			() =>
				produce(fixture("search-first"), (draft) => {
					draft.connectType = "learn";
				}),
			["connect-app"],
			["search-first"],
		],
	] as const)(
		"leaves %s to the author, running on neither",
		(_label, build, webApps, android) => {
			const doc = build();
			const plan = planContentDeclaration(doc);
			expect(plan).toEqual({
				kind: "runs-on-neither",
				webAppsUnavailable: webApps,
				androidUnavailable: android,
			});
			expect(() => declaredForContent(doc)).toThrow(PlatformDeclarationBlocked);
			expect(() => declaredForContent(doc)).toThrow(
				new RegExp(
					`Web Apps can't run ${webApps.join(", ")}, and Android can't run ${android.join(", ")}`,
				),
			);
		},
	);
});

describe("a second application", () => {
	it.each([
		["Android only", () => fixture("datetime-question")],
		["Web Apps only", () => fixture("several-cases")],
		["the split", () => withDatetimeQuestion(fixture("search-first"))],
	])("plans nothing after %s", (_label, build) => {
		const once = declaredForContent(build());
		expect(planContentDeclaration(once)).toMatchObject({ mutations: [] });
		expect(declaredForContent(once)).toEqual(once);
	});
});

describe("the date-and-time split under a declaration", () => {
	it("is refused where Web Apps is declared, and admitted once its questions are split", () => {
		const original = datetimeSplitOriginal();
		const toWebApps: Mutation = {
			kind: "setAppSettings",
			settings: { runsOnlyOn: "web-apps" },
		};
		const refused = mutationCommitVerdict(
			original,
			[toWebApps],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(refused.ok).toBe(false);
		if (!refused.ok)
			expect(
				refused.findings.some(
					(finding) =>
						finding.code === "PLATFORM_FEATURE_UNAVAILABLE" &&
						finding.details?.feature === "datetime-question",
				),
			).toBe(true);
		const split = planDatetimeSplits(original);
		if (!split.ok) throw new Error(split.message);
		const admitted = mutationCommitVerdict(
			original,
			[toWebApps, ...split.mutations],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(admitted.ok ? [] : admitted.findings).toEqual([]);
		expect(admitted.nextDoc.appSettings.runsOnlyOn).toBe("web-apps");
	});
});
