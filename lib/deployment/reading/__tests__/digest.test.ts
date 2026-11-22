import { describe, expect, it } from "vitest";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { remapAssetRefs } from "@/lib/domain/mediaRefs";
import { asMediaAssetId, type MediaAssetId } from "@/lib/domain/multimedia";
import type { Uuid } from "@/lib/domain/uuid";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { type AdoptedMediaFile, assignMediaPaths } from "../../adoption";
import {
	canonicalTargetIdentity,
	EMPTY_TARGET_IDENTITY,
	resolveTargetIdentity,
	type TargetIdentity,
} from "../../targetIdentity";
import { type ReviewDigestInput, reviewDigestOf } from "../digest";
import { reviewMediaId } from "../mediaIds";
import type {
	ReadingDeclarationChoice,
	ReadingReview,
	ReviewTable,
} from "../types";

const TABLE: ReviewTable = {
	tag: "districts",
	standing: "choice",
	hqDigest: "a".repeat(64),
	projectTable: {
		tableId: "01937c5e-7d1a-7c3b-8a4f-2b6c9d0e1f23" as LookupTableId,
		definitionRevision: "3",
		rowsRevision: "7",
	},
	choice: {
		differs: ["rows"],
		apps: [{ appId: "app-other", appName: "Clinic visits", deleted: false }],
		options: {
			"use-commcare-hq": { offered: true, goneColumns: [], retypedColumns: [] },
			"use-project": { offered: false, why: "needs-admin", name: null },
		},
	},
};

const PRESELECTED: ReadingDeclarationChoice = {
	runsOnlyOn: null,
	splitDatetime: false,
	preselected: true,
	recordedFeatures: [{ kind: "plan-feature", subject: "lookup-tables" }],
	firstPublish: {
		ids: ["forms-and-settings-rewritten"],
		touchesWorkers: false,
		of: "first-publish",
	},
};
const OTHER: ReadingDeclarationChoice = {
	runsOnlyOn: "android",
	splitDatetime: true,
	preselected: false,
	recordedFeatures: [],
	firstPublish: {
		ids: ["forms-and-settings-rewritten", "web-apps-turned-off"],
		touchesWorkers: false,
		of: "first-publish",
	},
};

const REVIEW: ReadingReview = {
	appName: "Household survey",
	readAt: "2026-11-15T10:00:00.000Z",
	creates: {
		menus: 2,
		forms: 5,
		questions: 40,
		caseTypes: ["household", "member"],
		languages: ["en", "fra"],
		mediaFiles: 3,
	},
	runsOn: [PRESELECTED, OTHER],
	runsOnWhy: "content",
	webAppsOnInHq: true,
	datetimeQuestions: 2,
	platformsOut: [
		{ platform: "web-apps", features: ["datetime-question"], media: false },
	],
	kept: ["automatic-app-updates"],
	tables: [TABLE],
	places: { count: 12, digest: "b".repeat(64) },
	mediaLeftOut: 1,
	firstPublish: PRESELECTED.firstPublish,
};

const ASSET = asMediaAssetId("6f1c4f0e-2d3b-5a4c-9e8f-7a6b5c4d3e2f");
const OTHER_ASSET = asMediaAssetId("7a2d5e1f-3e4c-5b5d-8f9a-8b7c6d5e4f3a");
const HASH = "c".repeat(64);
const OTHER_HASH = "d".repeat(64);

function file(
	hqPath: string,
	assetId: MediaAssetId,
	contentHash: string,
): AdoptedMediaFile {
	return { hqPath, assetId, contentHash, extension: ".png" };
}

/** The record a birth writes of `files` alone: each file's path as the birth keeps it. */
function pathsOf(files: readonly AdoptedMediaFile[]): TargetIdentity {
	return resolveTargetIdentity(
		EMPTY_TARGET_IDENTITY,
		{
			entities: [],
			keyedCreates: [],
			mediaPaths: assignMediaPaths(files).rows.map((row) => ({
				...row,
				derivedPath: "",
				alsoAt: [],
			})),
			hqPaths: [],
			columnWords: [],
		},
		{ appId: "01937c5e-7d1a-7c3b-8a4f-2b6c9d0e1f99" },
	);
}

const OPERATION = "2d1b4e5a-3f4c-4d5e-8f6a-7b8c9d0e1f2a" as Uuid;
const RECORD: TargetIdentity = canonicalTargetIdentity({
	entities: [
		{
			entityKind: "module",
			novaEntityUuid: "0b9f2c3e-1d2a-4b3c-8d4e-5f6a7b8c9d0e",
			uniqueId: "hq-menu-1",
			xmlns: null,
		},
		{
			entityKind: "form",
			novaEntityUuid: "1c0a3d4f-2e3b-4c4d-9e5f-6a7b8c9d0e1f",
			uniqueId: "hq-form-1",
			xmlns: "http://openrosa.org/formdesigner/ABC",
		},
	],
	keyedCaseIds: [
		{
			operationUuid: OPERATION,
			caseType: "household",
			prefix: "nova-case-v1:5b4a3c2d-1e0f-5a9b-8c7d-6e5f4a3b2c1d:",
		},
	],
	mediaPaths: pathsOf([file("jr://file/commcare/image/logo.png", ASSET, HASH)])
		.mediaPaths,
	columnWords: [
		{
			columnUuid: "2e1b4f5a-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
			screen: "long",
			word: "case_name",
		},
		{
			columnUuid: "2e1b4f5a-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
			screen: "short",
			word: "case_name",
		},
	],
});

const BASE: ReviewDigestInput = {
	v: 3,
	authority: {
		appId: "app",
		user: "user",
		role: "editor",
		projectId: "project",
		server: "production",
		domain: "domain",
		remoteAppId: "remote",
	},
	review: REVIEW,
	document: "e".repeat(64),
	targetIdentity: RECORD,
};

/** Each variant changes exactly one part of the input. */
function variants(): ReadonlyMap<string, ReviewDigestInput> {
	const review = (change: Partial<ReadingReview>): ReviewDigestInput => ({
		...BASE,
		review: { ...REVIEW, ...change },
	});
	const creates = (
		change: Partial<ReadingReview["creates"]>,
	): ReviewDigestInput => review({ creates: { ...REVIEW.creates, ...change } });
	const preselected = (
		change: Partial<ReadingDeclarationChoice>,
	): ReviewDigestInput =>
		review({ runsOn: [{ ...PRESELECTED, ...change }, OTHER] });
	const table = (change: Partial<ReviewTable>): ReviewDigestInput =>
		review({ tables: [{ ...TABLE, ...change }] });
	const record = (change: Partial<TargetIdentity>): ReviewDigestInput => ({
		...BASE,
		targetIdentity: { ...RECORD, ...change },
	});
	return new Map<string, ReviewDigestInput>([
		["review.appName", review({ appName: "Household survey 2" })],
		["review.creates.menus", creates({ menus: 3 })],
		["review.creates.forms", creates({ forms: 6 })],
		["review.creates.questions", creates({ questions: 41 })],
		["review.creates.caseTypes", creates({ caseTypes: ["household"] })],
		["review.creates.languages", creates({ languages: ["fra", "en"] })],
		["review.creates.mediaFiles", creates({ mediaFiles: 4 })],
		["review.runsOn", review({ runsOn: [PRESELECTED] })],
		["review.runsOn[].runsOnlyOn", preselected({ runsOnlyOn: "web-apps" })],
		["review.runsOn[].splitDatetime", preselected({ splitDatetime: true })],
		[
			"review.runsOn[].preselected",
			review({
				runsOn: [
					{ ...PRESELECTED, preselected: false },
					{ ...OTHER, preselected: true },
				],
			}),
		],
		["review.runsOn[].recordedFeatures", preselected({ recordedFeatures: [] })],
		[
			"review.runsOn[].firstPublish",
			preselected({
				firstPublish: { ...PRESELECTED.firstPublish, touchesWorkers: true },
			}),
		],
		["review.runsOnWhy", review({ runsOnWhy: "keeps-web-apps" })],
		["review.webAppsOnInHq", review({ webAppsOnInHq: false })],
		["review.datetimeQuestions", review({ datetimeQuestions: 3 })],
		["review.platformsOut", review({ platformsOut: [] })],
		[
			"review.platformsOut[].media",
			review({
				platformsOut: [
					{
						platform: "web-apps",
						features: ["datetime-question"],
						media: true,
					},
				],
			}),
		],
		["review.kept", review({ kept: [] })],
		["review.tables", review({ tables: [] })],
		["review.tables[].hqDigest", table({ hqDigest: "f".repeat(64) })],
		[
			"review.tables[].projectTable",
			table({
				projectTable: TABLE.projectTable && {
					...TABLE.projectTable,
					rowsRevision: "8",
				},
			}),
		],
		[
			"review.tables[].choice",
			table({
				choice: TABLE.choice && {
					...TABLE.choice,
					options: {
						...TABLE.choice.options,
						"use-project": {
							offered: true,
							goneColumns: [],
							retypedColumns: [],
						},
					},
				},
			}),
		],
		["review.places", review({ places: null })],
		["review.mediaLeftOut", review({ mediaLeftOut: 0 })],
		[
			"review.firstPublish",
			review({ firstPublish: { ...REVIEW.firstPublish, ids: [] } }),
		],
		["document", { ...BASE, document: "0".repeat(64) }],
		[
			"targetIdentity.entities[].uniqueId",
			record({
				entities: RECORD.entities.map((row) =>
					row.entityKind === "form" ? { ...row, uniqueId: "hq-form-2" } : row,
				),
			}),
		],
		[
			"targetIdentity.entities[].xmlns",
			record({
				entities: RECORD.entities.map((row) =>
					row.entityKind === "form"
						? { ...row, xmlns: "http://openrosa.org/formdesigner/DEF" }
						: row,
				),
			}),
		],
		[
			"targetIdentity.keyedCaseIds[].prefix",
			record({
				keyedCaseIds: RECORD.keyedCaseIds.map((row) => ({
					...row,
					prefix: "nova-case-v1:6c5b4d3e-2f1a-5b0c-9d8e-7f6a5b4c3d2e:",
				})),
			}),
		],
		[
			"targetIdentity.mediaPaths",
			record({
				mediaPaths: pathsOf([
					file("jr://file/commcare/image/logo-2.png", ASSET, HASH),
				]).mediaPaths,
			}),
		],
		[
			"targetIdentity.columnWords[].word",
			record({
				columnWords: RECORD.columnWords.map((row) =>
					row.screen === "short" ? { ...row, word: "date_opened" } : row,
				),
			}),
		],
	]);
}

describe("reviewDigestOf", () => {
	it("is 64 lower-case hex characters, equal for equal input", () => {
		const digest = reviewDigestOf(BASE);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(reviewDigestOf(structuredClone(BASE))).toBe(digest);
	});

	it("changes with each part of the review, the document, and the target-identity record: a menu's or form's id, a keyed create's prefix, a media path, a column's word", () => {
		const base = reviewDigestOf(BASE);
		const seen = new Map<string, string>();
		for (const [part, input] of variants()) {
			const digest = reviewDigestOf(input);
			expect(digest, part).not.toBe(base);
			expect(seen.get(digest), part).toBeUndefined();
			seen.set(digest, part);
		}
	});

	it("never digests when the read ended, though a whole review is handed in", () => {
		// A whole review is assignable to the input's review, which omits only the type of `readAt`.
		const laterReview: ReadingReview = {
			...REVIEW,
			readAt: "2026-11-15T10:01:00.000Z",
		};
		const later: ReviewDigestInput = { ...BASE, review: laterReview };
		const { readAt: _readAt, ...withoutReadAt } = REVIEW;
		expect(reviewDigestOf(later)).toBe(reviewDigestOf(BASE));
		expect(reviewDigestOf({ ...BASE, review: withoutReadAt })).toBe(
			reviewDigestOf(BASE),
		);
	});

	it("gives one digest where two asset ids name one content, as a read and its create do", () => {
		// At the read two media documents of one content are two provisional
		// ids; at the create they are one published file. Keyed by content,
		// the document and the paths agree.
		const provisionalA = asMediaAssetId("2a3b4c5d-6e7f-5a8b-9c0d-1e2f3a4b5c6d");
		const provisionalB = asMediaAssetId("3b4c5d6e-7f8a-5b9c-8d1e-2f3a4b5c6d7e");
		const published = asMediaAssetId("4c5d6e7f-8a9b-5c0d-9e2f-3a4b5c6d7e8f");
		const reviewFiles = [
			file("jr://file/commcare/image/a.png", provisionalA, HASH),
			file("jr://file/commcare/image/b.png", provisionalB, HASH),
			file("jr://file/commcare/image/c.png", OTHER_ASSET, OTHER_HASH),
		];
		const createFiles = [
			file("jr://file/commcare/image/a.png", published, HASH),
			file("jr://file/commcare/image/b.png", published, HASH),
			file("jr://file/commcare/image/c.png", OTHER_ASSET, OTHER_HASH),
		];
		const appId = "01937c5e-7d1a-7c3b-8a4f-2b6c9d0e1f99";
		const reviewDoc: PersistableDoc = {
			...toPersistableDoc(emptyBlueprintDoc(appId)),
			logo: provisionalA,
		};
		const createDoc: PersistableDoc = { ...reviewDoc, logo: published };

		const inputOf = (
			doc: PersistableDoc,
			files: readonly AdoptedMediaFile[],
			byContent: boolean,
		): ReviewDigestInput => {
			if (!byContent) {
				return {
					...BASE,
					document: canonicalJsonDigest(doc),
					targetIdentity: pathsOf(files),
				};
			}
			const byId = new Map(
				files.map((one) => [one.assetId, reviewMediaId(one.contentHash)]),
			);
			return {
				...BASE,
				document: canonicalJsonDigest(remapAssetRefs(doc, byId)),
				targetIdentity: pathsOf(
					files.map((one) => ({
						...one,
						assetId: reviewMediaId(one.contentHash),
					})),
				),
			};
		};

		expect(reviewDigestOf(inputOf(reviewDoc, reviewFiles, true))).toBe(
			reviewDigestOf(inputOf(createDoc, createFiles, true)),
		);
		// Keyed by the asset ids themselves, the two moments differ.
		expect(reviewDigestOf(inputOf(reviewDoc, reviewFiles, false))).not.toBe(
			reviewDigestOf(inputOf(createDoc, createFiles, false)),
		);
	});

	it("gives one digest for one record whatever order its rows were gathered in", () => {
		const reordered: TargetIdentity = {
			entities: [...RECORD.entities].reverse(),
			keyedCaseIds: [...RECORD.keyedCaseIds].reverse(),
			mediaPaths: [...RECORD.mediaPaths].reverse(),
			columnWords: [...RECORD.columnWords].reverse(),
		};
		expect(
			reviewDigestOf({
				...BASE,
				targetIdentity: canonicalTargetIdentity(reordered),
			}),
		).toBe(reviewDigestOf(BASE));
	});
});
