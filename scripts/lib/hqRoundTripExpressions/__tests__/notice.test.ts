/**
 * An app's notice row holds exactly the lines its plan states, in a shape
 * every surface renders (part 09 §12). The plausible failures: a deployment
 * told its next publish sends expression changes when no entry of its app
 * reaches the wire, or not told when one does; a deployment of an app with
 * entry points not asked to publish again; an app with no line given a row;
 * a name or detail longer than an entry keeps, which the table refuses; and
 * a selection writing detail keys its renderer does not read, so the line
 * renders without what it names. The observation is the entries the writer
 * stores, parsed by the notice schema and rendered by each reason's own
 * renderer over the lifted document.
 */

import { describe, expect, it } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { documentNoticeNames } from "@/lib/notices/documentNames";
import {
	type MigrationNoticeEntry,
	migrationNoticeEntriesSchema,
	NOTICE_TEXT_MAX,
} from "@/lib/notices/migrationNotice";
import { renderNoticeEntry } from "@/lib/notices/migrationNoticeCopy";
import { datetimeEquality } from "../../../../proof/targeted/documents/datetimeEquality";
import { datetimeOrdering } from "../../../../proof/targeted/documents/datetimeOrdering";
import { behaviorChanges, WIRE_REACHING_REASONS } from "../behavior";
import { appNoticeEntries } from "../notice";
import type { AppPlan } from "../plan";
import type { DocumentChange } from "../types";

const FIRST = "01992000-0000-7000-8000-000000000011";
const SECOND = "01992000-0000-7000-8000-000000000012";

function plan(overrides: Partial<AppPlan> = {}): AppPlan {
	return {
		appId: "app-1",
		projectId: "project-1",
		baseSeq: 7,
		baseDigest: "a".repeat(64),
		targetDigest: "b".repeat(64),
		changes: [],
		blockers: [],
		schemaChanges: [],
		discardsPrivateWork: false,
		deployments: [
			{
				deploymentId: FIRST,
				server: "production",
				domain: "clinic",
				hasEntryPoints: false,
			},
			{
				deploymentId: SECOND,
				server: "india",
				domain: "clinic-in",
				hasEntryPoints: false,
			},
		],
		...overrides,
	};
}

function appLine(reason: DocumentChange["reason"]): DocumentChange {
	return { reason, entity: { type: "app", nameAtMigration: "Clinic" } };
}

function deploymentLines(entries: readonly MigrationNoticeEntry[]) {
	return entries.flatMap((entry) =>
		entry.kind === "deployment"
			? [[entry.deployment.deploymentId, entry.reason]]
			: [],
	);
}

describe("an app's notice row", () => {
	it("is empty for an app the cutover tells nothing", () => {
		expect(appNoticeEntries(plan())).toEqual([]);
	});

	it("sends expressions at each deployment's next publish exactly where an entry reaches the wire", () => {
		for (const reason of WIRE_REACHING_REASONS) {
			const entries = appNoticeEntries(plan({ changes: [appLine(reason)] }));
			expect(deploymentLines(entries), reason).toEqual([
				[FIRST, "expressions-sent-at-next-publish"],
				[SECOND, "expressions-sent-at-next-publish"],
			]);
		}
		const quiet = appNoticeEntries(
			plan({
				changes: [
					appLine("expressions-follow-choices"),
					appLine("case-property-rules-removed"),
				],
			}),
		);
		expect(deploymentLines(quiet)).toEqual([]);
		expect(quiet.map((entry) => entry.reason)).toEqual([
			"expressions-follow-choices",
			"case-property-rules-removed",
		]);
	});

	it("asks every deployment of an app with entry points to publish again", () => {
		const entries = appNoticeEntries(
			plan({
				deployments: plan().deployments.map((deployment) => ({
					...deployment,
					hasEntryPoints: true,
				})),
			}),
		);
		expect(deploymentLines(entries)).toEqual([
			[FIRST, "deep-links-need-republish"],
			[SECOND, "deep-links-need-republish"],
		]);
		expect(entries[0]).toEqual({
			kind: "deployment",
			reason: "deep-links-need-republish",
			deployment: {
				deploymentId: FIRST,
				server: "production",
				domain: "clinic",
			},
		});
	});

	it("tells an app with no deployment its document lines alone", () => {
		const entries = appNoticeEntries(
			plan({ deployments: [], changes: [appLine("expressions-respelled")] }),
		);
		expect(entries.map((entry) => entry.kind)).toEqual(["document"]);
	});

	it("cuts each name and detail at the length an entry keeps", () => {
		const long = "x".repeat(NOTICE_TEXT_MAX + 40);
		const [entry] = appNoticeEntries(
			plan({
				deployments: [],
				changes: [
					{
						reason: "case-property-declared",
						entity: { type: "app", nameAtMigration: long },
						detail: {
							caseType: "household",
							property: "village_code",
							dataType: "text",
							form: long,
						},
					},
				],
			}),
		);
		expect(entry?.kind === "document" && entry.entity.nameAtMigration).toBe(
			long.slice(0, NOTICE_TEXT_MAX),
		);
		expect(entry?.kind === "document" && entry.detail?.form).toHaveLength(
			NOTICE_TEXT_MAX,
		);
	});
});

describe("the no-write lines as their renderers read them", () => {
	it("names the comparison's form and place, the search's module, the inferred type and the discarded work", () => {
		const ordering = hydratePersistedBlueprint(datetimeOrdering().doc);
		const equality = hydratePersistedBlueprint(datetimeEquality().doc);
		const lines = [
			...behaviorChanges({
				appName: ordering.appName,
				target: ordering,
				context: { lookupDefinitions: [] },
				schemaChanges: [
					{
						caseType: "visit",
						property: "next_due",
						from: "text",
						to: "date",
						source: "inferred",
					},
				],
				parked: new Map([[JSON.stringify(["visit", "next_due"]), 2]]),
				discardsPrivateWork: true,
			}).map((change) => ({ change, doc: ordering })),
			...behaviorChanges({
				appName: equality.appName,
				target: equality,
				context: { lookupDefinitions: [] },
				schemaChanges: [],
				parked: new Map(),
				discardsPrivateWork: false,
			}).map((change) => ({ change, doc: equality })),
		];
		const rendered = lines.map(({ change, doc }) => {
			const entries = migrationNoticeEntriesSchema.parse(
				appNoticeEntries(plan({ deployments: [], changes: [change] })),
			);
			const [entry] = entries;
			if (entry === undefined) throw new Error("no entry");
			return renderNoticeEntry(entry, documentNoticeNames(doc)).text;
		});
		expect(rendered).toEqual([
			"Visit instants, order: from the next publish or download, phones and Web Apps compare these dates and times by the moment, as Preview already does. Until now they didn't compare the time of day, so the answer could differ from Preview. CommCare HQ's form builder shows this comparison as a longer expression, and it keeps its meaning if you leave that expression as it is.",
			"Check, order: from the next publish or download, phones and Web Apps compare these dates and times by the moment, as Preview already does. Until now they didn't compare the time of day, so the answer could differ from Preview. CommCare HQ's form builder shows this comparison as a longer expression, and it keeps its meaning if you leave that expression as it is.",
			"visit, next_due: Nova now keeps it as a date, the type the calculation that saves it gives. 2 saved values that aren't dates are waiting in Data to review.",
			"Changes the assistant was still working on here were not saved before this update. The saved app is unchanged. Ask again to pick the work back up.",
			"From the next publish, the search in Visits finds cases whose date and time matches the one it names. Until now CommCare's search found none of them, though Preview did.",
			"From the next publish, the search in Other visits finds cases whose date and time matches the one it names. Until now CommCare's search found none of them, though Preview did.",
			"From the next publish, the search in Opened visits finds cases whose date and time matches the one it names. Until now CommCare's search found none of them, though Preview did.",
			"Visits: from the next publish or download, phones and Web Apps compare these dates and times by the moment, as Preview already does. Until now they didn't compare the time of day, so the answer could differ from Preview.",
			"Other visits: from the next publish or download, phones and Web Apps compare these dates and times by the moment, as Preview already does. Until now they didn't compare the time of day, so the answer could differ from Preview.",
		]);
	});
});
