/**
 * Documents and media plans the cutover's pure tests share: undeclared
 * versions of the platform fixtures (the shape of an app stored before it
 * declared anything), the date-and-time split's original, and one app whose
 * every media carrier holds a file, beside the Project's plans and records
 * for those files.
 */

import { produce } from "immer";
import type { Selectable } from "kysely";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { MediaAssetsTable } from "@/lib/db/pg";
import {
	datetimeSplitNames,
	datetimeSplitOriginal,
} from "@/lib/doc/__tests__/datetimeSplitFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	imageMapColumn,
	imageMapEntry,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import {
	FIXTURE_FORM,
	FIXTURE_MODULE,
	PLATFORM_FEATURE_FIXTURES,
} from "@/lib/domain/__tests__/platformFeatureFixtures";
import type {
	AssetKind,
	AssetMimeType,
	MediaAssetId,
	MediaFormatValue,
} from "@/lib/domain/multimedia";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { MediaRow } from "../media";
import type { SourceDeployment } from "../notice";
import type { FleetSource, SourceApp } from "../source";
import type { PlatformsStepContext } from "../transform";
import type { MediaCause, MediaPlan } from "../types";

export const PROJECT = "project-platforms-cutover";

/** A document with its declaration taken off. */
export function undeclared(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		delete draft.appSettings.runsOnlyOn;
	});
}

/** A platform fixture's `with()` document, undeclared. */
export function featureDoc(
	feature: keyof typeof PLATFORM_FEATURE_FIXTURES,
): BlueprintDoc {
	return undeclared(PLATFORM_FEATURE_FIXTURES[feature].with());
}

/** The fixture module turned search-first. */
export function withSearchFirst(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		const module = draft.modules[FIXTURE_MODULE];
		if (module === undefined) throw new Error("No fixture module.");
		module.caseSearchConfig = { searchFirst: true };
	});
}

/** The fixture form's first question turned into a date-and-time question. */
export function withDatetimeQuestion(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		const question = draft.fieldOrder[FIXTURE_FORM]?.[0];
		const field = question === undefined ? undefined : draft.fields[question];
		if (field === undefined) throw new Error("No fixture question.");
		draft.fields[field.uuid] = { ...field, kind: "datetime" } as typeof field;
	});
}

export const SPLIT_NAMES = datetimeSplitNames((name) =>
	testUuid(`datetime-split:${name}`),
);

/**
 * The split's original, undeclared, with a single-date Search field on its
 * Visits menu: content that runs on neither platform only because of its
 * date-and-time questions, one of which writes a case property.
 */
export function splitApp(): BlueprintDoc {
	return produce(undeclared(datetimeSplitOriginal()), (draft) => {
		const config = draft.modules[SPLIT_NAMES.visitsModule]?.caseListConfig;
		if (config === undefined) throw new Error("No Visits case list.");
		config.searchInputs = [
			simpleSearchInputDef(
				testUuid("datetime-split:seen-on-input"),
				"seen_on",
				"Seen on",
				"date",
				"seen_at",
			),
		];
	});
}

// ── The media app ───────────────────────────────────────────────────

export const MEDIA = {
	png: testMediaAssetId("platforms-media-png"),
	ico: testMediaAssetId("platforms-media-ico"),
	avif: testMediaAssetId("platforms-media-avif"),
	tooLarge: testMediaAssetId("platforms-media-too-large"),
	amr: testMediaAssetId("platforms-media-amr"),
	wav: testMediaAssetId("platforms-media-wav"),
	missing: testMediaAssetId("platforms-media-missing"),
	hevc: testMediaAssetId("platforms-media-hevc"),
	high: testMediaAssetId("platforms-media-high"),
} as const;

interface MediaSpec {
	readonly kind: AssetKind;
	readonly mime: AssetMimeType;
	readonly format: MediaFormatValue;
	readonly cause: MediaCause;
	readonly name: string;
}

export const MEDIA_SPECS: Readonly<Record<keyof typeof MEDIA, MediaSpec>> = {
	png: {
		kind: "image",
		mime: "image/png",
		format: "png",
		cause: "mime",
		name: "clinic.png",
	},
	ico: {
		kind: "image",
		mime: "image/vnd.microsoft.icon",
		format: "ico",
		cause: "mime",
		name: "north.ico",
	},
	avif: {
		kind: "image",
		mime: "image/avif",
		format: "avif",
		cause: "mime",
		name: "photo.avif",
	},
	tooLarge: {
		kind: "image",
		mime: "image/bmp",
		format: "unplayable",
		cause: "too-large",
		name: "logo.bmp",
	},
	amr: {
		kind: "audio",
		mime: "audio/amr",
		format: "amr",
		cause: "mime",
		name: "welcome.amr",
	},
	wav: {
		kind: "audio",
		mime: "audio/wav",
		format: "unplayable",
		cause: "no-variant",
		name: "float.wav",
	},
	missing: {
		kind: "audio",
		mime: "audio/ogg",
		format: "unplayable",
		cause: "missing",
		name: "lost.ogg",
	},
	hevc: {
		kind: "video",
		mime: "video/mp4",
		format: "mp4-hevc",
		cause: "classified",
		name: "intro.mp4",
	},
	high: {
		kind: "video",
		mime: "video/mp4",
		format: "mp4-h264-high",
		cause: "classified",
		name: "help.mp4",
	},
};

export const MEDIA_UUIDS = {
	patients: testUuid("platforms-media-patients"),
	directory: testUuid("platforms-media-directory"),
	register: testUuid("platforms-media-register"),
	visit: testUuid("platforms-media-visit"),
	photo: testUuid("platforms-media-photo"),
	mood: testUuid("platforms-media-mood"),
	happy: testUuid("platforms-media-happy"),
	statusColumn: testUuid("platforms-media-status-column"),
} as const;

/**
 * A case app whose every media carrier holds a file: the logo, a menu's icon
 * and audio label, a case-list-only menu's icon and audio label, a form's
 * audio label, a question's label and help, a choice, and two rows of an
 * image-map column. It runs on both platforms.
 */
export function mediaApp(): BlueprintDoc {
	return buildDoc(
		{
			appId: "app-platforms-media",
			appName: "Clinic media",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "zone", label: proseText("Zone") },
					],
				},
			],
			modules: [
				{
					uuid: MEDIA_UUIDS.patients,
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(
								testUuid("platforms-media-name"),
								"case_name",
								"Name",
							),
							imageMapColumn(MEDIA_UUIDS.statusColumn, "zone", "Zone", [
								imageMapEntry("north", MEDIA.ico as MediaAssetId),
								imageMapEntry("south", MEDIA.png as MediaAssetId),
							]),
						],
						searchInputs: [],
					},
					forms: [
						{
							uuid: MEDIA_UUIDS.register,
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "text",
									id: "zone",
									label: proseText("Zone"),
									caseWrite: { caseType: "patient", property: "zone" },
								}),
							],
						},
						{
							uuid: MEDIA_UUIDS.visit,
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									uuid: MEDIA_UUIDS.photo,
									id: "photo",
									label: proseText("Photo"),
									help: "Hold the phone steady",
									label_media: { image: MEDIA.avif, video: MEDIA.hevc },
									help_media: { video: MEDIA.high },
								}),
								f({
									kind: "single_select",
									uuid: MEDIA_UUIDS.mood,
									id: "mood",
									label: proseText("Mood"),
									options: [
										{
											value: "happy",
											label: "Happy",
											uuid: MEDIA_UUIDS.happy,
											media: { audio: MEDIA.missing },
										},
										{ value: "sad", label: "Sad" },
									],
								}),
							],
						},
					],
				},
				{
					uuid: MEDIA_UUIDS.directory,
					name: "Directory",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			],
		},
		(doc) => {
			doc.logo = MEDIA.tooLarge as MediaAssetId;
			const patients = doc.modules[MEDIA_UUIDS.patients];
			const directory = doc.modules[MEDIA_UUIDS.directory];
			const visit = doc.forms[MEDIA_UUIDS.visit];
			if (!patients || !directory || !visit) throw new Error("No media app.");
			patients.icon = MEDIA.png as MediaAssetId;
			patients.audioLabel = MEDIA.amr as MediaAssetId;
			visit.audioLabel = MEDIA.wav as MediaAssetId;
			if (directory.caseListConfig) {
				directory.caseListConfig.icon = MEDIA.avif as MediaAssetId;
				directory.caseListConfig.audioLabel = MEDIA.amr as MediaAssetId;
			}
		},
	);
}

/** One media file's plan, as the classification gives it. */
export function mediaPlan(key: keyof typeof MEDIA): MediaPlan {
	const spec = MEDIA_SPECS[key];
	return {
		assetId: MEDIA[key],
		projectId: PROJECT,
		rowDigest: `digest-${key}`,
		mimeType: spec.mime,
		format: spec.format,
		cause: spec.cause,
	};
}

/** One media file's record, as export readiness reads it. */
export function mediaRecord(key: keyof typeof MEDIA): MediaAssetRecord {
	const spec = MEDIA_SPECS[key];
	return {
		id: MEDIA[key] as MediaAssetId,
		project_id: PROJECT,
		owner: "owner",
		contentHash: "0".repeat(64),
		mimeType: spec.mime,
		extension: `.${spec.name.split(".").pop()}`,
		sizeBytes: 100,
		...(spec.kind === "image" && { dimensions: { width: 10, height: 10 } }),
		mediaFormat: spec.format,
		kind: spec.kind,
		gcsObjectKey: `projects/${PROJECT}/${key}`,
		originalFilename: spec.name,
		status: "ready",
		created_at: new Date("2026-10-01T00:00:00Z"),
	} as MediaAssetRecord;
}

/** A step context over every media file above, and the deployments given. */
export function stepContext(
	doc: BlueprintDoc,
	options: {
		readonly classified?: boolean;
		readonly deployments?: readonly SourceDeployment[];
		readonly media?: readonly (keyof typeof MEDIA)[];
	} = {},
): PlatformsStepContext {
	const keys = options.media ?? (Object.keys(MEDIA) as (keyof typeof MEDIA)[]);
	const plans = new Map(
		keys.map((key) => [MEDIA[key] as string, mediaPlan(key)]),
	);
	return {
		appId: doc.appId,
		projectId: PROJECT,
		lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
		formatOf: options.classified === false ? null : (id) => plans.get(id),
		mediaRecords: new Map(
			keys.map((key) => [MEDIA[key] as string, mediaRecord(key)]),
		),
		deployments: options.deployments ?? [],
	};
}

export type { Uuid };

// ── A fleet source, for the plan and the report ────────────────────

/** One media file as `media_assets` holds it, before the window adds its format. */
export function storedMediaRow(
	key: keyof typeof MEDIA,
): Selectable<MediaAssetsTable> {
	const record = mediaRecord(key);
	return {
		id: record.id,
		project_id: PROJECT,
		owner: "owner",
		content_hash: `${key}`.padEnd(64, "0"),
		mime_type: record.mimeType,
		extension: record.extension,
		size_bytes: "100",
		dimensions: record.dimensions ?? null,
		duration_ms: null,
		kind: record.kind,
		gcs_object_key: record.gcsObjectKey,
		original_filename: record.originalFilename,
		display_name: null,
		status: "ready",
		extract: null,
		media_format: null,
		created_at: new Date("2026-10-01T00:00:00Z"),
	} as Selectable<MediaAssetsTable>;
}

/** The ready media row of one file, as the backfill reads it. */
export function readyMediaRow(key: keyof typeof MEDIA): MediaRow {
	const row = storedMediaRow(key);
	return {
		id: row.id,
		project_id: row.project_id,
		status: row.status,
		kind: row.kind,
		mime_type: row.mime_type,
		extension: row.extension,
		content_hash: row.content_hash,
		gcs_object_key: row.gcs_object_key,
	};
}

export interface FleetApp {
	readonly appId: string;
	readonly doc: BlueprintDoc;
	readonly baseSeq?: number;
	readonly deleted?: boolean;
	readonly deployments?: readonly SourceDeployment[];
	readonly drift?: SourceApp["drift"];
}

/** A fleet source over the given apps, all of one Project holding every media file. */
export function fleetOf(apps: readonly FleetApp[]): FleetSource {
	const keys = Object.keys(MEDIA) as (keyof typeof MEDIA)[];
	return {
		apps: apps.map((app) => ({
			appId: app.appId,
			projectId: PROJECT,
			deleted: app.deleted ?? false,
			baseSeq: app.baseSeq ?? 4,
			doc: app.doc,
			deployments: app.deployments ?? [],
			drift: app.drift ?? [],
		})),
		projects: new Map([
			[
				PROJECT,
				{
					projectId: PROJECT,
					lookupContext: {
						kind: "available",
						projectId: PROJECT,
						projectRevision: parseLookupRevision("1"),
						definitions: [],
					},
					mediaRows: keys.map(storedMediaRow),
				},
			],
		]),
		media: keys.map(readyMediaRow),
		holders: {
			liveApps: [],
			liveSessions: [],
			settleableApps: [],
			settleableSessions: [],
			unsettledApps: [],
			unsettledSessions: [],
		},
		appsInFleet: apps.length,
		deletedApps: apps.filter((app) => app.deleted === true).length,
		fleetSeqDigest: "f".repeat(64),
		databaseBytes: 1024,
	};
}

/** Every media file's plan, the classification the plan and report tests read. */
export function classification() {
	return {
		plans: (Object.keys(MEDIA) as (keyof typeof MEDIA)[]).map(mediaPlan),
		stats: { objectsRead: 4, bytesRead: 4096, milliseconds: 12 },
	};
}
