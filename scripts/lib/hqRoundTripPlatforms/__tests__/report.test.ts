/**
 * The content-free report (part 09 §6), pure, over plans the test builds.
 *
 * Contract: each count line counts what it names apart (a split writer from
 * a non-writer, each context field and slot class, each drift class, each
 * removed reference by format), `needsBytes` counts exactly the rows whose
 * stored MIME cannot give their format, drift never moves the digest, and no
 * line holds an authored name, value or file name.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { planFleet } from "../plan";
import {
	CutoverReport,
	fleetLine,
	planSections,
	type ReportLine,
} from "../report";
import {
	classification,
	featureDoc,
	fleetOf,
	MEDIA_SPECS,
	mediaApp,
	splitApp,
} from "./fixtures";

const contextTerm = (field: string) => ({
	kind: "term",
	term: { kind: "session-context", field },
});
const clockKeeping = {
	kind: "date-coerce",
	value: {
		kind: "format-date",
		date: { kind: "call", name: "now", args: [] },
		pattern: "%Y-%m-%dT%H:%M:%S.%3%Z",
	},
};
const notBlank = (left: unknown) => ({
	kind: "neq",
	left,
	right: { kind: "term", term: { kind: "literal", value: "" } },
});

/**
 * The search fixture with stored reads of each counted context field in
 * three slot classes, and a clock-keeping date in a writer's and a
 * non-writer's form logic.
 */
function contextApp(): BlueprintDoc {
	return produce(featureDoc("search"), (draft) => {
		const module = Object.values(draft.modules)[0];
		const form = Object.values(draft.forms)[0];
		const fields = Object.values(draft.fields) as Record<string, unknown>[];
		if (!module || !form || fields.length === 0) throw new Error("No fixture.");
		(module as Record<string, unknown>).displayCondition = notBlank(
			contextTerm("drift"),
		);
		(form as Record<string, unknown>).displayCondition = notBlank(
			contextTerm("window_width"),
		);
		const field = fields[0] as Record<string, unknown>;
		field.relevant = notBlank(contextTerm("applanguage"));
		field.validate = notBlank(clockKeeping);
		field.default_value = contextTerm("drift");
	});
}

function writerClock(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		const writer = Object.values(draft.fields).find(
			(field) => "caseWrite" in field && field.caseWrite !== undefined,
		) as Record<string, unknown> | undefined;
		if (!writer) throw new Error("No writer.");
		writer.relevant = notBlank(clockKeeping);
	});
}

function lines(fleet: ReturnType<typeof planFleet>): ReportLine[] {
	const report = new CutoverReport("dry-run");
	fleetLine(report, fleet);
	planSections(report, fleet);
	return [...report.all()];
}

const section = (all: readonly ReportLine[], name: string) =>
	all.find((line) => line.section === name);

describe("the count lines", () => {
	const fleet = planFleet(
		fleetOf([
			{ appId: "app-a-media", doc: mediaApp() },
			{ appId: "app-b-split", doc: splitApp() },
			{ appId: "app-c-context", doc: contextApp() },
			{ appId: "app-d-writer", doc: writerClock(splitApp()) },
		]),
		classification(),
	);
	const all = lines(fleet);

	it("counts the split's questions by writer and non-writer", () => {
		expect(section(all, "splits")).toMatchObject({
			questions: 3,
			writerQuestions: 1,
			nonWriterQuestions: 2,
			writerApps: ["app-b-split"],
			nonWriterApps: ["app-b-split"],
		});
	});

	it("counts the stored clock-keeping dates by writer and non-writer", () => {
		expect(section(all, "clock-keeping-dates")).toMatchObject({
			writerSlots: 1,
			nonWriterSlots: 1,
			writerApps: ["app-d-writer"],
			nonWriterApps: ["app-c-context"],
		});
	});

	it("counts each context field's reads by slot class", () => {
		expect(section(all, "session-context")).toMatchObject({
			reads: {
				drift: { module: 1, field: 1 },
				window_width: { "form-display-condition": 1 },
				applanguage: { field: 1 },
			},
			apps: ["app-c-context"],
		});
	});

	it("counts removed references by cause, carrier and format", () => {
		expect(section(all, "media")).toMatchObject({
			classified: true,
			removedReferences: 9,
			removedByFormat: {
				amr: 2,
				avif: 2,
				ico: 1,
				"mp4-hevc": 1,
				unplayable: 3,
			},
			removedByCause: {
				android: 3,
				missing: 1,
				neither: 1,
				"too-large": 1,
				"web-apps": 3,
			},
			missingAssetIds: [expect.any(String)],
			tooLargeAssetIds: [expect.any(String)],
		});
	});

	it("counts as needing bytes the WAV, Ogg, MP4 and WebM rows and no image", () => {
		const media = section(all, "media");
		expect(media?.needsBytesByMime).toEqual({
			"audio/ogg": 1,
			"audio/wav": 1,
			"video/mp4": 2,
		});
		expect(media?.needsBytes).toBe(4);
		const webm = planFleet(
			{
				...fleetOf([]),
				media: [
					...fleetOf([]).media,
					{
						id: "webm",
						project_id: "p",
						status: "ready",
						kind: "video",
						mime_type: "video/webm",
						extension: ".webm",
						content_hash: "0",
						gcs_object_key: "k",
					},
				],
			},
			null,
		);
		expect(section(lines(webm), "media")).toMatchObject({
			needsBytes: 5,
			classified: false,
			droppedReadinessCodes: ["MEDIA_FORMAT_NOT_PLAYED"],
		});
	});

	it("names each blocker's apps and codes", () => {
		const blocked = planFleet(
			fleetOf([
				{
					appId: "app-e-neither",
					doc: produce(featureDoc("case-list-here"), (draft) => {
						const module = Object.values(draft.modules)[0];
						if (module) module.caseSearchConfig = { searchFirst: true };
					}),
				},
			]),
			classification(),
		);
		expect(lines(blocked).filter((line) => line.section === "blocker")).toEqual(
			[
				expect.objectContaining({
					code: "runs-on-neither",
					count: 1,
					apps: ["app-e-neither"],
				}),
			],
		);
	});
});

describe("the schema-drift line", () => {
	const drift = [
		{
			caseType: "visit",
			missingRow: false,
			added: ["a", "b"],
			removed: ["c"],
			refined: [{ property: "d", fromSpec: "{}", toSpec: "{}" }],
			retyped: [
				{
					property: "seen",
					fromType: "date" as const,
					toType: "datetime" as const,
					fromSpec: "{}",
					toSpec: "{}",
				},
			],
			unresolvable: [],
		},
		{
			caseType: "household",
			missingRow: true,
			added: ["x"],
			removed: [],
			refined: [],
			retyped: [],
			unresolvable: [],
		},
	];

	it("counts each drift class apart and leaves the digest where it was", () => {
		const without = planFleet(
			fleetOf([{ appId: "app-a", doc: splitApp() }]),
			classification(),
		);
		const withDrift = planFleet(
			fleetOf([{ appId: "app-a", doc: splitApp(), drift }]),
			classification(),
		);
		expect(withDrift.plan.digest).toBe(without.plan.digest);
		expect(section(lines(withDrift), "schema-drift")).toEqual(
			expect.objectContaining({
				apps: ["app-a"],
				caseTypes: 2,
				missingRow: 1,
				added: 2,
				removed: 1,
				refined: 1,
				retyped: { "date->datetime": 1 },
				unresolvable: 0,
			}),
		);
		expect(section(lines(without), "schema-drift")).toMatchObject({
			apps: [],
			caseTypes: 0,
		});
	});
});

describe("the report's content", () => {
	it("holds no authored name, value or file name from any fixture", () => {
		const fleet = planFleet(
			fleetOf([
				{ appId: "app-a-media", doc: mediaApp() },
				{ appId: "app-b-split", doc: splitApp() },
				{ appId: "app-c-context", doc: contextApp() },
			]),
			classification(),
		);
		const text = JSON.stringify(lines(fleet));
		for (const authored of [
			"Clinic media",
			"Visit times",
			"Patients",
			"Directory",
			"Zone",
			"photo",
			"mood",
			"happy",
			"north",
			"south",
			"seen_at",
			"planned_at",
			"Planned for",
			"Seen at",
			...Object.values(MEDIA_SPECS).map((spec) => spec.name),
		]) {
			expect(text).not.toContain(authored);
		}
	});
});
