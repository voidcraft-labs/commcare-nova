/**
 * The platforms cutover's transform of one app (part 09 §5), pure, over
 * documents built with `buildDoc`.
 *
 * Contract: each app gets the declaration its content allows, with the
 * date-and-time split only where that is the only way it runs anywhere;
 * each reference whose file a declared platform can't play is removed, with
 * the cause its notice line names, and every other reference stays; the
 * target passes the head schema, the absolute gate and export readiness, is
 * one the synthetic writer can replay, derives the case-type map the source
 * does, and a second application changes nothing. Anything else is a named
 * blocker, never a guess, and the app's transform stops there.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import {
	FIXTURE_FORM,
	PLATFORM_FEATURE_FIXTURES,
} from "@/lib/domain/__tests__/platformFeatureFixtures";
import { walkAuthoredAssetRefs } from "@/lib/domain/mediaRefs";
import { judgeTarget, transformApp } from "../transform";
import {
	featureDoc,
	MEDIA,
	MEDIA_UUIDS,
	mediaApp,
	SPLIT_NAMES,
	splitApp,
	stepContext,
	undeclared,
	withDatetimeQuestion,
	withSearchFirst,
} from "./fixtures";

const noMedia = (doc: BlueprintDoc) => stepContext(doc, { media: [] });

function codes(result: { blockers: readonly { code: string }[] }): string[] {
	return result.blockers.map((blocker) => blocker.code);
}

describe("step 1, declare-platforms, by each row of the declaration table", () => {
	it("leaves a document that already declares untouched", () => {
		const doc = PLATFORM_FEATURE_FIXTURES["datetime-question"].with();
		const result = transformApp(doc, noMedia(doc));
		expect(result).toMatchObject({
			changed: false,
			declaration: "android",
			changes: [],
			notice: [],
			blockers: [],
		});
		expect(result.target).toBe(doc);
	});

	it("leaves content that runs everywhere declaring both, writing nothing", () => {
		const doc = featureDoc("search");
		const result = transformApp(doc, noMedia(doc));
		expect(result).toMatchObject({
			changed: false,
			declaration: "both",
			notice: [],
			blockers: [],
		});
	});

	it.each([
		["a date-and-time question", "datetime-question"],
		["a case-list column that reads here()", "case-list-here"],
	] as const)("declares Android only for %s alone", (_label, feature) => {
		const doc = featureDoc(feature);
		const result = transformApp(doc, noMedia(doc));
		expect(result.blockers).toEqual([]);
		expect(result.changed).toBe(true);
		expect(result.target.appSettings.runsOnlyOn).toBe("android");
		expect(result.notice).toEqual([
			{
				kind: "document",
				reason: "platforms-declared",
				entity: { type: "app", nameAtMigration: doc.appName },
				detail: { runsOn: "android", causes: feature },
			},
		]);
	});

	it("declares a Connect app Android only, and splits none of its date-and-time questions", () => {
		const doc = withDatetimeQuestion(featureDoc("connect-app"));
		const result = transformApp(doc, noMedia(doc));
		expect(result.blockers).toEqual([]);
		expect(result.target.appSettings.runsOnlyOn).toBe("android");
		expect(result.notice).toEqual([
			expect.objectContaining({
				reason: "platforms-declared",
				detail: { runsOn: "android", causes: "datetime-question,connect-app" },
			}),
		]);
		expect(
			Object.values(result.target.fields).some(
				(field) => field.kind === "datetime",
			),
		).toBe(true);
	});

	it("declares Web Apps only for Search first alone", () => {
		const doc = featureDoc("search-first");
		const result = transformApp(doc, noMedia(doc));
		expect(result.target.appSettings.runsOnlyOn).toBe("web-apps");
		expect(result.notice).toEqual([
			expect.objectContaining({
				reason: "platforms-declared",
				detail: { runsOn: "web-apps", causes: "search-first" },
			}),
		]);
	});

	it("splits every date-and-time question of content that runs on neither only because of them, and declares it Web Apps only", () => {
		const doc = splitApp();
		const result = transformApp(doc, noMedia(doc));
		expect(result.blockers).toEqual([]);
		expect(result.declaration).toBe("web-apps");
		expect(
			Object.values(result.target.fields).filter(
				(field) => field.kind === "datetime",
			),
		).toEqual([]);
		expect(result.notice).toEqual([
			{
				kind: "document",
				reason: "platforms-declared",
				entity: { type: "app", nameAtMigration: "Visit times" },
				detail: {
					runsOn: "web-apps",
					causes: "search-field-single-date",
					split: "3",
				},
			},
			{
				kind: "document",
				reason: "datetime-question-split",
				entity: {
					type: "field",
					uuid: SPLIT_NAMES.seenAt,
					nameAtMigration: "seen_at",
				},
				detail: { form: "Check", date: "seen_at_date", time: "seen_at_time" },
			},
			{
				kind: "document",
				reason: "datetime-question-split",
				entity: {
					type: "field",
					uuid: SPLIT_NAMES.plannedAt,
					nameAtMigration: "planned_at",
				},
				detail: {
					form: "Plan",
					date: "planned_at_date",
					time: "planned_at_time",
				},
			},
			{
				kind: "document",
				reason: "datetime-question-split",
				entity: {
					type: "field",
					uuid: SPLIT_NAMES.dueAt,
					nameAtMigration: "due_at",
				},
				detail: { form: "Plan", date: "due_at_date", time: "due_at_time" },
			},
		]);
		/* The split writes nothing new to the case: `seen_at` keeps its case
		 * write and its type, so the case-type map does not move. */
		expect(
			[...buildCaseTypeMap(toPersistableDoc(result.target))].sort(),
		).toEqual([...buildCaseTypeMap(toPersistableDoc(doc))].sort());
		expect(
			result.changes.filter((change) => change.entityUuid !== null),
		).toEqual([
			{
				step: "declare-platforms",
				entityUuid: SPLIT_NAMES.seenAt,
				detail: { split: 1, writer: 1 },
			},
			{
				step: "declare-platforms",
				entityUuid: SPLIT_NAMES.plannedAt,
				detail: { split: 1, writer: 0 },
			},
			{
				step: "declare-platforms",
				entityUuid: SPLIT_NAMES.dueAt,
				detail: { split: 1, writer: 0 },
			},
		]);
	});

	it("blocks content that runs on neither for a reason other than date-and-time questions, naming both sides", () => {
		const doc = withSearchFirst(featureDoc("case-list-here"));
		const result = transformApp(doc, noMedia(doc));
		expect(result.blockers).toEqual([
			{
				code: "runs-on-neither",
				count: 1,
				findingCodes: ["android:search-first", "web-apps:case-list-here"],
			},
		]);
		expect(result).toMatchObject({
			changed: false,
			declaration: null,
			notice: [],
		});
	});

	it("blocks a split the planner refuses: a question whose rule reads itself through a filter", () => {
		const doc = produce(splitApp(), (draft) => {
			const field = draft.fields[SPLIT_NAMES.plannedAt] as Record<
				string,
				unknown
			>;
			const self = {
				kind: "term",
				term: {
					kind: "field",
					uuid: SPLIT_NAMES.plannedAt,
					spelling: "relative",
				},
			};
			field.validate = {
				kind: "neq",
				left: {
					kind: "term",
					term: {
						kind: "field",
						uuid: SPLIT_NAMES.plannedAt,
						spelling: "relative",
						filters: [
							{
								step: { kind: "field", uuid: SPLIT_NAMES.plannedAt },
								where: [
									{
										kind: "neq",
										left: self,
										right: {
											kind: "term",
											term: { kind: "literal", value: "" },
										},
									},
								],
							},
						],
					},
				},
				right: { kind: "term", term: { kind: "literal", value: "" } },
			};
		});
		const result = transformApp(doc, noMedia(doc));
		expect(result.blockers).toEqual([
			{
				code: "datetime-split-refused",
				count: 1,
				findingCodes: ["self-read-through-a-filter"],
			},
		]);
	});

	it("never changes a document a second time", () => {
		for (const doc of [
			splitApp(),
			featureDoc("datetime-question"),
			mediaApp(),
		]) {
			const first = transformApp(doc, stepContext(doc));
			expect(first.blockers).toEqual([]);
			const second = transformApp(first.target, stepContext(first.target));
			expect(second).toMatchObject({ changed: false, blockers: [] });
			expect(
				second.notice.filter((entry) => entry.kind === "document"),
			).toEqual([]);
		}
	});
});

describe("step 2, remove-unplayed-media", () => {
	const doc = mediaApp();
	const result = transformApp(doc, stepContext(doc));

	it("removes each reference a declared platform can't play from every carrier, with its cause", () => {
		expect(result.blockers).toEqual([]);
		expect(
			result.changes.map((change) => [
				change.detail.carrier,
				change.detail.media,
				change.detail.format,
				change.detail.cause,
			]),
		).toEqual([
			["logo", "image", "unplayable", "too-large"],
			["menu-audio", "audio", "amr", "web-apps"],
			["image-map-row", "image", "ico", "android"],
			["menu-audio", "audio", "unplayable", "neither"],
			["label", "image", "avif", "android"],
			["label", "video", "mp4-hevc", "web-apps"],
			["option", "audio", "unplayable", "missing"],
			["case-list-icon", "image", "avif", "android"],
			["case-list-audio", "audio", "amr", "web-apps"],
		]);
	});

	it("keeps every reference that plays on both platforms, H.264 High among them", () => {
		expect(
			[...walkAuthoredAssetRefs(result.target)].map((ref) => [
				ref.location.kind,
				ref.assetId,
			]),
		).toEqual([
			["module_icon", MEDIA.png],
			["image_map_mapping", MEDIA.png],
			["field_media_bundle", MEDIA.high],
		]);
		expect(result.target.logo).toBeUndefined();
		const photo = result.target.fields[MEDIA_UUIDS.photo] as Record<
			string,
			unknown
		>;
		expect(photo.label_media).toBeUndefined();
		expect(photo.help_media).toEqual({ video: MEDIA.high });
	});

	it("removes an image-map row whole, keeping the rest of its column", () => {
		const column = result.target.modules[
			MEDIA_UUIDS.patients
		]?.caseListConfig?.columns.find(
			(candidate) => candidate.uuid === MEDIA_UUIDS.statusColumn,
		);
		expect(column).toMatchObject({
			kind: "image-map",
			mapping: [{ value: "south", assetId: MEDIA.png }],
		});
	});

	it("names each removal's entity and details for its notice line", () => {
		expect(
			result.notice.map((entry) =>
				entry.kind === "document" ? [entry.entity, entry.detail] : entry,
			),
		).toEqual([
			[
				{ type: "app", nameAtMigration: "Clinic media" },
				{
					carrier: "logo",
					media: "image",
					file: "logo.bmp",
					cause: "too-large",
				},
			],
			[
				{
					type: "module",
					uuid: MEDIA_UUIDS.patients,
					nameAtMigration: "Patients",
				},
				{
					carrier: "menu-audio",
					media: "audio",
					file: "welcome.amr",
					cause: "web-apps",
				},
			],
			[
				{
					type: "caseListColumn",
					uuid: MEDIA_UUIDS.statusColumn,
					nameAtMigration: "Zone",
				},
				{
					module: "Patients",
					carrier: "image-map-row",
					row: "north",
					media: "image",
					file: "north.ico",
					cause: "android",
				},
			],
			[
				{ type: "form", uuid: MEDIA_UUIDS.visit, nameAtMigration: "Visit" },
				{
					module: "Patients",
					carrier: "menu-audio",
					media: "audio",
					file: "float.wav",
					cause: "neither",
				},
			],
			[
				{ type: "field", uuid: MEDIA_UUIDS.photo, nameAtMigration: "photo" },
				{
					form: "Visit",
					carrier: "label",
					media: "image",
					file: "photo.avif",
					cause: "android",
				},
			],
			[
				{ type: "field", uuid: MEDIA_UUIDS.photo, nameAtMigration: "photo" },
				{
					form: "Visit",
					carrier: "label",
					media: "video",
					file: "intro.mp4",
					cause: "web-apps",
				},
			],
			[
				{ type: "field", uuid: MEDIA_UUIDS.mood, nameAtMigration: "mood" },
				{
					form: "Visit",
					carrier: "option",
					option: "happy",
					media: "audio",
					file: "lost.ogg",
					cause: "missing",
				},
			],
			[
				{
					type: "module",
					uuid: MEDIA_UUIDS.directory,
					nameAtMigration: "Directory",
				},
				{
					carrier: "case-list-icon",
					media: "image",
					file: "photo.avif",
					cause: "android",
				},
			],
			[
				{
					type: "module",
					uuid: MEDIA_UUIDS.directory,
					nameAtMigration: "Directory",
				},
				{
					carrier: "case-list-audio",
					media: "audio",
					file: "welcome.amr",
					cause: "web-apps",
				},
			],
		]);
	});

	it("judges an app that runs on Android only by Android alone", () => {
		const android = produce(doc, (draft) => {
			draft.appSettings.runsOnlyOn = "android";
		});
		const judged = transformApp(android, stepContext(android));
		expect(
			judged.changes.map((change) => [
				change.detail.format,
				change.detail.cause,
			]),
		).toEqual([
			["unplayable", "too-large"],
			["ico", "android"],
			["unplayable", "neither"],
			["avif", "android"],
			["unplayable", "missing"],
			["avif", "android"],
		]);
	});

	it("removes a menu's icon and a help bundle's file, keeping the slot beside each", () => {
		/* On Android alone an AVIF or ICO image does not play and an AMR
		 * label and an H.264 High video do, so each carrier loses one slot. */
		const android = produce(doc, (draft) => {
			draft.appSettings.runsOnlyOn = "android";
			const patients = draft.modules[MEDIA_UUIDS.patients];
			const visit = draft.forms[MEDIA_UUIDS.visit];
			const photo = draft.fields[MEDIA_UUIDS.photo] as
				| Record<string, unknown>
				| undefined;
			if (!patients || !visit || !photo) throw new Error("No media app.");
			patients.icon = MEDIA.avif;
			visit.icon = MEDIA.ico;
			visit.audioLabel = MEDIA.amr;
			photo.help_media = { image: MEDIA.avif, video: MEDIA.high };
		});
		const judged = transformApp(android, stepContext(android));
		expect(judged.blockers).toEqual([]);
		const carriers = new Set(["menu-icon", "menu-audio", "help"]);
		expect(
			judged.notice.flatMap((entry) =>
				entry.kind === "document" && carriers.has(String(entry.detail?.carrier))
					? [[entry.entity, entry.detail]]
					: [],
			),
		).toEqual([
			[
				{
					type: "module",
					uuid: MEDIA_UUIDS.patients,
					nameAtMigration: "Patients",
				},
				{
					carrier: "menu-icon",
					media: "image",
					file: "photo.avif",
					cause: "android",
				},
			],
			[
				{ type: "form", uuid: MEDIA_UUIDS.visit, nameAtMigration: "Visit" },
				{
					module: "Patients",
					carrier: "menu-icon",
					media: "image",
					file: "north.ico",
					cause: "android",
				},
			],
			[
				{ type: "field", uuid: MEDIA_UUIDS.photo, nameAtMigration: "photo" },
				{
					form: "Visit",
					carrier: "help",
					media: "image",
					file: "photo.avif",
					cause: "android",
				},
			],
		]);
		const patients = judged.target.modules[MEDIA_UUIDS.patients];
		const visit = judged.target.forms[MEDIA_UUIDS.visit];
		expect([patients?.icon, patients?.audioLabel]).toEqual([
			undefined,
			MEDIA.amr,
		]);
		expect([visit?.icon, visit?.audioLabel]).toEqual([undefined, MEDIA.amr]);
		expect(
			(judged.target.fields[MEDIA_UUIDS.photo] as Record<string, unknown>)
				.help_media,
		).toEqual({ video: MEDIA.high });
		expect(judgeTarget(android, judged.target, stepContext(android))).toEqual(
			[],
		);
	});

	it("leaves the file's name out where it is longer than an entry keeps", () => {
		const context = stepContext(doc);
		const long = new Map(context.mediaRecords);
		const logo = long.get(MEDIA.tooLarge);
		if (logo === undefined) throw new Error("No logo record.");
		long.set(MEDIA.tooLarge, {
			...logo,
			originalFilename: `${"x".repeat(201)}.bmp`,
		});
		const judged = transformApp(doc, { ...context, mediaRecords: long });
		expect(judged.notice[0]).toMatchObject({
			detail: { carrier: "logo", media: "image", cause: "too-large" },
		});
		expect(
			judged.notice[0]?.kind === "document"
				? judged.notice[0].detail?.file
				: "",
		).toBeUndefined();
	});

	it("names the original file where the display name is empty, and keeps the entry's JSON valid", () => {
		const context = stepContext(doc);
		const records = new Map(context.mediaRecords);
		const logo = records.get(MEDIA.tooLarge);
		if (logo === undefined) throw new Error("No logo record.");
		records.set(MEDIA.tooLarge, {
			...logo,
			displayName: "",
			originalFilename: "logo\ud800.bmp",
		});
		const judged = transformApp(doc, { ...context, mediaRecords: records });
		expect(
			judged.notice[0]?.kind === "document"
				? judged.notice[0].detail?.file
				: "",
		).toBe("logo\ufffd.bmp");
	});

	it("blocks a reference whose file is no ready media row of the Project", () => {
		const blocked = transformApp(
			doc,
			stepContext(doc, {
				media: ["png", "ico", "avif", "tooLarge", "amr", "wav", "hevc", "high"],
			}),
		);
		expect(blocked.blockers).toEqual([
			{ code: "media-row-missing", count: 1, findingCodes: [] },
		]);
	});

	it("removes nothing in the scan, which classifies no media, and drops only the format finding", () => {
		const scanned = transformApp(doc, stepContext(doc, { classified: false }));
		expect(scanned.blockers).toEqual([]);
		expect(scanned.changed).toBe(false);
	});
});

describe("step 3, judge-target", () => {
	const source = mediaApp();
	const context = stepContext(source);

	it("refuses a stored clock-keeping date compared with a date at the gate", () => {
		const doc = undeclared(
			buildDoc({
				appName: "Clock",
				modules: [
					{
						name: "Survey",
						forms: [
							{
								name: "Intake",
								type: "survey",
								fields: [
									f({
										kind: "text",
										id: "note",
										label: proseText("Note"),
										relevant:
											"date(format-date(now(), '%Y-%m-%dT%H:%M:%S.%3%Z')) = today()",
									}),
								],
							},
						],
					},
				],
			}),
		);
		const result = transformApp(doc, noMedia(doc));
		expect(codes(result)).toContain("target-gate");
		expect(
			result.blockers.find((blocker) => blocker.code === "target-gate")
				?.findingCodes,
		).toContain("XPATH_INCOMPATIBLE_VALUES:date-datetime");
	});

	it("refuses a form-logic read of the window width at the gate (outcome A of the window width gate)", () => {
		const doc = produce(featureDoc("search"), (draft) => {
			const question = draft.fieldOrder[FIXTURE_FORM]?.[0];
			const field =
				question === undefined
					? undefined
					: (draft.fields[question] as Record<string, unknown>);
			if (field === undefined) throw new Error("No question.");
			field.relevant = {
				kind: "neq",
				left: {
					kind: "term",
					term: { kind: "session-context", field: "window_width" },
				},
				right: { kind: "term", term: { kind: "literal", value: "" } },
			};
		});
		const result = transformApp(doc, noMedia(doc));
		expect(codes(result)).toContain("target-gate");
		expect(
			result.blockers.find((blocker) => blocker.code === "target-gate")
				?.findingCodes,
		).toContain("XPATH_FUNCTION_CONTEXT_UNAVAILABLE:window-width");
	});

	it("refuses a target the diff cannot replay: a rename-shaped case-property change", () => {
		const target = produce(source, (draft) => {
			const patient = draft.caseTypes?.find((type) => type.name === "patient");
			const zone = patient?.properties.find(
				(property) => property.name === "zone",
			);
			if (zone === undefined) throw new Error("No zone property.");
			zone.name = "region";
			for (const field of Object.values(draft.fields) as Record<
				string,
				unknown
			>[]) {
				const write = field.caseWrite as { property?: string } | undefined;
				if (write?.property === "zone") write.property = "region";
			}
			const column = draft.modules[
				MEDIA_UUIDS.patients
			]?.caseListConfig?.columns.find(
				(candidate) => candidate.uuid === MEDIA_UUIDS.statusColumn,
			) as { field?: string } | undefined;
			if (column) column.field = "region";
		});
		expect(codes({ blockers: judgeTarget(source, target, context) })).toContain(
			"not-representable",
		);
	});

	it("refuses a target whose diff the writer's target admission refuses: an entry point holding a menu's identity", () => {
		const target = produce(source, (draft) => {
			const visit = draft.forms[MEDIA_UUIDS.visit];
			if (visit === undefined) throw new Error("No visit form.");
			visit.entryPoint = { uuid: MEDIA_UUIDS.patients, id: "visit" };
		});
		expect(codes({ blockers: judgeTarget(source, target, context) })).toContain(
			"not-representable",
		);
	});

	it("refuses a target that derives another case-type map", () => {
		const target = produce(source, (draft) => {
			const patient = draft.caseTypes?.find((type) => type.name === "patient");
			if (patient === undefined) throw new Error("No patient.");
			patient.properties.push({
				name: "visits",
				label: proseText("Visits"),
			} as never);
		});
		expect(codes({ blockers: judgeTarget(source, target, context) })).toContain(
			"case-schema-changed",
		);
	});

	it("accepts the target the steps make, and a source that is its own target", () => {
		const result = transformApp(source, context);
		expect(judgeTarget(source, result.target, context)).toEqual([]);
		expect(
			judgeTarget(result.target, result.target, stepContext(result.target)),
		).toEqual([]);
	});

	it("refuses a target the steps would still change", () => {
		/* An undeclared app holding a date-and-time question: step 1 would
		 * still declare it, as step 2 would still remove the media app's
		 * unplayable references. */
		const declared = featureDoc("datetime-question");
		expect(
			codes({ blockers: judgeTarget(declared, declared, noMedia(declared)) }),
		).toContain("not-idempotent");
		expect(codes({ blockers: judgeTarget(source, source, context) })).toEqual([
			"target-export-readiness",
			"not-idempotent",
		]);
	});
});

describe("step 4, deployment-lines, in the transform", () => {
	it("gives a changed app's live deployments their lines, content-free in its changes", () => {
		const doc = featureDoc("datetime-question");
		const result = transformApp(
			doc,
			stepContext(doc, {
				media: [],
				deployments: [
					{
						deploymentId: "01992000-0000-7000-8000-000000000011",
						server: "production",
						domain: "field-ops",
						baseline: null,
					},
				],
			}),
		);
		expect(result.target.appSettings.runsOnlyOn).toBe("android");
		expect(
			result.changes.filter((change) => change.step === "deployment-lines"),
		).toEqual([]);
		expect(
			result.notice.filter((entry) => entry.kind === "deployment"),
		).toEqual([]);
	});
});
