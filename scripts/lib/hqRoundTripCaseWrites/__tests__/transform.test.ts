/**
 * The cutover's whole transform of one app (part 09 §7) and its judgement
 * (§7.14, §12), over the pre-step fixtures read raw from the carriers the
 * database holds, and over targets planted where no fixture holds a shape.
 *
 * The per-step cases live beside this file (`stepsCasesLinks.test.ts`,
 * `stepsQuestionsSearch.test.ts`); this file holds what only the whole run
 * can get wrong: the steps composed in the wrong order or over the wrong
 * document, a blocker that hides the judgement's findings, a second
 * application that writes again, a planted target the judgement admits, a
 * case-schema difference given the wrong cause, and a migration witness
 * whose pre-step document the cutover does not turn into its spec's.
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import { expandDoc } from "@/lib/commcare/expander";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	CASE_CLAIM_CASE_TYPE,
	type MediaAssetId,
	type PersistableDoc,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import { ALL_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { asUuid } from "@/lib/domain/uuid";
import { builtinAssetRows } from "@/lib/media/builtinIconAssets";
import { migrationNoticeEntriesSchema } from "@/lib/notices/migrationNotice";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import type { CorpusDocument } from "@/proof/corpus/documents";
import {
	firstPublishRecord,
	recordedDocument,
} from "@/proof/corpus/editBatches";
import {
	migrationAttachment,
	migrationCaseWrites,
	migrationExtensionChildren,
	migrationFormLinks,
	migrationGroupsPreloads,
	migrationQueryRepeats,
	migrationRepeatCounts,
	migrationSearchWorkflow,
} from "@/proof/targeted/documents/migrations";
import { carriersOf } from "../judge";
import { type RawDocument, readRawDocument } from "../oldShape";
import { readBaseline } from "../placements";
import { writesIntoOperations } from "../steps/writesIntoOperations";
import { parseHead, structurePhase } from "../structure";
import { judgeTarget, transformApp } from "../transform";
import {
	type AppTransform,
	type CutoverStepId,
	type PublishedDeployment,
	SEMANTIC_STEPS,
	STRUCTURE_STEPS,
	type StepContext,
} from "../types";
import {
	PRE_STEP_FIXTURE_IDS,
	rawFixture,
	readPreStepJson,
} from "./rawFixture";

// ─── Context ──────────────────────────────────────────────────────────────

/** The built-in icons every export reads, as the fleet read supplies them. */
const MEDIA: ReadonlyMap<MediaAssetId, MediaAssetRecord> = new Map(
	builtinAssetRows(ALL_ICON_SLUGS).map((record) => [
		record.id as MediaAssetId,
		record,
	]),
);

const DEPLOYMENT_ID = "0b6c6a5e-1111-4a5e-9c1e-000000000001";

function appIdOf(id: string): string {
	return (readPreStepJson(`${id}.json`) as { appId: string }).appId;
}

/** The fixture parsed by the head after the structure phase, its field
 *  writes made operations: the writes `main` stored, in the head's shape. */
function writesAsOperations(id: string): BlueprintDoc {
	const structure = structurePhase(rawFixture(id));
	const head = parseHead(appIdOf(id), structure.persisted);
	if (!head.ok) throw new Error(`The fixture ${id} does not parse.`);
	return writesIntoOperations(head.doc, structure.facts).doc;
}

/** Stored `case_type_schemas` rows, canonical text, equal to what `doc`
 *  derives but for the claim type's row, which no stored app holds. */
function storedSchemasOf(doc: BlueprintDoc): Map<string, string> {
	const rows = new Map<string, string>();
	for (const caseType of buildCaseTypeMap(toPersistableDoc(doc)).values())
		if (caseType.name !== CASE_CLAIM_CASE_TYPE)
			rows.set(
				caseType.name,
				canonicalJsonText(caseTypeToJsonSchema(caseType)),
			);
	return rows;
}

function context(id: string, fields: Partial<StepContext> = {}): StepContext {
	return {
		appId: appIdOf(id),
		projectId: "c3a3e0f4-2b8e-4c39-9f7e-6d1b2c3d4e5f",
		lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
		mediaRecords: MEDIA,
		deployments: [],
		storedSchemas: storedSchemasOf(writesAsOperations(id)),
		liveDeployments: [],
		mutationSeq: 7,
		discardsPrivateWork: false,
		...fields,
	};
}

/** CommCare HQ's read of a witness, as the body it answered. */
function hqRead(id: string): unknown {
	const response = JSON.parse(
		readFileSync(
			new URL(
				`../../../../proof/hq-reads/${id}/app-source.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as { body: string };
	return JSON.parse(response.body);
}

/** A live deployment whose `push` baseline is HQ's read of witness `id`. */
function published(id: string): Partial<StepContext> {
	const normalized = normalizeHqAppSource(hqRead(id));
	if ("malformed" in normalized)
		throw new Error(`The read is not an application: ${normalized.malformed}`);
	const deployment: PublishedDeployment = {
		deploymentId: DEPLOYMENT_ID,
		server: "production",
		domain: "nova-space",
		baseline: readBaseline({
			origin: "push",
			source_gzip: gzipSync(Buffer.from(normalized.text, "utf8")),
			source_digest: normalized.digest,
			observed_at: new Date("2026-10-01T00:00:00.000Z"),
		}),
		overrides: [],
		pushedRevision: null,
	};
	return {
		deployments: [deployment],
		liveDeployments: [
			{
				deploymentId: deployment.deploymentId,
				server: deployment.server,
				domain: deployment.domain,
			},
		],
	};
}

/** The carriers the writer would store for `doc`, read back raw. */
function rawOf(doc: BlueprintDoc): RawDocument {
	return readRawDocument(doc.appId, carriersOf(toPersistableDoc(doc)));
}

function targetOf(result: AppTransform): BlueprintDoc {
	if (result.target === null)
		throw new Error(
			`The transform stopped at ${result.blockers.map((b) => b.code).join(", ")}.`,
		);
	return result.target;
}

/** The registry's order of every step, structure first. */
const STEP_ORDER: readonly CutoverStepId[] = [
	...STRUCTURE_STEPS,
	...SEMANTIC_STEPS,
];

/** The change kinds a step reports about the target without writing it. */
const REPORT_ONLY = new Set([
	"extension-children:carried-create",
	"extension-children:non-extension-carried-create",
	"extension-children:module-made-advanced",
]);

// ─── The whole transform ──────────────────────────────────────────────────

/** The one fixture whose transform a blocker stops (part 09 §7.4's C9
 *  arm under `forEach`). */
const BLOCKED = "pre-step-own-close-operation";
const CLEAN = PRE_STEP_FIXTURE_IDS.filter((id) => id !== BLOCKED);

describe("the whole transform over every pre-step fixture", () => {
	it.each(CLEAN)("migrates %s to a target the judgement admits", (id) => {
		const result = transformApp(rawFixture(id), context(id));
		expect(result.blockers).toEqual([]);
		const target = targetOf(result);
		// The target is a stored document the head reads as it is.
		expect(() =>
			blueprintDocSchema.parse(toPersistableDoc(target)),
		).not.toThrow();
		// The steps ran in the table's order.
		const ranks = result.changes.map((change) =>
			STEP_ORDER.indexOf(change.step),
		);
		expect(ranks.every((rank) => rank >= 0)).toBe(true);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		// The one planned case-schema difference of an app whose rows the
		// head's writes derive: the claim type's missing row.
		expect(result.schemaChanges).toEqual([
			{
				caseType: CASE_CLAIM_CASE_TYPE,
				cause: "claim-type-row",
				properties: 0,
			},
		]);
		// An unpublished app holds nothing and gets no deployment line.
		expect(result.held).toEqual([]);
		expect(result.pathMoves).toEqual([]);
		expect(result.notice.every((entry) => entry.kind === "document")).toBe(
			true,
		);
		if (result.notice.length > 0)
			expect(() =>
				migrationNoticeEntriesSchema.parse(result.notice),
			).not.toThrow();
	});

	it("ends the notice with the discarded work's line only where the writer discards it", () => {
		const id = "targeted-migration-attachment";
		const kept = transformApp(rawFixture(id), context(id));
		const discarded = transformApp(
			rawFixture(id),
			context(id, { discardsPrivateWork: true }),
		);
		expect(kept.discardsPrivateWork).toBe(false);
		expect(kept.notice.map((entry) => entry.reason)).not.toContain(
			"unsaved-assistant-work-discarded",
		);
		expect(discarded.discardsPrivateWork).toBe(true);
		expect(discarded.notice.at(-1)?.reason).toBe(
			"unsaved-assistant-work-discarded",
		);
		expect(discarded.notice.slice(0, -1)).toEqual(kept.notice);
	});

	it("gives a published app its holds and its deployment lines", () => {
		const id = "targeted-migration-case-writes";
		const result = transformApp(rawFixture(id), context(id, published(id)));
		expect(result.blockers).toEqual([]);
		expect(result.held.length).toBeGreaterThan(0);
		expect(result.changes.some((change) => change.step === "placements")).toBe(
			true,
		);
		const deploymentLines = result.notice.filter(
			(entry) => entry.kind === "deployment",
		);
		for (const line of deploymentLines)
			expect(line.deployment.deploymentId).toBe(DEPLOYMENT_ID);
		// Deployment lines come first, as the writer stores them.
		const firstDocument = result.notice.findIndex(
			(entry) => entry.kind === "document",
		);
		expect(
			result.notice
				.slice(firstDocument === -1 ? result.notice.length : firstDocument)
				.every((entry) => entry.kind === "document"),
		).toBe(true);
	});

	it.each(["unread", "absent"] as const)(
		"holds a published app whose baseline is %s, and its second application writes nothing",
		(why) => {
			const id = "targeted-migration-case-writes";
			const ctx = context(id, published(id));
			const [deployment] = ctx.deployments;
			if (deployment === undefined) throw new Error("No deployment.");
			const unknown: StepContext = {
				...ctx,
				deployments: [{ ...deployment, baseline: { kind: "unknown", why } }],
			};
			const result = transformApp(rawFixture(id), unknown);
			expect(result.blockers).toEqual([]);
			expect(result.held.length).toBeGreaterThan(0);
			expect(
				result.held.every((held) => held.source === "unknown-baseline"),
			).toBe(true);
			const again = transformApp(rawOf(targetOf(result)), unknown);
			expect(again.blockers).toEqual([]);
			expect(
				again.changes.filter(
					(change) => !REPORT_ONLY.has(`${change.step}:${change.kind}`),
				),
			).toEqual([]);
			expect(canonicalJsonDigest(toPersistableDoc(targetOf(again)))).toBe(
				canonicalJsonDigest(toPersistableDoc(targetOf(result))),
			);
		},
	);

	it("refuses an app whose baseline does not verify, with nothing planned to write", () => {
		const id = "targeted-migration-case-writes";
		const ctx = context(id, published(id));
		const [deployment] = ctx.deployments;
		if (deployment === undefined) throw new Error("No deployment.");
		const result = transformApp(rawFixture(id), {
			...ctx,
			deployments: [
				{ ...deployment, baseline: { kind: "unreadable", why: "digest" } },
			],
		});
		expect(result.target).toBeNull();
		expect(result.blockers.map((blocker) => blocker.code)).toEqual([
			"baseline-unreadable",
		]);
		expect(result.held).toEqual([]);
		expect(result.notice).toEqual([]);
	});
});

describe("a blocker in an early step", () => {
	it("stops the transform and still reports what the judgement finds over the document it left", () => {
		const result = transformApp(rawFixture(BLOCKED), context(BLOCKED));
		expect(result.target).toBeNull();
		expect(result.notice).toEqual([]);
		expect(result.held).toEqual([]);
		const codes = result.blockers.map((blocker) => blocker.code);
		// C9's blocker, then the gate over the head-parsed document step 6
		// left unchanged: its case forms hold no own case change yet.
		expect(codes[0]).toBe("own-close-in-repeat");
		const gate = result.blockers.find(
			(blocker) => blocker.code === "target-gate",
		);
		expect(gate?.findingCodes).toEqual(
			expect.arrayContaining([
				"CASE_OWN_OPERATION",
				"CASE_OWN_OPERATION:missing",
			]),
		);
		// No step after the blocker ran, and idempotence is not judged over a
		// document the remaining steps would still change.
		expect(
			result.changes.every(
				(change) =>
					STEP_ORDER.indexOf(change.step) <=
					STEP_ORDER.indexOf("writes-into-operations"),
			),
		).toBe(true);
		expect(codes).not.toContain("not-idempotent");
		// The blockers stand in the registry's order, one line per code.
		expect(new Set(codes).size).toBe(codes.length);
	});
});

describe("a second application", () => {
	const cases: readonly (readonly [string, boolean])[] = [
		...CLEAN.map((id) => [id, false] as const),
		...Object.keys(WITNESSES()).map((id) => [id, true] as const),
	];
	it.each(cases)("of %s (published: %s) writes nothing", (id, isPublished) => {
		const ctx = context(id, isPublished ? published(id) : {});
		const first = targetOf(transformApp(rawFixture(id), ctx));
		const again = transformApp(rawOf(first), ctx);
		expect(again.blockers).toEqual([]);
		expect(
			again.changes
				.map((change) => `${change.step}:${change.kind}`)
				.filter((kind) => !REPORT_ONLY.has(kind)),
		).toEqual([]);
		expect(canonicalJsonDigest(toPersistableDoc(targetOf(again)))).toBe(
			canonicalJsonDigest(toPersistableDoc(first)),
		);
	});
});

// ─── judgeTarget over planted targets ─────────────────────────────────────

describe("judgeTarget over planted targets", () => {
	const id = "targeted-migration-repeat-counts";
	const raw = rawFixture(id);
	const ctx = context(id);
	const target = targetOf(transformApp(raw, ctx));

	it("finds nothing over the transform's own target", () => {
		expect(judgeTarget(raw, target, ctx)).toEqual([]);
	});

	it("names a gate finding by its code and its reason", () => {
		const registers = "pre-step-registration-updates-own";
		const registersRaw = rawFixture(registers);
		const registersCtx = context(registers);
		const registersTarget = targetOf(transformApp(registersRaw, registersCtx));
		expect(judgeTarget(registersRaw, registersTarget, registersCtx)).toEqual(
			[],
		);
		const registration = Object.values(registersTarget.forms).find(
			(form) => form.type === "registration",
		);
		if (registration === undefined) throw new Error("No registration form.");
		const planted = produce(registersTarget, (draft) => {
			const form = draft.forms[registration.uuid];
			if (form === undefined) return;
			delete form.caseOperations;
		});
		const gate = judgeTarget(registersRaw, planted, registersCtx).find(
			(blocker) => blocker.code === "target-gate",
		);
		expect(gate?.findingCodes).toEqual(
			expect.arrayContaining([
				"CASE_OWN_OPERATION",
				"CASE_OWN_OPERATION:missing",
			]),
		);
		expect(gate?.places?.[0]?.entity).toEqual({
			kind: "form",
			uuid: registration.uuid,
			name: registration.name,
		});
	});

	it("finds a target a second run would change again not idempotent", () => {
		const grouped = "targeted-migration-groups-preloads";
		const groupedRaw = rawFixture(grouped);
		const groupedCtx = context(grouped);
		const groupedTarget = targetOf(transformApp(groupedRaw, groupedCtx));
		expect(judgeTarget(groupedRaw, groupedTarget, groupedCtx)).toEqual([]);
		// `vitals` shows its questions on one screen through the flag step 13
		// wrote; a target without it is one step 13 writes again.
		const planted = produce(groupedTarget, (draft) => {
			const vitals = Object.values(draft.fields).find(
				(field) => field.kind === "group" && field.id === "vitals",
			);
			if (vitals?.kind !== "group" || vitals.fieldList !== true)
				throw new Error("The fixture's vitals group holds no flag.");
			delete vitals.fieldList;
		});
		const blockers = judgeTarget(groupedRaw, planted, groupedCtx);
		expect(blockers.map((blocker) => blocker.code)).toEqual(["not-idempotent"]);
		expect(blockers[0]?.findingCodes).toEqual([
			"change:field-list-flags:field-list-set",
			"digest",
		]);
	});

	const schemaFixture = "pre-step-registration-updates-own";
	const schemaRaw = rawFixture(schemaFixture);
	const schemaCtx = context(schemaFixture);
	const schemaTarget = targetOf(transformApp(schemaRaw, schemaCtx));

	it("finds a property gained, lost or unreadable in the stored rows unplanned", () => {
		const [caseType, text] =
			[...schemaCtx.storedSchemas].find(
				([name]) => name !== USERCASE_CASE_TYPE,
			) ?? [];
		if (caseType === undefined || text === undefined)
			throw new Error("The fixture stores no case type.");
		const stored = JSON.parse(text) as {
			properties: Record<string, unknown>;
		};
		const [first] = Object.keys(stored.properties);
		if (first === undefined) throw new Error("The row holds no property.");
		const { [first]: _dropped, ...rest } = stored.properties;
		const rows = (properties: Record<string, unknown>) =>
			new Map([
				...schemaCtx.storedSchemas,
				[caseType, canonicalJsonText({ ...stored, properties })],
			]);
		const unplanned = (storedSchemas: ReadonlyMap<string, string>) =>
			judgeTarget(schemaRaw, schemaTarget, {
				...schemaCtx,
				storedSchemas,
			}).find((blocker) => blocker.code === "case-schema-unplanned")
				?.findingCodes;
		expect(unplanned(rows(rest))).toEqual(["added"]);
		expect(
			unplanned(rows({ ...stored.properties, gone: { type: "string" } })),
		).toEqual(["removed"]);
		expect(
			unplanned(rows({ ...stored.properties, [first]: { type: "object" } })),
		).toEqual(["unresolvable"]);
		expect(
			unplanned(
				new Map(
					[...schemaCtx.storedSchemas].filter(([name]) => name !== caseType),
				),
			),
		).toEqual(["missing-row"]);
	});

	it("plans a property both sides carry whose derived type moved as derivation drift", () => {
		const [caseType, text] =
			[...schemaCtx.storedSchemas].find(
				([name]) => name !== USERCASE_CASE_TYPE,
			) ?? [];
		if (caseType === undefined || text === undefined)
			throw new Error("The fixture stores no case type.");
		const stored = JSON.parse(text) as {
			properties: Record<string, unknown>;
		};
		const [first] = Object.keys(stored.properties);
		if (first === undefined) throw new Error("The row holds no property.");
		const storedSchemas = new Map([
			...schemaCtx.storedSchemas,
			[
				caseType,
				canonicalJsonText({
					...stored,
					properties: { ...stored.properties, [first]: { type: "integer" } },
				}),
			],
		]);
		const result = transformApp(schemaRaw, { ...schemaCtx, storedSchemas });
		expect(result.blockers).toEqual([]);
		expect(result.schemaChanges).toContainEqual({
			caseType,
			cause: "derivation-drift",
			properties: 1,
		});
	});
});

describe("the case schema of a capture that saved its file", () => {
	const id = "targeted-migration-attachment";

	it("plans the property only an attachment-mode write wrote, missing or materialized", () => {
		const ctx = context(id);
		const stored = JSON.parse(ctx.storedSchemas.get("patient") ?? "{}") as {
			properties: Record<string, unknown>;
		};
		const { photo: _photo, scan: _scan, ...rest } = stored.properties;
		const withRow = (properties: Record<string, unknown>) =>
			transformApp(rawFixture(id), {
				...ctx,
				storedSchemas: new Map([
					...ctx.storedSchemas,
					["patient", canonicalJsonText({ ...stored, properties })],
				]),
			});
		for (const result of [
			withRow({ ...rest, scan: stored.properties.scan }),
			withRow({
				...rest,
				scan: stored.properties.scan,
				photo: { type: "string", title: "photo" },
			}),
		]) {
			expect(result.blockers).toEqual([]);
			expect(result.schemaChanges).toContainEqual({
				caseType: "patient",
				cause: "capture-link-property",
				properties: 1,
			});
		}
		// A property a link-mode capture also wrote is no capture-link change.
		const scanMissing = withRow({ ...rest, photo: stored.properties.photo });
		expect(scanMissing.blockers.map((blocker) => blocker.code)).toEqual([
			"case-schema-unplanned",
		]);
	});
});

// ─── The witnesses (part 08 §5.2) ─────────────────────────────────────────

function WITNESSES(): Readonly<Record<string, () => CorpusDocument>> {
	return {
		"targeted-migration-case-writes": migrationCaseWrites,
		"targeted-migration-extension-children": migrationExtensionChildren,
		"targeted-migration-query-repeats": migrationQueryRepeats,
		"targeted-migration-groups-preloads": migrationGroupsPreloads,
		"targeted-migration-search-workflow": migrationSearchWorkflow,
		"targeted-migration-form-links": migrationFormLinks,
		"targeted-migration-attachment": migrationAttachment,
		"targeted-migration-repeat-counts": migrationRepeatCounts,
	};
}

/**
 * The witnesses whose spec builds each case change as the cutover does, from
 * its questions' writes (`migrateFieldWrites`) with the holds a published
 * app's A carries. The other three build the own case with `buildDoc`'s
 * identity and leave every hold to the record their first publish over A
 * writes, so their documents are compared with those two left out.
 */
const CUTOVER_BUILT = new Set([
	"targeted-migration-case-writes",
	"targeted-migration-extension-children",
	"targeted-migration-query-repeats",
	"targeted-migration-groups-preloads",
	"targeted-migration-repeat-counts",
]);

/** B as part 08 defines it: the republish's HQ application, the document
 *  as its first publish over A records it. */
function republished(id: string, doc: BlueprintDoc): string {
	const recorded = recordedDocument(
		id,
		doc,
		firstPublishRecord(doc),
		undefined,
	);
	return canonicalJsonText(
		expandDoc(recorded, {
			identity: targetWireIdentity([]),
			lookupNaming: identityLookupWireNaming(),
		}),
	);
}

/** A document without the own case's identity and without any hold. */
function withoutIdentityAndHolds(doc: BlueprintDoc): PersistableDoc {
	return produce(toPersistableDoc(doc), (draft) => {
		for (const form of Object.values(draft.forms)) {
			delete form.ownClosePlacement;
			for (const operation of form.caseOperations ?? []) {
				delete operation.placement;
				if (operation.action === "own")
					operation.uuid = asUuid("00000000-0000-4000-8000-000000000000");
			}
		}
	});
}

describe("the migration witnesses", () => {
	it.each(Object.keys(WITNESSES()))(
		"migrates each witness's pre-step document to its spec's document: %s",
		(id) => {
			const build = WITNESSES()[id];
			if (build === undefined) throw new Error(`No witness ${id}.`);
			const spec = hydratePersistedBlueprint(
				blueprintDocSchema.parse(build().doc),
			);
			const result = transformApp(rawFixture(id), context(id, published(id)));
			expect(result.blockers).toEqual([]);
			const target = targetOf(result);
			if (CUTOVER_BUILT.has(id)) {
				expect(toPersistableDoc(target)).toEqual(toPersistableDoc(spec));
				expect(canonicalJsonDigest(toPersistableDoc(target))).toBe(
					canonicalJsonDigest(toPersistableDoc(spec)),
				);
			} else {
				expect(withoutIdentityAndHolds(target)).toEqual(
					withoutIdentityAndHolds(spec),
				);
			}
			expect(republished(id, target)).toBe(republished(id, spec));
		},
	);
});
