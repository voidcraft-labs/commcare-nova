/**
 * The declaration through the commit gate, on admitted documents.
 *
 * Contract: widening an app to a platform that can't run what it holds is
 * refused, and the refusal names every use it would strand; narrowing is
 * admitted; and a scoped commit that adds a use a declared platform can't
 * run (one question in one form) still meets the platform rule, which runs
 * on every commit because it is an app rule. A scoped path that misses the
 * rule, or a refusal that names one stranded use of several, fails here.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	describeCommitFindings,
	mutationCommitVerdict,
	mutationCommitVerdictWithPrevalidation,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { incrementalValidationScope } from "@/lib/doc/incrementalValidationScope";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	NEW_APP_SETTINGS,
	type Platform,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	FIXTURE_MODULE,
	PLATFORM_FEATURE_FIXTURES,
} from "@/lib/domain/__tests__/platformFeatureFixtures";
import { assertAdmittedDoc } from "./admittedDoc";

const FORM = testUuid("platform-commit-form");

function visits(
	runsOnlyOn: Platform | undefined,
	kind: "datetime" | "text",
): BlueprintDoc {
	const doc = buildDoc({
		appName: "Visits",
		appSettings: {
			...NEW_APP_SETTINGS,
			...(runsOnlyOn === undefined ? {} : { runsOnlyOn }),
		},
		modules: [
			{
				name: "Survey",
				forms: [
					{
						uuid: FORM,
						name: "Register visit",
						type: "survey",
						fields: [
							f({ kind, id: "arrived_at", label: proseText("Arrived at") }),
							f({ kind, id: "left_at", label: proseText("Left at") }),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

const addDatetimeQuestion: Mutation = {
	kind: "addField",
	parentUuid: FORM,
	field: {
		uuid: testUuid("platform-commit-added"),
		kind: "datetime",
		id: "visit_time",
		label: proseText("Visit time"),
	},
};

describe("the declaration through the gate", () => {
	it("refuses widening an Android-only app to both, naming every stranded question", () => {
		const verdict = mutationCommitVerdict(
			visits("android", "datetime"),
			[{ kind: "setAppSettings", settings: { runsOnlyOn: null } }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(
			verdict.findings.map((finding) => [
				finding.code,
				finding.location.fieldId,
			]),
		).toEqual([
			["PLATFORM_FEATURE_UNAVAILABLE", "arrived_at"],
			["PLATFORM_FEATURE_UNAVAILABLE", "left_at"],
		]);
		const described = describeCommitFindings(verdict.findings);
		expect(described).toContain(
			'Question "arrived_at" in form "Register visit"',
		);
		expect(described).toContain('Question "left_at" in form "Register visit"');
	});

	it("admits narrowing an app that runs on both to Android only", () => {
		const verdict = mutationCommitVerdict(
			visits(undefined, "text"),
			[{ kind: "setAppSettings", settings: { runsOnlyOn: "android" } }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		expect(verdict.nextDoc.appSettings.runsOnlyOn).toBe("android");
	});

	it("refuses a date-and-time question added to a form of an app that runs on both", () => {
		const verdict = mutationCommitVerdictWithPrevalidation(
			visits(undefined, "text"),
			[addDatetimeQuestion],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(
			verdict.ok
				? []
				: verdict.findings.map((finding) => finding.details?.feature),
		).toEqual(["datetime-question"]);
	});

	it("admits the same question added to an Android-only app", () => {
		const verdict = mutationCommitVerdictWithPrevalidation(
			visits("android", "text"),
			[addDatetimeQuestion],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});

	it("meets the platform rule on a scoped commit: a single-date Search field added to one module", () => {
		const addDateField: Mutation = {
			kind: "addSearchInput",
			moduleUuid: FIXTURE_MODULE,
			searchInput: simpleSearchInputDef(
				testUuid("platform-commit-input"),
				"dob",
				"Date of birth",
				"date",
				"dob",
			),
		};
		const both = PLATFORM_FEATURE_FIXTURES.search.without();
		assertAdmittedDoc(both);
		const admitted = admitMutationBatch([addDateField]);
		expect(
			incrementalValidationScope(
				both,
				admitted,
				prepareMutationCandidate(both, admitted).nextDoc,
			),
		).toEqual({ moduleUuids: new Set([FIXTURE_MODULE]) });
		const refused = mutationCommitVerdictWithPrevalidation(
			both,
			[addDateField],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(
			refused.ok
				? []
				: refused.findings.map((finding) => finding.details?.feature),
		).toEqual(["search-field-single-date"]);
		const webApps = {
			...both,
			appSettings: { ...both.appSettings, runsOnlyOn: "web-apps" as const },
		};
		const verdict = mutationCommitVerdictWithPrevalidation(
			webApps,
			[addDateField],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});
});
