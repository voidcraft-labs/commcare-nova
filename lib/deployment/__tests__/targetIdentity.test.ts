/**
 * The target-identity record's one rule, its one projection and its review
 * lines, over plain values.
 *
 * Contract: after a reading is recorded, what a deployment holds of where
 * CommCare HQ keeps things is a function of what it held and what the reading
 * observed, decided for every menu, form, keyed create and file the reading
 * names by the observation, and the identity every export of the deployment
 * prints under is projected from that one record.
 *
 * Plausible failures: an observation reduced to what differs from the
 * derivation before the stored rows are reconciled, so a form CommCare HQ
 * gave back its derived id keeps its old row; a stored row kept beside an
 * observed entity that took its id; a file CommCare HQ moved kept at its old
 * path; a keyed create's new prefix dropped because nothing else changed;
 * a column's word kept where HQ moved the column back to the word Nova
 * writes, or kept on one screen and not the other; export and review
 * projecting the record two ways.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { caseOperationFixture } from "@/lib/commcare/__tests__/caseOperationFixture";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import { patients } from "@/lib/commcare/reader/caseList/__tests__/fixtures";
import { hqColumnFieldText } from "@/lib/commcare/suite/wire";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import type { BlueprintDoc, TargetedCaseOperation, Uuid } from "@/lib/domain";
import { authoredCaseIdPrefix } from "@/lib/domain/caseOperationIdentity";
import { plainColumn } from "@/lib/domain/modules";
import {
	EMPTY_TARGET_IDENTITY,
	exportIdentityOf,
	formIdsAgree,
	type ObservedTargetIdentity,
	resolveTargetIdentity,
	sameTargetIdentity,
	type TargetIdentity,
	targetIdentityChanges,
} from "../targetIdentity";

const APP = { appId: "target-identity-app" };
const MENU = testUuid("target-identity-menu");
const FORM = testUuid("target-identity-form");
const OTHER_FORM = testUuid("target-identity-other-form");
const ASSET_A = testMediaAssetId("target-identity-a");
const ASSET_B = testMediaAssetId("target-identity-b");
const H1 = "1".repeat(32);
const H2 = "2".repeat(32);

/** The keyed create of the operation fixture, and the form that holds it. */
function keyedCreate(doc: BlueprintDoc): {
	readonly formUuid: Uuid;
	readonly create: TargetedCaseOperation;
} {
	for (const [formUuid, form] of Object.entries(doc.forms))
		for (const operation of form.caseOperations ?? [])
			if (
				operation.action === "create" &&
				operation.target.kind === "new" &&
				operation.target.idFrom !== undefined
			)
				return { formUuid: formUuid as Uuid, create: operation };
	throw new Error("The operation fixture holds no keyed create.");
}

function observed(
	over: Partial<ObservedTargetIdentity> = {},
): ObservedTargetIdentity {
	return {
		entities: [],
		keyedCreates: [],
		mediaPaths: [],
		hqPaths: [],
		columnWords: [],
		...over,
	};
}

function stored(over: Partial<TargetIdentity> = {}): TargetIdentity {
	return { ...EMPTY_TARGET_IDENTITY, ...over };
}

function formRow(
	uuid: typeof FORM,
	uniqueId: string | null,
	xmlns: string | null,
) {
	return { entityKind: "form" as const, novaEntityUuid: uuid, uniqueId, xmlns };
}

describe("resolveTargetIdentity: menus and forms", () => {
	it("drops the row of a form the reading now holds under its derivation, which a reduced observation would never meet", () => {
		const next = resolveTargetIdentity(
			stored({ entities: [formRow(FORM, H1, null)] }),
			observed({
				entities: [
					formRow(FORM, derivedUniqueId(FORM), derivedFormXmlns(FORM)),
				],
			}),
			APP,
		);
		expect(next.entities).toEqual([]);
	});

	it("takes the reading's ids for an entity it names, keeps a row of one it doesn't, and drops a row whose id an observed entity now holds", () => {
		const next = resolveTargetIdentity(
			stored({
				entities: [
					formRow(FORM, H1, null),
					formRow(OTHER_FORM, H2, null),
					{
						entityKind: "module",
						novaEntityUuid: MENU,
						uniqueId: "menu-kept",
						xmlns: null,
					},
				],
			}),
			observed({
				entities: [
					/* FORM moved to another id, and the id OTHER_FORM held went to
					 * a new form. */
					formRow(FORM, "3".repeat(32), derivedFormXmlns(FORM)),
					formRow(testUuid("target-identity-new"), H2, "urn:new"),
				],
			}),
			APP,
		);
		expect(next.entities).toEqual(
			[
				formRow(FORM, "3".repeat(32), null),
				formRow(testUuid("target-identity-new"), H2, "urn:new"),
				{
					entityKind: "module",
					novaEntityUuid: MENU,
					uniqueId: "menu-kept",
					xmlns: null,
				},
			].sort((a, b) =>
				a.entityKind !== b.entityKind
					? a.entityKind < b.entityKind
						? -1
						: 1
					: a.novaEntityUuid < b.novaEntityUuid
						? -1
						: 1,
			),
		);
	});

	it("drops a stored row whose `xmlns` an observed form now holds", () => {
		const next = resolveTargetIdentity(
			stored({ entities: [formRow(OTHER_FORM, null, "urn:shared")] }),
			observed({ entities: [formRow(FORM, H1, "urn:shared")] }),
			APP,
		);
		expect(next.entities).toEqual([formRow(FORM, H1, "urn:shared")]);
	});
});

describe("resolveTargetIdentity: keyed creates", () => {
	const doc = caseOperationFixture("key");
	const { formUuid, create } = keyedCreate(doc);
	const prefixA = `nova-case-v1:${testUuid("prefix-a")}:`;
	const prefixB = `nova-case-v1:${testUuid("prefix-b")}:`;
	const derived = authoredCaseIdPrefix({
		appId: doc.appId,
		formUuid,
		operationUuid: create.uuid,
		caseType: create.caseType,
	});
	const keyed = (prefix: string) => ({
		operationUuid: create.uuid,
		formUuid,
		caseType: create.caseType,
		prefix,
	});
	const row = (prefix: string) => ({
		operationUuid: create.uuid,
		caseType: create.caseType,
		prefix,
	});

	it("records a keyed create a reading adds, and follows a prefix changed in CommCare HQ", () => {
		expect(
			resolveTargetIdentity(
				EMPTY_TARGET_IDENTITY,
				observed({ keyedCreates: [keyed(prefixA)] }),
				doc,
			).keyedCaseIds,
		).toEqual([row(prefixA)]);
		expect(
			resolveTargetIdentity(
				stored({ keyedCaseIds: [row(prefixA)] }),
				observed({ keyedCreates: [keyed(prefixB)] }),
				doc,
			).keyedCaseIds,
		).toEqual([row(prefixB)]);
	});

	it("drops the row of a create the reading holds under the document's own derivation", () => {
		expect(
			resolveTargetIdentity(
				stored({ keyedCaseIds: [row(prefixA)] }),
				observed({ keyedCreates: [keyed(derived)] }),
				doc,
			).keyedCaseIds,
		).toEqual([]);
	});

	it("keeps the row of a create the reading doesn't name, unless another create took its prefix", () => {
		const gone = {
			operationUuid: testUuid("operation-gone"),
			caseType: "patient",
			prefix: prefixA,
		};
		expect(
			resolveTargetIdentity(stored({ keyedCaseIds: [gone] }), observed(), doc)
				.keyedCaseIds,
		).toEqual([gone]);
		expect(
			resolveTargetIdentity(
				stored({ keyedCaseIds: [gone] }),
				observed({ keyedCreates: [keyed(prefixA)] }),
				doc,
			).keyedCaseIds,
		).toEqual([row(prefixA)]);
	});

	it("prints each keyed create under the record's prefix while the document still creates that case type, and the derivation otherwise", () => {
		const record = stored({ keyedCaseIds: [row(prefixA)] });
		expect(
			exportIdentityOf(doc, record).keyedCaseIdPrefixes.get(create.uuid),
		).toBe(prefixA);
		expect(
			exportIdentityOf(doc, {
				...record,
				keyedCaseIds: [{ ...row(prefixA), caseType: "another-type" }],
			}).keyedCaseIdPrefixes.has(create.uuid),
		).toBe(false);
	});

	it("names a form whose keyed create moved to another prefix, and nothing where only a new create came in", () => {
		const changes = targetIdentityChanges(
			stored({ keyedCaseIds: [row(prefixA)] }),
			stored({ keyedCaseIds: [row(prefixB)] }),
			doc,
			doc,
		);
		expect(changes.keyedPrefixes).toEqual([doc.forms[formUuid]?.name]);
		expect(
			targetIdentityChanges(
				EMPTY_TARGET_IDENTITY,
				stored({ keyedCaseIds: [row(prefixA)] }),
				doc,
				{ ...doc, forms: {} },
			).keyedPrefixes,
		).toEqual([]);
	});
});

describe("resolveTargetIdentity: media paths", () => {
	const path = (
		assetId: typeof ASSET_A,
		wirePath: string,
		derivedPath = "",
		alsoAt: readonly string[] = [],
	) => ({
		assetId,
		wirePath,
		derivedPath,
		alsoAt,
	});

	it("keeps a file's stored path while CommCare HQ's map still holds it and no other file of the reading stands there", () => {
		const held = stored({
			mediaPaths: [{ assetId: ASSET_A, wirePath: "media/z-icon.png" }],
		});
		/* A path CommCare HQ added beside it moves nothing. */
		expect(
			resolveTargetIdentity(
				held,
				observed({
					mediaPaths: [path(ASSET_A, "media/a-added.png")],
					hqPaths: ["media/z-icon.png", "media/a-added.png"],
				}),
				APP,
			).mediaPaths,
		).toEqual([{ assetId: ASSET_A, wirePath: "media/z-icon.png" }]);
		/* Another file now stands at the stored path: the file follows the
		 * reading. */
		expect(
			resolveTargetIdentity(
				held,
				observed({
					mediaPaths: [
						path(ASSET_A, "media/a-added.png"),
						path(ASSET_B, "media/z-icon.png"),
					],
					hqPaths: ["media/z-icon.png", "media/a-added.png"],
				}),
				APP,
			).mediaPaths,
		).toEqual([
			{ assetId: ASSET_A, wirePath: "media/a-added.png" },
			{ assetId: ASSET_B, wirePath: "media/z-icon.png" },
		]);
	});

	it("follows a file CommCare HQ moved, and drops a row the observed file holds under its derivation", () => {
		expect(
			resolveTargetIdentity(
				stored({
					mediaPaths: [{ assetId: ASSET_A, wirePath: "media/old.png" }],
				}),
				observed({ mediaPaths: [path(ASSET_A, "media/new.png")] }),
				APP,
			).mediaPaths,
		).toEqual([{ assetId: ASSET_A, wirePath: "media/new.png" }]);
		expect(
			resolveTargetIdentity(
				stored({
					mediaPaths: [{ assetId: ASSET_A, wirePath: "media/old.png" }],
				}),
				observed({
					mediaPaths: [
						path(ASSET_A, "commcare/derived.png", "commcare/derived.png"),
					],
				}),
				APP,
			).mediaPaths,
		).toEqual([]);
	});

	/* The database's folded index lowers ASCII letters alone; CommCare HQ's
	 * upload, and the rule, lower every letter. */
	it("drops a stored file's row at a path another observed file takes as CommCare HQ's upload matches a path, and keeps a row the reading doesn't name", () => {
		expect(
			resolveTargetIdentity(
				stored({
					mediaPaths: [
						{ assetId: ASSET_A, wirePath: "commcare/É.png" },
						{ assetId: testMediaAssetId("kept"), wirePath: "media/kept.png" },
					],
				}),
				observed({ mediaPaths: [path(ASSET_B, "commcare/é.png")] }),
				APP,
			).mediaPaths,
		).toEqual([
			{ assetId: ASSET_B, wirePath: "commcare/é.png" },
			{ assetId: testMediaAssetId("kept"), wirePath: "media/kept.png" },
		]);
	});
});

describe("the record over an empty deployment, which a birth writes", () => {
	it("is the observation reduced to what differs from the derivation", () => {
		const next = resolveTargetIdentity(
			EMPTY_TARGET_IDENTITY,
			observed({
				entities: [
					formRow(FORM, H1, derivedFormXmlns(FORM)),
					formRow(
						OTHER_FORM,
						derivedUniqueId(OTHER_FORM),
						derivedFormXmlns(OTHER_FORM),
					),
				],
			}),
			APP,
		);
		expect(next).toEqual({
			entities: [formRow(FORM, H1, null)],
			keyedCaseIds: [],
			mediaPaths: [],
			columnWords: [],
		});
		expect(
			sameTargetIdentity(next, { ...next, entities: [...next.entities] }),
		).toBe(true);
	});
});

describe("formIdsAgree", () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [{ name: "Visit", type: "survey", fields: [] }],
			},
		],
	});
	const form = Object.values(doc.forms)[0];
	if (form === undefined) throw new Error("The document holds a form.");
	const aligned = (
		uniqueId: string,
		xmlns: string | null,
	): HqAlignedModule[] => [
		{
			kind: "aligned",
			uniqueId: null,
			docType: "Module",
			forms: [
				{
					uniqueId,
					xmlns,
					source: {} as never,
					questions: [],
				},
			],
		},
	];

	it("tells a form whose id CommCare HQ moved from one it holds as recorded", () => {
		const xmlns = derivedFormXmlns(form.uuid);
		expect(
			formIdsAgree(
				doc,
				EMPTY_TARGET_IDENTITY,
				aligned(derivedUniqueId(form.uuid), xmlns),
			),
		).toBe(true);
		expect(formIdsAgree(doc, EMPTY_TARGET_IDENTITY, aligned(H1, xmlns))).toBe(
			false,
		);
		expect(
			formIdsAgree(
				doc,
				stored({ entities: [formRow(form.uuid, H1, null)] }),
				aligned(H1, xmlns),
			),
		).toBe(true);
	});

	it("says nothing of an `xmlns` two of CommCare HQ's forms share, as a shadow form shares its parent's", () => {
		const xmlns = derivedFormXmlns(form.uuid);
		const [module] = aligned(H1, xmlns);
		if (module === undefined || module.kind !== "aligned")
			throw new Error("aligned");
		expect(
			formIdsAgree(doc, EMPTY_TARGET_IDENTITY, [
				{
					...module,
					forms: [
						...module.forms,
						{ ...module.forms[0], uniqueId: H2 } as never,
					],
				},
			]),
		).toBe(true);
	});

	it("names a held form whose id moved, by its name", () => {
		expect(
			targetIdentityChanges(
				EMPTY_TARGET_IDENTITY,
				stored({ entities: [formRow(form.uuid, H1, null)] }),
				doc,
				doc,
			).formIds,
		).toEqual([form.name]);
	});
});

describe("resolveTargetIdentity: case list column words", () => {
	const column = testUuid("target-identity-column");
	const doc = patients([plainColumn(column, "case_name", "Name")]);
	const menu = doc.modules[doc.moduleOrder[0] ?? ""];
	const word = (screen: "short" | "long", one: string) => ({
		columnUuid: column,
		screen,
		word: one,
	});

	it("records the word a reading observes where it is not the one Nova writes, on each screen", () => {
		expect(
			resolveTargetIdentity(
				EMPTY_TARGET_IDENTITY,
				observed({
					columnWords: [word("short", "case_name"), word("long", "name")],
				}),
				doc,
			).columnWords,
		).toEqual([word("short", "case_name")]);
	});

	it("follows a word changed in CommCare HQ, dropping the row where HQ went back to Nova's word", () => {
		const record = stored({ columnWords: [word("short", "case_name")] });
		expect(
			resolveTargetIdentity(
				record,
				observed({ columnWords: [word("short", "name")] }),
				doc,
			).columnWords,
		).toEqual([]);
	});

	it("keeps the word of a column on a screen the reading does not name", () => {
		const record = stored({ columnWords: [word("long", "case_name")] });
		expect(
			resolveTargetIdentity(
				record,
				observed({ columnWords: [word("short", "case_name")] }),
				doc,
			).columnWords,
		).toEqual([word("long", "case_name"), word("short", "case_name")]);
	});

	it("prints the column under the record's word on its screen, and Nova's word wherever the record holds none or the column's property no longer takes it", () => {
		const record = stored({ columnWords: [word("long", "case_name")] });
		const { identity } = exportIdentityOf(doc, record);
		expect(identity.columnFieldWord(column, "long")).toBe("case_name");
		expect(identity.columnFieldWord(column, "short")).toBeUndefined();
		expect(
			exportIdentityOf(doc, EMPTY_TARGET_IDENTITY).identity.columnFieldWord(
				column,
				"long",
			),
		).toBeUndefined();
		const dateDoc = patients([plainColumn(column, "date_opened", "Opened")]);
		expect(
			hqColumnFieldText(
				"date_opened",
				exportIdentityOf(dateDoc, record).identity.columnFieldWord(
					column,
					"long",
				),
			),
		).toBe("date-opened");
	});

	it("names a menu whose held column's word moved, and nothing for a column the app did not hold", () => {
		const record = stored({ columnWords: [word("short", "case_name")] });
		expect(
			targetIdentityChanges(EMPTY_TARGET_IDENTITY, record, doc, doc)
				.columnFields,
		).toEqual([menu?.name]);
		expect(
			targetIdentityChanges(record, record, doc, doc).columnFields,
		).toEqual([]);
		const before = patients([]);
		expect(
			targetIdentityChanges(EMPTY_TARGET_IDENTITY, record, doc, {
				...before,
				modules: {
					[doc.moduleOrder[0] ?? ""]:
						before.modules[before.moduleOrder[0] ?? ""],
				},
			} as BlueprintDoc).columnFields,
		).toEqual([]);
	});
});
