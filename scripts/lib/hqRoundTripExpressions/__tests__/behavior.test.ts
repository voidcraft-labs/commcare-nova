/**
 * The no-write notice lines (part 09 §6) are selected from the lifted target
 * exactly where the head emitter changes what a device, a search or a
 * publish does. The plausible failures: a search whose `_xpath_query` reads
 * `today` or tests a date and time for equality left without its line (or a
 * search that does neither given one); a device comparison of two dates and
 * times the lowering rewrites missed, or one it leaves bare named; a line
 * placed on the wrong entity or target; an inference typing, discarded work
 * or a deployment line written where its fact does not hold.
 *
 * The documents are the lane's own head-corpus witnesses of each construct
 * (`proof/targeted`), so the selections are held against the trees the
 * emitter reads, never against hand-built look-alikes.
 */

import { describe, expect, it } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import type { CorpusDocument } from "../../../../proof/corpus/documents";
import { csqlComposition } from "../../../../proof/targeted/documents/csqlComposition";
import { datetimeEquality } from "../../../../proof/targeted/documents/datetimeEquality";
import { datetimeOrdering } from "../../../../proof/targeted/documents/datetimeOrdering";
import { hiddenFromMenu } from "../../../../proof/targeted/documents/hiddenFromMenu";
import {
	type BehaviorContext,
	behaviorChanges,
	casePropertyTypeNowKnown,
	dateTimeComparisonComparesMoments,
	deploymentChanges,
	hasEntryPoints,
	schemaChangeKey,
	searchDateTimeEqualityMatches,
	searchTodayIsWorkersDay,
	unsavedAssistantWorkDiscarded,
	WIRE_REACHING_REASONS,
} from "../behavior";
import type { DocumentChange, PlannedSchemaChange } from "../types";

function open(document: CorpusDocument): {
	doc: BlueprintDoc;
	context: BehaviorContext;
} {
	return {
		doc: hydratePersistedBlueprint(document.doc),
		context: { lookupDefinitions: document.lookup?.definitions ?? [] },
	};
}

function moduleNamed(doc: BlueprintDoc, name: string): string {
	const uuid = doc.moduleOrder.find(
		(moduleUuid) => doc.modules[moduleUuid]?.name === name,
	);
	if (uuid === undefined) throw new Error(`No module named ${name}`);
	return uuid;
}

const composition = open(csqlComposition());
const equality = open(datetimeEquality());
const ordering = open(datetimeOrdering());

describe("search lines", () => {
	it("names the module whose search reads today, and only that one", () => {
		const { doc, context } = composition;
		expect(searchTodayIsWorkersDay(doc, context)).toEqual([
			{
				reason: "search-today-is-workers-day",
				entity: {
					type: "module",
					uuid: moduleNamed(doc, "Visit searches"),
					nameAtMigration: "Visit searches",
				},
			},
		]);
		expect(searchTodayIsWorkersDay(equality.doc, equality.context)).toEqual([]);
	});

	it("names each module whose search tests a date and time for equality, custom or system, filter or input", () => {
		const { doc, context } = equality;
		expect(
			searchDateTimeEqualityMatches(doc, context).map(
				(change) => change.entity,
			),
		).toEqual(
			["Visits", "Other visits", "Opened visits"].map((name) => ({
				type: "module",
				uuid: moduleNamed(doc, name),
				nameAtMigration: name,
			})),
		);
		expect(
			searchDateTimeEqualityMatches(composition.doc, composition.context).map(
				(change) => change.entity.nameAtMigration,
			),
		).toEqual(["Visit searches"]);
		expect(
			searchDateTimeEqualityMatches(ordering.doc, ordering.context),
		).toEqual([]);
	});
});

describe("date-time-comparison-compares-moments", () => {
	it("names each field whose form logic compares two dates and times, with its form, and no form that compares none", () => {
		const changes = dateTimeComparisonComparesMoments(
			ordering.doc,
			ordering.context,
		);
		expect(
			changes.map((change) => [change.entity.type, change.detail]),
		).toEqual([
			["field", { form: "Visit instants", target: "xform" }],
			["field", { form: "Check", target: "xform" }],
		]);
		for (const change of changes) {
			const field = ordering.doc.fields[change.entity.uuid as never];
			expect(change.entity.nameAtMigration).toBe(field?.id);
		}
	});

	it("names a case list filter a device evaluates as the module's, in the suite, and no search a device never evaluates", () => {
		const { doc, context } = equality;
		expect(dateTimeComparisonComparesMoments(doc, context)).toEqual(
			["Visits", "Other visits"].map((name) => ({
				reason: "date-time-comparison-compares-moments",
				entity: {
					type: "module",
					uuid: moduleNamed(doc, name),
					nameAtMigration: name,
				},
				detail: { target: "suite" },
			})),
		);
		expect(
			dateTimeComparisonComparesMoments(composition.doc, composition.context),
		).toEqual([]);
	});
});

const inferred: PlannedSchemaChange = {
	caseType: "visit",
	property: "next_due",
	from: "text",
	to: "date",
	source: "inferred",
};
const declared: PlannedSchemaChange = {
	caseType: "household",
	property: "village_code",
	from: null,
	to: "text",
	source: "declared",
};

describe("facts of the plan", () => {
	it("names each inferred typing with its type, and its parked values only where some park", () => {
		const changes = [inferred, declared];
		expect(casePropertyTypeNowKnown("Clinic", changes, new Map())).toEqual([
			{
				reason: "case-property-type-now-known",
				entity: { type: "app", nameAtMigration: "Clinic" },
				detail: { caseType: "visit", property: "next_due", dataType: "date" },
			},
		]);
		expect(
			casePropertyTypeNowKnown(
				"Clinic",
				changes,
				new Map([
					[schemaChangeKey(inferred), 2],
					[schemaChangeKey(declared), 5],
				]),
			)[0]?.detail,
		).toEqual({
			caseType: "visit",
			property: "next_due",
			dataType: "date",
			parked: "2",
		});
	});

	it("tells an app whose private work is abandoned, and no other", () => {
		expect(unsavedAssistantWorkDiscarded("Clinic", true)).toEqual([
			{
				reason: "unsaved-assistant-work-discarded",
				entity: { type: "app", nameAtMigration: "Clinic" },
			},
		]);
		expect(unsavedAssistantWorkDiscarded("Clinic", false)).toEqual([]);
	});

	it("gathers every no-write line in the reason lists' order", () => {
		const reasons = behaviorChanges({
			appName: "Visit times",
			target: equality.doc,
			context: equality.context,
			schemaChanges: [inferred],
			parked: new Map(),
			discardsPrivateWork: true,
		}).map((change) => change.reason);
		expect(reasons).toEqual([
			"search-date-time-equality-matches",
			"search-date-time-equality-matches",
			"search-date-time-equality-matches",
			"date-time-comparison-compares-moments",
			"date-time-comparison-compares-moments",
			"case-property-type-now-known",
			"unsaved-assistant-work-discarded",
		]);
	});
});

describe("deployment lines", () => {
	const deployments = [{ deploymentId: "a" }, { deploymentId: "b" }];
	const line = (reason: DocumentChange["reason"]): DocumentChange => ({
		reason,
		entity: { type: "app", nameAtMigration: "Clinic" },
	});

	it("sends expressions at the next publish exactly where an entry reaches the wire", () => {
		for (const reason of WIRE_REACHING_REASONS) {
			expect(
				deploymentChanges(deployments, [line(reason)], false),
				reason,
			).toEqual([
				{ deploymentId: "a", reason: "expressions-sent-at-next-publish" },
				{ deploymentId: "b", reason: "expressions-sent-at-next-publish" },
			]);
		}
		for (const reason of [
			"case-property-rules-removed",
			"expressions-follow-choices",
			"case-property-declared",
			"unsaved-assistant-work-discarded",
		] as const) {
			expect(
				deploymentChanges(deployments, [line(reason)], false),
				reason,
			).toEqual([]);
		}
	});

	it("asks every deployment of an app with entry points to publish again, after the expressions line", () => {
		expect(
			deploymentChanges(deployments, [line("expressions-respelled")], true),
		).toEqual([
			{ deploymentId: "a", reason: "expressions-sent-at-next-publish" },
			{ deploymentId: "a", reason: "deep-links-need-republish" },
			{ deploymentId: "b", reason: "expressions-sent-at-next-publish" },
			{ deploymentId: "b", reason: "deep-links-need-republish" },
		]);
		expect(
			deploymentChanges([], [line("expressions-respelled")], true),
		).toEqual([]);
	});

	it("reads entry points from the target", () => {
		expect(hasEntryPoints(open(hiddenFromMenu()).doc)).toBe(true);
		expect(hasEntryPoints(ordering.doc)).toBe(false);
	});
});
