/**
 * The last stage of a reading and the reader's canonical choices.
 *
 * Contract: over drafts the stages built from an export, where no finding
 * stands, the draft's document parses whole and the construction batch a
 * birth reduces (`diffDocsToMutations` from the empty document), applied to
 * the empty document, rebuilds it, with every held placement in one trailing
 * `holdPlacements`, and its identities and form facts name the document's own
 * menus and forms; a document the schema refuses gives no draft and the defect
 * `assembly`; content no platform runs whole is `no-platform-runs-everything`
 * at each use, alone and beside another finding; a generated translation key
 * folds into its text once per unit, in the source language into the slot and
 * in another through the translation entries, is counted once per key, and
 * none is ever `unrecognized`; a date and time question Nova split reads back
 * whole as its three questions. Each canonical choice rewrites one member of
 * its pair into the other and leaves a document outside the pair as it was.
 *
 * Plausible failures: a batch that rebuilds another document, a fold counted
 * twice or never reaching the document, a refused document returned, a
 * declaration verdict silenced by another finding.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	mutationCommitVerdict,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { planDatetimeSplits } from "@/lib/doc/datetimeSplit";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type CaseOperation,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	type SearchInputDef,
	simpleSearchInputDef,
	type TranslationUnitId,
	translationSourceFingerprint,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import { PLATFORM_FEATURE_FIXTURES } from "@/lib/domain/__tests__/platformFeatureFixtures";
import type { Expression } from "@/lib/domain/expression";
import {
	and,
	eq,
	formField,
	input,
	literal,
	matchAll,
	matchNone,
	prop,
	sessionUserProperty,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import {
	columnSort,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	type SearchInputRequired,
	tileCell,
} from "@/lib/domain/modules";
import {
	advancedFixture,
	OP,
	read as readField,
	U,
} from "../../__tests__/advancedPlacementFixture";
import { caseOperationFixture } from "../../__tests__/caseOperationFixture";
import { localizationWireFixture } from "../../__tests__/localizationWireFixture";
import { expandDoc } from "../../expander";
import { placementsToHold } from "../../placementHolds";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { assembleDocument, READER_CANONICAL_CHOICES } from "../assemble";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import {
	columnsOfAMenuThatListsNoCases,
	columnsOffAScreenLast,
} from "../caseList/details";
import {
	implicitOrderRuleIsAbsent,
	orderPrioritiesAsRead,
} from "../caseList/order";
import { tileColumnsShownNowhereAsRead } from "../caseList/tile";
import { catalogAsRead } from "../caseManagement/catalog";
import { updateBesideBareOwnAsOwnArm } from "../caseManagement/saveToCase";
import type { ReadContext } from "../context";
import { externalKey, matchingResolver, mintEntityUuid } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { knownCaseTypesOf, readHqApp, STAGES } from "../index";
import { resourcedDocument } from "../languages";
import { exactSearchModeIsAbsent } from "../search/prompts";
import { emptySearchSettingsBesideFieldsAreAbsent } from "../search/settings";
import type { AppStringTable } from "../types";
import { levelsAsPublished } from "../worldEntities";
import { connectDefaultsUnset } from "../xform/afterBinding";
import { X } from "../xform/claims";
import { blankOptionalTextAbsent } from "../xform/prose";
import { exportedBody, inputFor } from "./novaExport";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

/** A reading of `body` run through every stage before the assembly. */
async function beforeAssembly(
	body: Record<string, unknown>,
): Promise<ReadContext> {
	const input = readerInput(await sourceFromBody(body));
	const ctx = readContext({ ...input, recordDialect: () => undefined });
	for (const stage of STAGES) {
		if (stage === assembleDocument) break;
		stage(ctx);
	}
	return ctx;
}

/** The document a re-read of `doc`'s export gives, the project space holding
 *  `doc`'s levels; throws with the findings where there is none. */
async function readExport(doc: BlueprintDoc): Promise<BlueprintDoc> {
	const levels = levelsAsPublished(doc);
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
			organization: { levelCodes: levels.map((one) => one.code), levels },
		}),
	);
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(
			`The export did not read: ${outcome.findings.map((one) => one.code).join(", ")}`,
		);
	return outcome.draft.doc;
}

/** The two members of a row print one source: `expandDoc` of each, byte for
 *  byte. */
function sameExport(a: BlueprintDoc, b: BlueprintDoc): void {
	expect(JSON.stringify(expandDoc(a))).toBe(JSON.stringify(expandDoc(b)));
}

function holding(doc: BlueprintDoc): BlueprintDoc {
	return prepareMutationCandidate(
		doc,
		admitMutationBatch([
			{ kind: "holdPlacements", holds: [...placementsToHold(doc)] },
		]),
	).nextDoc;
}

function caseApp(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Clients",
				caseType: "client",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "client", property: "case_name" },
							}),
						],
					},
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: "Note",
								caseWrite: { caseType: "client", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
}

describe("the assembly", () => {
	it("gives a draft whose batch rebuilds the document, its holds last", async () => {
		const ctx = await beforeAssembly(exportedBody(caseApp()));
		assembleDocument(ctx);
		const draft = ctx.assembled;
		if (draft === undefined)
			throw new Error(JSON.stringify(ctx.close().findings));
		const batch = diffDocsToMutations(
			emptyBlueprintDoc(ctx.input.appId),
			draft.doc,
		);
		const rebuilt = produce(emptyBlueprintDoc(ctx.input.appId), (empty) => {
			applyMutations(empty, batch);
		});
		expect(toPersistableDoc(rebuilt)).toEqual(toPersistableDoc(draft.doc));
		const holds = batch.filter(
			(mutation) => mutation.kind === "holdPlacements",
		);
		expect(holds).toHaveLength(1);
		expect(batch.at(-1)?.kind).toBe("holdPlacements");
		expect(placementsToHold(draft.doc)).toEqual([]);
		expect(draft.declaration.kind).toBe("choices");
		// The identities name the document's own menus and forms, by the drafts that read them.
		expect(draft.identities.modules.map((one) => one.uuid)).toEqual(
			draft.doc.moduleOrder,
		);
		expect(draft.identities.forms.map((one) => one.uuid)).toEqual(
			draft.doc.moduleOrder.flatMap((menu) => draft.doc.formOrder[menu] ?? []),
		);
		expect(draft.facts.forms.map((one) => one.xmlns)).toEqual(
			draft.identities.forms.map((one) => one.xmlns),
		);
	});

	it("names a folded registration form under the hidden menu HQ holds it in", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					caseSearchConfig: { formsReadSearch: true },
					caseListRegistrationForm: { formUuid: "reg" },
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "notes",
									caseWrite: { caseType: "patient", property: "notes" },
								}),
							],
						},
						{
							uuid: "reg",
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
		});
		const body = exportedBody(doc);
		const ctx = await beforeAssembly(body);
		assembleDocument(ctx);
		const draft = ctx.assembled;
		if (draft === undefined)
			throw new Error(JSON.stringify(ctx.close().findings));
		// HQ holds each form in the menu its JSON lists it under: the registration in the hidden menu.
		const held = (body.modules as Record<string, unknown>[]).flatMap((menu) =>
			(menu.forms as Record<string, unknown>[]).map((form) => ({
				xmlns: form.xmlns,
				moduleUniqueId: menu.unique_id,
			})),
		);
		expect(held).toHaveLength(2);
		expect(new Set(held.map((one) => one.moduleUniqueId)).size).toBe(2);
		expect(
			draft.identities.forms.map(({ xmlns, moduleUniqueId }) => ({
				xmlns,
				moduleUniqueId,
			})),
		).toEqual(held);
	});

	it("gives no draft for a document the schema refuses, and says so", async () => {
		const ctx = await beforeAssembly(exportedBody(caseApp()));
		const doc = ctx.doc;
		if (doc === undefined) throw new Error("The stages bind a document.");
		const question = doc.fieldOrder[
			doc.formOrder[doc.moduleOrder[0] as Uuid]?.[0] as Uuid
		]?.[0] as Uuid;
		ctx.doc = Object.freeze(
			produce(doc, (draft) => {
				delete (draft.fields[question] as { label?: unknown }).label;
			}),
		);
		assembleDocument(ctx);
		expect(ctx.assembled).toBeUndefined();
		const closed = ctx.close();
		expect(closed.findings.map((finding) => finding.detail.name)).toContain(
			"schema:Application.modules",
		);
		expect(closed.defects.map((defect) => defect.why)).toEqual([
			expect.stringMatching(/^assembly at app: fields: /),
		]);
	});

	it("names each use no platform runs, alone and beside another finding", async () => {
		/* The stages read the fixture's export; the bound document then gains a menu whose forms
		 * read the search beside `here()` in a case list, content no platform runs whole, which
		 * no export of an admitted document holds. */
		const neither = (doc: BlueprintDoc) =>
			Object.freeze(
				produce(doc, (draft) => {
					delete draft.appSettings.runsOnlyOn;
					for (const module of Object.values(draft.modules))
						module.caseSearchConfig = { formsReadSearch: true };
				}),
			);
		for (const other of [false, true]) {
			const ctx = await beforeAssembly(
				exportedBody(PLATFORM_FEATURE_FIXTURES["case-list-here"].with()),
			);
			if (other) ctx.accounting.finding(X.loadOrder, { kind: "app" });
			if (ctx.doc === undefined) throw new Error("The stages bind a document.");
			ctx.doc = neither(ctx.doc);
			assembleDocument(ctx);
			const names = ctx
				.close()
				.findings.filter(
					(finding) => finding.code === "no-platform-runs-everything",
				)
				.map((finding) => finding.detail.name);
			expect(names).toEqual([
				"“Forms that read the search”, which Android can't run",
				"“here() in a case list”, which Web Apps can't run",
			]);
			expect(ctx.assembled).toBeUndefined();
		}
	});
});

/** A shell with one menu and the given strings in its first language. */
function shellWithMenu(
	strings: Record<string, unknown>,
): Record<string, unknown> {
	const shell = retainedSourceBody("shell/app-source");
	return {
		...shell,
		modules: [
			{
				doc_type: "Module",
				unique_id: "menu-one",
				name: { en: "Clients" },
				case_type: null,
				forms: [],
			},
		],
		translations: { en: { en: "English", ...strings } },
	};
}

/** The strings Nova's build gives a document: the first menu's name, under its unit. */
function menuStrings(doc: BlueprintDoc): AppStringTable {
	const menu = doc.moduleOrder[0] as Uuid;
	return {
		languages: { en: { "modules.m0": doc.modules[menu]?.name ?? "" } },
		units: { "modules.m0": makeTranslationUnitId("module", menu, "name") },
	};
}

describe("a generated key in the assembly", () => {
	it("refuses an override of a string no wording writes, and folds it into nothing", async () => {
		const input = readerInput(
			await sourceFromBody(shellWithMenu({ "modules.m0": "Patients" })),
		);
		const outcome = readHqApp(
			{ ...input, recordDialect: () => undefined, appStrings: menuStrings },
			{ claims: "full" },
		);
		const records = [...outcome.claims.records()].filter((record) =>
			record.entry.includes("translations-generated-key"),
		);
		expect(records.map((record) => record.entry)).toEqual([
			"application-and-settings/translations-generated-key-anything-else",
		]);
		expect(outcome.kind).toBe("account");
	});

	it("reads an override of a menu's name as the menu title's own wording, the name as stored", async () => {
		const input = readerInput(
			await sourceFromBody(shellWithMenu({ "modules.m0": "Patients" })),
		);
		const outcome = readHqApp(
			{
				...input,
				recordDialect: () => undefined,
				appStrings: (doc) => ({
					...menuStrings(doc),
					wordingUnits: {
						"modules.m0": generatedWordingId(
							doc.moduleOrder[0] as Uuid,
							"menuTitle",
						),
					},
				}),
			},
			{ claims: "full" },
		);
		if (outcome.kind !== "read")
			throw new Error(
				JSON.stringify(outcome.findings.map((one) => one.detail.name)),
			);
		const records = [...outcome.claims.records()].filter((record) =>
			record.entry.includes("translations-generated"),
		);
		expect(records.map((record) => record.entry)).toEqual([
			"application-and-settings/translations-generated-wording",
		]);
		const read = outcome.draft.doc;
		const menu = read.moduleOrder[0] as Uuid;
		expect(read.modules[menu]?.name).toBe("Clients");
		expect(
			read.localization?.generatedSourceWording?.[
				generatedWordingId(menu, "menuTitle")
			]?.value,
		).toBe("Patients");
	});
});

describe("the reader's canonical choices", () => {
	const choice = (id: string) => {
		const found = READER_CANONICAL_CHOICES.find((one) => one.id === id);
		if (found === undefined) throw new Error(`No canonical choice ${id}.`);
		return found;
	};

	it("reads a root of Question Lists as sections, and leaves one holding a condition", () => {
		const lists = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Pages",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "one",
									label: "One",
									fieldList: true,
									children: [f({ kind: "text", id: "a", label: "A" })],
								}),
							],
						},
					],
				},
			],
		});
		const row = choice("root-question-lists-are-sections");
		const sections = row.apply(lists);
		expect(
			Object.values(sections.fields).find((one) => one.id === "one")?.kind,
		).toBe("section");
		sameExport(sections, lists);
		expect(row.apply(sections)).toEqual(sections);
		const conditioned = produce(lists, (draft) => {
			const group = Object.values(draft.fields).find((one) => one.id === "one");
			if (group?.kind === "group")
				group.relevant = {
					kind: "term",
					term: { kind: "literal", value: "true" },
				} as never;
		});
		expect(
			Object.values(
				choice("root-question-lists-are-sections").apply(conditioned).fields,
			).find((one) => one.id === "one")?.kind,
		).toBe("group");
	});

	it("drops a blank container label and a plain flag on a blank text", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "g",
									label: { parts: [] },
									children: [f({ kind: "text", id: "a", label: "A" })],
								}),
								f({
									kind: "text",
									id: "b",
									label: "B",
									help: { parts: [] },
									plainHelp: true,
								}),
							],
						},
					],
				},
			],
		});
		const unlabelled = choice("blank-container-label-is-absent").apply(doc);
		sameExport(unlabelled, doc);
		const unflagged = choice("plain-flag-on-blank-text-is-absent").apply(
			unlabelled,
		);
		sameExport(unflagged, doc);
		const fields = Object.values(unflagged.fields) as unknown as Record<
			string,
			unknown
		>[];
		expect(fields.find((one) => one.id === "g")).not.toHaveProperty("label");
		expect(fields.find((one) => one.id === "b")).not.toHaveProperty(
			"plainHelp",
		);
	});

	it("keeps a plain flag on a blank text that carries media and on every choice, and drops one on a blank label with none", () => {
		const image = "33333333-3333-4333-8333-333333333333";
		const doc = produce(
			buildDoc({
				modules: [
					{
						name: "Survey",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "pick",
										label: "Pick",
										options: [
											{ value: "a", label: "A" },
											{ value: "b", label: "B" },
										],
									}),
									f({ kind: "text", id: "blank", label: "Blank" }),
								],
							},
						],
					},
				],
			}),
			(draft) => {
				const pick = Object.values(draft.fields).find(
					(one) => one.id === "pick",
				) as unknown as Record<string, unknown> & {
					optionsSource: {
						options: Record<string, unknown>[];
					};
				};
				pick.label = { parts: [] };
				pick.label_media = { image };
				pick.plainLabel = true;
				const [withMedia, written] = pick.optionsSource.options;
				Object.assign(withMedia ?? {}, {
					label: { parts: [] },
					media: { image },
					plainLabel: true,
				});
				Object.assign(written ?? {}, { plainLabel: true });
				const blank = Object.values(draft.fields).find(
					(one) => one.id === "blank",
				) as unknown as Record<string, unknown>;
				blank.label = { parts: [] };
				blank.plainLabel = true;
			},
		);
		const row = choice("plain-flag-on-blank-text-is-absent");
		const read = row.apply(doc);
		sameExport(read, doc);
		expect(row.apply(read)).toEqual(read);
		const fieldNamed = (one: BlueprintDoc, id: string) =>
			Object.values(one.fields).find((field) => field.id === id) as unknown as {
				plainLabel?: true;
				optionsSource?: { options: { plainLabel?: true }[] };
			};
		const pick = fieldNamed(read, "pick");
		expect(pick.plainLabel).toBe(true);
		expect(pick.optionsSource?.options.map((one) => one.plainLabel)).toEqual([
			true,
			true,
		]);
		expect(fieldNamed(doc, "blank").plainLabel).toBe(true);
		expect(fieldNamed(read, "blank")).not.toHaveProperty("plainLabel");
	});

	it("drops every plain flag in a form whose text formatting is off, a choice's alike, and keeps one elsewhere", () => {
		const selectForm = (name: string) => ({
			name,
			type: "survey" as const,
			fields: [
				f({
					kind: "single_select",
					id: "pick",
					label: "Pick",
					help: "Help",
					options: [
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					],
				}),
			],
		});
		const doc = produce(
			buildDoc({
				modules: [
					{
						name: "Survey",
						forms: [selectForm("Plain"), selectForm("Formatted")],
					},
				],
			}),
			(draft) => {
				for (const form of Object.values(draft.forms))
					if (form.name === "Plain") form.plainText = true;
				for (const field of Object.values(draft.fields)) {
					const pick = field as unknown as Record<string, unknown> & {
						optionsSource: { options: Record<string, unknown>[] };
					};
					pick.plainLabel = true;
					pick.plainHelp = true;
					const [first] = pick.optionsSource.options;
					if (first !== undefined) first.plainLabel = true;
				}
			},
		);
		const read = choice("plain-flag-under-plain-text-is-absent").apply(doc);
		sameExport(read, doc);
		const flagsIn = (formName: string) => {
			const form = Object.entries(read.forms).find(
				([, one]) => one.name === formName,
			)?.[0] as Uuid;
			const pick = read.fields[
				read.fieldOrder[form]?.[0] as Uuid
			] as unknown as {
				plainLabel?: true;
				plainHelp?: true;
				optionsSource: { options: { plainLabel?: true }[] };
			};
			return [
				pick.plainLabel,
				pick.plainHelp,
				...pick.optionsSource.options.map((one) => one.plainLabel),
			];
		};
		expect(flagsIn("Plain")).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(flagsIn("Formatted")).toEqual([true, true, true, undefined]);
	});

	it("drops a required condition on the question that names a created case", () => {
		const doc = produce(caseApp(), (draft) => {
			const name = Object.values(draft.fields).find(
				(one) => one.id === "case_name",
			) as { required?: unknown };
			name.required = { kind: "term", term: { kind: "literal", value: "x" } };
		});
		const read = choice("create-name-required-is-absent").apply(doc);
		sameExport(read, doc);
		const name = Object.values(read.fields).find(
			(one) => one.id === "case_name",
		);
		expect(name).not.toHaveProperty("required");
		const note = Object.values(read.fields).find((one) => one.id === "note");
		expect(note).toEqual(
			Object.values(doc.fields).find((one) => one.id === "note"),
		);
	});

	it("reads a list filter that simplifies to match-all as none, the two printing one source, and keeps one that narrows", () => {
		const listed = (filter: Expression) =>
			produce(caseApp(), (draft) => {
				const module = Object.values(draft.modules)[0];
				if (module === undefined) throw new Error("The app has no menu.");
				module.caseListConfig = {
					...caseListConfig([{ field: "note", header: "Note" }]),
					filter,
				};
			});
		for (const filter of [matchAll(), and(matchAll(), matchAll())]) {
			const doc = listed(filter);
			const read = choice("match-all-list-filter-is-absent").apply(doc);
			expect(Object.values(read.modules)[0]?.caseListConfig).not.toHaveProperty(
				"filter",
			);
			expect(expandDoc(read)).toEqual(expandDoc(doc));
		}
		const narrowing = listed(matchNone());
		expect(choice("match-all-list-filter-is-absent").apply(narrowing)).toEqual(
			narrowing,
		);
	});

	it("reads an opened case's acting-user owner as none, the two printing one source, and keeps an update's", () => {
		const doc = caseOperationFixture("sequence");
		const operations = () =>
			Object.values(doc.forms).flatMap((form) => form.caseOperations ?? []);
		const create = operations().find((one) => one.action === "create");
		expect(create).toMatchObject({ owner: { kind: "acting-user" } });
		const read = choice("opened-case-owner-acting-user-is-absent").apply(doc);
		const readCreate = Object.values(read.forms)
			.flatMap((form) => form.caseOperations ?? [])
			.find((one) => one.uuid === create?.uuid);
		expect(readCreate).not.toHaveProperty("owner");
		expect(expandDoc(read)).toEqual(expandDoc(doc));
		const updating = produce(doc, (draft) => {
			const update = Object.values(draft.forms)
				.flatMap((form) => form.caseOperations ?? [])
				.find((one) => one.action === "update") as
				| { owner?: unknown }
				| undefined;
			if (update === undefined) throw new Error("The fixture has no update.");
			update.owner = { kind: "acting-user" };
		});
		const kept = choice("opened-case-owner-acting-user-is-absent").apply(
			updating,
		);
		expect(
			Object.values(kept.forms)
				.flatMap((form) => form.caseOperations ?? [])
				.find((one) => one.action === "update"),
		).toMatchObject({ owner: { kind: "acting-user" } });
	});

	it("reads an update beside a bare own arm as the own arm, before the slot ids are derived", () => {
		// `caseManagement/__tests__/operationReadBack.test.ts` holds each pair:
		// both exports, the row a fixed point, and a reading whole.
		const row = choice("update-beside-a-bare-own-arm-is-the-own-arm");
		expect(row.apply).toBe(updateBesideBareOwnAsOwnArm);
		expect(READER_CANONICAL_CHOICES.indexOf(row)).toBeLessThan(
			READER_CANONICAL_CHOICES.indexOf(
				choice("basic-slot-operation-ids-are-derived"),
			),
		);
	});

	it("names each operation a slot of Case Management keeps as a reading does, the two printing one source", async () => {
		const base = buildDoc({
			modules: [
				{
					name: "Clients",
					caseType: "client",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "note",
									label: "Note",
									caseWrite: { caseType: "client", property: "note" },
								}),
							],
						},
					],
				},
				{
					name: "Visits",
					caseType: "visit",
					// A form holding a question: CommCare HQ builds no form that holds none, and the
					// reader refuses one whole.
					forms: [
						{
							name: "Review",
							type: "followup",
							fields: [f({ kind: "text", id: "seen", label: "Seen" })],
						},
					],
				},
			],
		});
		const visitForm = Object.values(base.forms).find(
			(one) => one.name === "Visit",
		);
		const note = Object.values(base.fields).find((one) => one.id === "note");
		if (visitForm === undefined || note === undefined)
			throw new Error("The app has no Visit form.");
		const doc = produce(base, (draft) => {
			const operations = draft.forms[visitForm.uuid]?.caseOperations ?? [];
			const own = operations.find((one) => one.action === "own");
			if (own === undefined) throw new Error("The Visit form has no own arm.");
			own.id = "renamed_own";
			operations.push({
				uuid: "00000000-0000-4000-8000-0000000000c1" as Uuid,
				id: "a_visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: term(formField(note.uuid)),
				writes: [],
				links: [
					{
						identifier: "parent",
						targetType: "client",
						target: { kind: "session" },
						relationship: "child",
					},
				],
			} as CaseOperation);
			draft.forms[visitForm.uuid] = {
				...draft.forms[visitForm.uuid],
				caseOperations: operations,
			} as BlueprintDoc["forms"][Uuid];
		});
		const idsOf = (one: BlueprintDoc) =>
			(one.forms[visitForm.uuid]?.caseOperations ?? []).map((operation) => [
				operation.action,
				operation.id,
			]);
		expect(idsOf(doc)).toEqual([
			["own", "renamed_own"],
			["create", "a_visit"],
		]);
		const read = choice("basic-slot-operation-ids-are-derived").apply(doc);
		expect(idsOf(read)).toEqual([
			["own", "client"],
			["create", "visit"],
		]);
		expect(expandDoc(read)).toEqual(expandDoc(doc));
		expect(choice("basic-slot-operation-ids-are-derived").apply(read)).toBe(
			read,
		);

		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		if (outcome.kind !== "read")
			throw new Error(
				JSON.stringify(
					outcome.findings.map((one) => [one.code, one.detail.name]),
				),
			);
		const readBack = Object.values(outcome.draft.doc.forms).find(
			(one) => one.name === "Visit",
		);
		expect(
			(readBack?.caseOperations ?? [])
				.map((operation) => [operation.action, operation.id])
				.sort(),
		).toEqual([...idsOf(read)].sort());
	});

	it("names an operation a slot of Case Management keeps past the id a Save to Case block carries", async () => {
		// A follow-up of clients whose own change writes the note in Case
		// Management, beside a create of a client keyed by an answer, which
		// takes a Save to Case block: a document the commit gate admits.
		const base = buildDoc({
			caseTypes: [
				{
					name: "client",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "note", label: proseText("Note"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Clients",
					caseType: "client",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "note", label: "Note" }),
								f({ kind: "text", id: "key", label: "Key" }),
							],
						},
					],
				},
			],
		});
		const visitForm = Object.values(base.forms).find(
			(one) => one.name === "Visit",
		);
		const note = Object.values(base.fields).find((one) => one.id === "note");
		const key = Object.values(base.fields).find((one) => one.id === "key");
		if (visitForm === undefined || note === undefined || key === undefined)
			throw new Error("The app has no Visit form.");
		// The keyed create carries its id `client`, the id the own change's case
		// type would give it.
		const doc = produce(base, (draft) => {
			const form = draft.forms[visitForm.uuid];
			if (form === undefined) return;
			form.caseOperations = [
				{
					uuid: "00000000-0000-4000-8000-0000000000c3" as Uuid,
					id: "renamed_own",
					action: "own",
					writes: [{ property: "note", value: term(formField(note.uuid)) }],
				},
				{
					uuid: "00000000-0000-4000-8000-0000000000c2" as Uuid,
					id: "client",
					action: "create",
					caseType: "client",
					target: { kind: "new", idFrom: key.uuid },
					name: term(formField(note.uuid)),
				},
			] as CaseOperation[];
		});
		const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		const read = choice("basic-slot-operation-ids-are-derived").apply(doc);
		expect(
			(read.forms[visitForm.uuid]?.caseOperations ?? []).map((operation) => [
				operation.action,
				operation.id,
			]),
		).toEqual([
			["own", "client_2"],
			["create", "client"],
		]);
		expect(expandDoc(read)).toEqual(expandDoc(doc));
		// The reader takes the same member: the block keeps the id it carries.
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		const readForm = Object.values(outcome.draft.doc.forms).find(
			(one) => one.name === "Visit",
		);
		expect(
			(readForm?.caseOperations ?? []).map((operation) => [
				operation.action,
				operation.id,
			]),
		).toEqual([
			["own", "client_2"],
			["create", "client"],
		]);
	});

	it("orders a form's case operations and names its advanced ones as a reading does", async () => {
		// An advanced registration whose own arm and child carry ids no action
		// prints, and whose worker's record stands before the child.
		const { doc, formUuid } = advancedFixture({
			formType: "registration",
			operations: () => [
				{
					uuid: OP("own"),
					id: "own_case",
					action: "own",
					name: readField("name"),
				},
				{
					uuid: OP("worker"),
					id: "worker_record",
					action: "update",
					caseType: "commcare-user",
					target: { kind: "worker-record" },
					writes: [{ property: "last_household", value: readField("name") }],
				} as CaseOperation,
				{
					uuid: OP("kid"),
					id: "kid",
					action: "create",
					caseType: "member",
					target: { kind: "new" },
					name: readField("kid_name"),
					links: [
						{
							identifier: "parent",
							targetType: "household",
							target: { kind: "op", opUuid: OP("own") },
							relationship: "child",
						},
					],
					forEach: { repeat: U("kids") },
				} as CaseOperation,
			],
		});
		const row = choice("case-management-operations-in-reading-order");
		const canonical = READER_CANONICAL_CHOICES.slice(
			0,
			READER_CANONICAL_CHOICES.indexOf(row),
		).reduce((current, one) => one.apply(current), doc);
		const idsOf = (one: BlueprintDoc) =>
			(one.forms[formUuid]?.caseOperations ?? []).map((operation) => [
				operation.action,
				operation.id,
			]);
		const ordered = row.apply(canonical);
		// HQ's actions list the child before the worker's record; the child runs
		// in a repeat and the worker's record at the root, so the reading holds
		// the record first, the order the gate admits (`inWireScopeOrder`).
		expect(idsOf(ordered)).toEqual([
			["own", "household"],
			["update", "commcare_user"],
			["create", "member"],
		]);
		expect(expandDoc(ordered)).toEqual(expandDoc(canonical));
		expect(row.apply(ordered)).toBe(ordered);

		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				resolver: matchingResolver(
					doc.appId,
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		expect(idsOf(outcome.draft.doc)).toEqual(idsOf(ordered));
	});

	it("holds the catalog the reader derives, and every placement the emission derives", () => {
		const doc = produce(caseApp(), (draft) => {
			draft.caseTypes = [
				{
					name: "client",
					properties: [
						{
							name: "note",
							label: {
								parts: [{ kind: "text", text: "A label no export holds" }],
							},
						},
						{
							name: "unread",
							label: { parts: [{ kind: "text", text: "Nothing reads this" }] },
						},
					],
				},
			];
		});
		const catalog = choice("case-catalog-is-as-read").apply(doc);
		sameExport(catalog, doc);
		expect(catalog.caseTypes).toEqual(catalogAsRead(doc));
		expect(
			catalog.caseTypes?.[0]?.properties.map((one) => one.name),
		).not.toContain("unread");
		expect(placementsToHold(doc)).not.toEqual([]);
		const held = choice("unheld-placements-are-held").apply(doc);
		expect(placementsToHold(held)).toEqual([]);
		sameExport(held, doc);
		expect(toPersistableDoc(held)).toEqual(toPersistableDoc(holding(doc)));
	});

	it("reads a translation's provenance as reviewed, and drops an equal or stale one", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Clients",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "a", label: "A" })],
						},
					],
				},
			],
		});
		const menu = doc.moduleOrder[0] as Uuid;
		const form = doc.formOrder[menu]?.[0] as Uuid;
		const menuUnit = makeTranslationUnitId("module", menu, "name");
		const formUnit = makeTranslationUnitId("form", form, "name");
		const appUnit = makeTranslationUnitId("app", "name");
		const localized = produce(doc, (draft) => {
			draft.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra"],
				wireCodes: { eng: "en", fra: "fr" },
				translations: {
					fra: {
						[menuUnit]: {
							value: "Les clients",
							sourceFingerprint: translationSourceFingerprint(
								"text",
								"Clients",
							),
							origin: "ai",
							review: "needs-review",
							translatedFrom: "eng",
						},
						[formUnit]: {
							value: "Visit",
							sourceFingerprint: translationSourceFingerprint("text", "Visit"),
							origin: "human",
							review: "reviewed",
							translatedFrom: "eng",
						},
						[appUnit]: {
							value: "Une app",
							sourceFingerprint: translationSourceFingerprint(
								"text",
								"An older name",
							),
							origin: "human",
							review: "reviewed",
							translatedFrom: "eng",
						},
					},
				},
			} as never;
		});
		for (const id of [
			"translation-equal-to-source-is-absent",
			"translation-provenance-is-read-as-reviewed",
			"out-of-date-translation-is-absent",
		]) {
			const chosen = choice(id).apply(localized);
			expect(chosen.localization).not.toEqual(localized.localization);
			sameExport(chosen, localized);
			expect(choice(id).apply(chosen)).toEqual(chosen);
		}
		const canon = READER_CANONICAL_CHOICES.reduce(
			(current, row) => row.apply(current),
			localized,
		);
		expect(canon.localization?.translations.fra).toEqual({
			[menuUnit]: {
				value: "Les clients",
				sourceFingerprint: translationSourceFingerprint("text", "Clients"),
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			},
		});
	});

	it("reads a label blank in its source as the text a worker reads there, the two printing one source", async () => {
		const survey = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "" })],
						},
					],
				},
			],
		});
		const q = Object.values(survey.fields).find((one) => one.id === "q");
		if (q === undefined) throw new Error("The survey holds a question q.");
		const unit = makeTranslationUnitId("field", q.uuid, "label");
		const blank = produce(survey, (draft) => {
			draft.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra"],
				wireCodes: { eng: "en", fra: "fra" },
				translations: {
					fra: {
						[unit]: {
							value: proseText("Bonjour"),
							sourceFingerprint: translationSourceFingerprint(
								"prose",
								proseText(""),
							),
							origin: "human",
							review: "reviewed",
							translatedFrom: "eng",
						},
					},
				},
			} as never;
		});
		const label = (doc: BlueprintDoc) =>
			(doc.fields[q.uuid] as { label?: unknown }).label;
		const row = choice("blank-itext-takes-the-filled-text");
		const filled = row.apply(blank);
		expect(label(filled)).toEqual(proseText("Bonjour"));
		expect(JSON.stringify(expandDoc(filled))).toBe(
			JSON.stringify(expandDoc(blank)),
		);
		expect(row.apply(filled)).toBe(filled);
		expect(row.apply(survey)).toBe(survey);
		const outcome = readHqApp(
			await inputFor(exportedBody(blank), {
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(blank, DERIVED_WIRE_IDENTITY),
				),
			}),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		expect(label(outcome.draft.doc)).toEqual(label(filled));
	});

	it("puts a required Search message that is Nova's sentence where a reading puts it, the two printing one source", async () => {
		const FIRST = testUuid("assemble-required-first");
		const SECOND = testUuid("assemble-required-second");
		const system = makeTranslationUnitId(
			"system",
			"search-required",
			"default",
		);
		const column = plainColumn(
			testUuid("assemble-required-column"),
			"case_name",
			"Name",
		);
		/** Two required Search fields, `own` holding Nova's English sentence as its own message
		 *  with the Spanish `ownSpanish`, the other none, Nova's message reading `novaSpanish`. */
		const prompts = (
			own: Uuid,
			ownSpanish: string,
			novaSpanish: string,
		): BlueprintDoc => {
			const required = (uuid: Uuid): SearchInputRequired =>
				uuid === own ? { message: SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE } : {};
			const searchInputs = [
				simpleSearchInputDef(FIRST, "name", "Name", "text", "case_name", {
					required: required(FIRST),
				}),
				simpleSearchInputDef(SECOND, "phone", "Phone", "text", "phone", {
					required: required(SECOND),
				}),
			];
			const properties = [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
				{ name: "phone", label: proseText("Phone"), data_type: "text" },
			] as const;
			const doc = buildDoc({
				modules: [
					{
						uuid: testUuid("assemble-required-menu"),
						name: "Patients",
						caseType: "patient",
						caseListConfig: { columns: [column], searchInputs },
						caseSearchConfig: {},
						forms: [
							{
								uuid: testUuid("assemble-required-form"),
								name: "Register",
								type: "registration",
								fields: [
									f({
										uuid: testUuid("assemble-required-name"),
										kind: "text",
										id: "case_name",
										label: "Name",
										caseWrite: { caseType: "patient", property: "case_name" },
									}),
								],
							},
						],
					},
				],
				caseTypes: [{ name: "patient", properties: [...properties] }],
			});
			const units = translationUnitsById(doc);
			const entry = (unitId: TranslationUnitId, value: string) => ({
				value,
				sourceFingerprint: units.get(unitId)?.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			});
			const ownUnit = makeTranslationUnitId(
				"search-input",
				own,
				"required-message",
			);
			return produce(doc, (draft) => {
				draft.localization = {
					sourceLanguage: "eng",
					defaultLanguage: "eng",
					languageOrder: ["eng", "spa"],
					wireCodes: { eng: "en", spa: "es" },
					translations: {
						spa: {
							[ownUnit]: entry(ownUnit, ownSpanish),
							[system]: entry(system, novaSpanish),
						},
					},
				} as never;
			});
		};
		const facts = (doc: BlueprintDoc) => ({
			messages: (
				doc.modules[doc.moduleOrder[0] as Uuid]?.caseListConfig?.searchInputs ??
				[]
			).map((input) =>
				input.kind === "hidden" ? undefined : input.required?.message,
			),
			spanish: Object.fromEntries(
				Object.entries(doc.localization?.translations.spa ?? {}).map(
					([unit, one]) => [unit, one?.value],
				),
			),
		});
		const nova = "Complete esta respuesta antes de buscar.";
		const theirs = "Responda esta pregunta, por favor.";
		// The reading gives Nova's message to the first field whose own text is Nova's sentence.
		const returned = prompts(SECOND, theirs, nova);
		const other = prompts(FIRST, nova, theirs);
		expect(JSON.stringify(expandDoc(other))).toBe(
			JSON.stringify(expandDoc(returned)),
		);
		const row = choice("required-messages-as-read");
		expect(facts(other)).not.toEqual(facts(returned));
		const chosen = row.apply(other);
		expect(facts(chosen)).toEqual(facts(returned));
		expect(JSON.stringify(expandDoc(chosen))).toBe(
			JSON.stringify(expandDoc(other)),
		);
		expect(facts(row.apply(chosen))).toEqual(facts(chosen));
		expect(facts(row.apply(returned))).toEqual(facts(returned));
		const outcome = readHqApp(
			await inputFor(exportedBody(other), {
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(other, DERIVED_WIRE_IDENTITY),
				),
				recordDialect: recordDialectRoundTrip,
			}),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The export did not read.");
		expect(facts(outcome.draft.doc).messages).toEqual(facts(returned).messages);
	});

	it("puts a column a screen does not show last in that screen's order", () => {
		// `caseList/__tests__/columnsOffAScreen.test.ts` holds the pair, its
		// export and its reading.
		expect(choice("columns-off-a-screen-last-in-its-order").apply).toBe(
			columnsOffAScreenLast,
		);
	});

	it("unsets a Connect slot that holds the default an unset one prints", () => {
		// `xform/__tests__/connect.test.ts` holds the pair, its export and its
		// reading.
		expect(choice("connect-defaults-are-unset").apply).toBe(
			connectDefaultsUnset,
		);
	});

	it("drops a settings object that sets nothing beside Search fields, after the default title goes", () => {
		// `search/__tests__/emptySettings.test.ts` holds the pair, its export and
		// its reading.
		const row = choice("empty-search-settings-beside-fields-are-absent");
		expect(row.apply).toBe(emptySearchSettingsBesideFieldsAreAbsent);
		expect(READER_CANONICAL_CHOICES.indexOf(row)).toBeGreaterThan(
			READER_CANONICAL_CHOICES.indexOf(
				choice("default-search-title-is-absent"),
			),
		);
	});

	it("drops a simple Search field's mode where it names the one its widget takes", () => {
		// `search/__tests__/prompts.roundTrip.test.ts` holds the pair widget by
		// widget: both exports, the row a fixed point, and the reading.
		expect(choice("exact-search-mode-is-absent").apply).toBe(
			exactSearchModeIsAbsent,
		);
	});

	it("drops the rule a list with no rule writes, numbers the rules as a reading does, and reads a tile column shown nowhere as a reading gives it", () => {
		// `caseList/__tests__/listCanon.test.ts` and `canon.test.ts` hold each
		// pair, its export and its reading. Each reads the rules where the row
		// before it puts them.
		const implicit = choice("implicit-order-rule-is-absent");
		const priorities = choice("order-priorities-as-read");
		const tile = choice("tile-columns-shown-nowhere-are-as-read");
		expect(implicit.apply).toBe(implicitOrderRuleIsAbsent);
		expect(priorities.apply).toBe(orderPrioritiesAsRead);
		expect(tile.apply).toBe(tileColumnsShownNowhereAsRead);
		const landing = READER_CANONICAL_CHOICES.indexOf(
			choice("order-rules-on-the-columns-they-land-on"),
		);
		expect(READER_CANONICAL_CHOICES.indexOf(implicit)).toBe(landing + 1);
		expect(READER_CANONICAL_CHOICES.indexOf(priorities)).toBe(landing + 2);
		expect(READER_CANONICAL_CHOICES.indexOf(tile)).toBe(landing + 3);
	});

	it("gives a menu that lists no cases its one name column, before the detail is ordered", () => {
		// `caseList/__tests__/listCanon.test.ts` holds the pair, its export and its
		// reading.
		const row = choice(
			"columns-of-a-menu-that-lists-no-cases-are-its-one-name-column",
		);
		expect(row.apply).toBe(columnsOfAMenuThatListsNoCases);
		expect(READER_CANONICAL_CHOICES.indexOf(row)).toBe(
			READER_CANONICAL_CHOICES.indexOf(
				choice("columns-off-a-screen-last-in-its-order"),
			) - 1,
		);
	});

	it("drops a hint, a validation message and a help text blank in every language", () => {
		// `xform/__tests__/blankOptionalText.test.ts` holds the pair, its export
		// and its reading.
		expect(choice("blank-optional-text-is-absent").apply).toBe(
			blankOptionalTextAbsent,
		);
	});

	it("drops a validation message no condition can show, which no export carries", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "note",
									label: "Note",
									validate_msg: proseText("Never shown"),
								}),
								f({
									kind: "int",
									id: "count",
									label: "Count",
									validate: ". > 0",
									validate_msg: proseText("Count one or more"),
								}),
							],
						},
					],
				},
			],
		});
		const row = choice("validation-message-with-no-condition-is-absent");
		const chosen = row.apply(doc);
		const message = (one: BlueprintDoc, id: string) =>
			(
				Object.values(one.fields).find((field) => field.id === id) as {
					validate_msg?: unknown;
				}
			).validate_msg;
		expect(message(doc, "note")).toBeDefined();
		expect(message(chosen, "note")).toBeUndefined();
		expect(message(chosen, "count")).toEqual(message(doc, "count"));
		sameExport(chosen, doc);
		expect(row.apply(chosen)).toEqual(chosen);
	});

	it("sources a document whose export tells no language apart in its first language, the two printing one source", async () => {
		/* English source, Spanish first: the app's name is untranslated and the app prints none
		 * of Nova's sentences, so no byte of the export says which language is the source. */
		const doc = localizationWireFixture("optional");
		const row = choice("source-language-is-as-read");
		const chosen = row.apply(doc);
		expect(doc.localization?.languageOrder).toEqual(["spa", "eng"]);
		expect(doc.localization?.sourceLanguage).toBe("eng");
		expect(chosen.localization?.sourceLanguage).toBe("spa");
		sameExport(chosen, doc);
		expect(row.apply(chosen)).toEqual(chosen);
		expect((await readExport(doc)).localization?.sourceLanguage).toBe("spa");
	});

	it("keeps the source of a document whose export tells it, through the row and a whole reading", async () => {
		/* English source, Spanish first, the app's name translated: the export writes the
		 * English name as `name` and the Spanish one as Spanish `app.display.name`, which the
		 * same document sourced in Spanish writes the other way round. */
		const doc = localizationWireFixture("bilingual");
		const resourced = resourcedDocument(doc, "spa");
		expect(JSON.stringify(expandDoc(resourced))).not.toBe(
			JSON.stringify(expandDoc(doc)),
		);
		const row = choice("source-language-is-as-read");
		expect(row.apply(doc)).toBe(doc);
		expect(
			READER_CANONICAL_CHOICES.reduce((one, each) => each.apply(one), doc)
				.localization?.sourceLanguage,
		).toBe("eng");
		const read = await readExport(doc);
		expect(read.localization?.sourceLanguage).toBe("eng");
		expect(read.appName).toBe(doc.appName);
		expect(row.apply(resourced)).toBe(resourced);
		expect((await readExport(resourced)).localization?.sourceLanguage).toBe(
			"spa",
		);
	});

	it("puts a registration offered after an empty search last, the two printing one source", () => {
		const register = {
			uuid: "assemble-after-empty-register",
			name: "Register",
			type: "registration" as const,
			fields: [
				f({
					kind: "text",
					id: "name",
					caseWrite: { caseType: "patient", property: "case_name" },
				}),
			],
		};
		const visit = {
			name: "Visit",
			type: "followup" as const,
			fields: [
				f({
					kind: "text",
					id: "notes",
					caseWrite: { caseType: "patient", property: "notes" },
				}),
			],
		};
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					caseSearchConfig: { formsReadSearch: true },
					caseListRegistrationForm: { formUuid: register.uuid },
					forms: [register, visit],
				},
			],
		});
		const row = choice("registration-form-last");
		const chosen = row.apply(doc);
		const names = (one: BlueprintDoc) =>
			(one.formOrder[one.moduleOrder[0] as Uuid] ?? []).map(
				(form) => one.forms[form]?.name,
			);
		expect(names(doc)).toEqual(["Register", "Visit"]);
		expect(names(chosen)).toEqual(["Visit", "Register"]);
		sameExport(chosen, doc);
		expect(row.apply(chosen)).toEqual(chosen);
	});

	it("drops an after-submit that is the form's own default, the two printing one source", () => {
		const doc = produce(caseApp(), (draft) => {
			const visit = Object.values(draft.forms).find(
				(one) => one.name === "Visit",
			);
			if (visit === undefined) throw new Error("The app has no Visit form.");
			visit.postSubmit = "previous";
		});
		const row = choice("default-post-submit-is-absent");
		const chosen = row.apply(doc);
		expect(
			Object.values(chosen.forms).find((one) => one.name === "Visit"),
		).not.toHaveProperty("postSubmit");
		sameExport(chosen, doc);
		expect(row.apply(chosen)).toEqual(chosen);
	});

	it("reads an advanced Search field whose condition is a simple field's derivation as that field, the two printing one source", () => {
		const field: SearchInputDef = {
			uuid: uuid(9),
			name: "number",
			label: "Number",
			kind: "advanced",
			type: "text",
			predicate: whenInput(
				input(uuid(9)),
				eq(prop("patient", "phone"), input(uuid(9))),
			),
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
		});
		const row = choice("derived-search-conditions-are-simple-fields");
		const chosen = row.apply(doc);
		expect(
			chosen.modules[chosen.moduleOrder[0] as Uuid]?.caseListConfig
				?.searchInputs[0],
		).toMatchObject({ kind: "simple", property: "phone" });
		sameExport(chosen, doc);
		expect(row.apply(chosen)).toEqual(chosen);
	});

	it("drops a write's untyped step to the case above for the type it reaches, the two printing one source", () => {
		const VISIT = testUuid("assemble-via-visit");
		const SIZE = testUuid("assemble-via-size");
		const doc = buildDoc(
			{
				caseTypes: [
					{
						name: "household",
						properties: [{ name: "size", label: "Size", data_type: "int" }],
					},
					{ name: "member", parent_type: "household", properties: [] },
				],
				modules: [
					{
						uuid: "assemble-via-households",
						name: "Households",
						caseType: "household",
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
								],
							},
						],
					},
					{
						name: "Members",
						caseType: "member",
						parentCaseModuleUuid: "assemble-via-households",
						forms: [
							{
								uuid: "assemble-via-visit",
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "int", id: "size", uuid: SIZE })],
							},
						],
					},
				],
			},
			(built) => {
				built.forms[VISIT] = {
					...built.forms[VISIT],
					caseOperations: [
						{
							uuid: testUuid("assemble-via-own"),
							id: "member",
							action: "own",
							writes: [
								{
									property: "size",
									value: term(formField(SIZE)),
									via: [{ identifier: "parent" }],
								},
							],
						} as CaseOperation,
					],
				} as never;
			},
		);
		const via = (one: BlueprintDoc) =>
			one.forms[VISIT]?.caseOperations?.[0]?.writes?.[0]?.via;
		const row = choice("write-via-steps-are-typed");
		const chosen = row.apply(doc);
		expect(via(doc)).toEqual([{ identifier: "parent" }]);
		expect(via(chosen)).toEqual([
			{ identifier: "parent", throughCaseType: "household" },
		]);
		sameExport(chosen, doc);
		expect(row.apply(chosen)).toEqual(chosen);
	});

	it("drops the tile cell of a list with no tile and of a column hidden from Results in a tile list, the two printing one source", () => {
		const columns = [
			plainColumn(uuid(1), "case_name", "Name", {
				tile: tileCell(0, 0, 12, 1),
			}),
			plainColumn(uuid(2), "notes", "Notes", {
				visibleInList: false,
				tile: tileCell(0, 1, 12, 1),
			}),
		];
		const row = choice("dormant-tile-cells");
		const cells = (one: BlueprintDoc) =>
			(
				one.modules[one.moduleOrder[0] as Uuid]?.caseListConfig?.columns ?? []
			).map((column) => column.tile !== undefined);
		const tiled = patients(columns, { list: { tile: {} } });
		const untiled = patients(columns);
		for (const [doc, want] of [
			[tiled, [true, false]],
			[untiled, [false, false]],
		] as const) {
			const chosen = row.apply(doc);
			expect(cells(doc)).toEqual([true, true]);
			expect(cells(chosen)).toEqual(want);
			sameExport(chosen, doc);
			expect(row.apply(chosen)).toEqual(chosen);
		}
	});

	it("takes an unsorted tile column hidden from Results off the list, the two printing one source, and leaves a sorted or untiled one", async () => {
		const listed = (tiled: boolean) =>
			patients(
				[
					plainColumn(
						uuid(1),
						"case_name",
						"Name",
						tiled ? { tile: tileCell(0, 0, 12, 1) } : {},
					),
					plainColumn(uuid(2), "notes", "Notes", { visibleInList: false }),
					plainColumn(uuid(4), "phone", "Phone", {
						visibleInList: false,
						sort: columnSort("asc", 0),
					}),
				],
				tiled ? { list: { tile: {} } } : {},
			);
		const list = (one: BlueprintDoc): CaseListConfig => {
			const config = one.modules[one.moduleOrder[0] as Uuid]?.caseListConfig;
			if (config === undefined) throw new Error("The menu holds no list.");
			return config;
		};
		const offTheList = (one: BlueprintDoc) =>
			Object.fromEntries(
				list(one).columns.map((column) => [
					"field" in column ? column.field : column.uuid,
					column.notOnList === true,
				]),
			);
		const row = choice("unsorted-hidden-tile-columns-are-off-the-list");
		const tiled = listed(true);
		const chosen = row.apply(tiled);
		expect(offTheList(tiled)).toEqual({
			case_name: false,
			notes: false,
			phone: false,
		});
		expect(offTheList(chosen)).toEqual({
			case_name: false,
			notes: true,
			phone: false,
		});
		sameExport(chosen, tiled);
		expect(row.apply(chosen)).toEqual(chosen);
		// A column a list with no tile hides from Results is still a field of the list.
		const untiled = listed(false);
		expect(row.apply(untiled)).toEqual(untiled);
		// The reader takes the same member: the column a tile list leaves unsorted is off the list.
		expect(offTheList(await readExport(tiled))).toEqual(offTheList(chosen));
	});

	it("drops a menu's and a form's purpose note, which no export carries", async () => {
		const doc = produce(caseApp(), (draft) => {
			for (const module of Object.values(draft.modules))
				module.purpose = "Follow each client";
			for (const form of Object.values(draft.forms)) form.purpose = "Why";
		});
		const row = choice("purpose-notes-are-absent");
		expect(row.kind).toBe("not-carried");
		const chosen = row.apply(doc);
		sameExport(chosen, doc);
		const purposes = (one: BlueprintDoc) =>
			[...Object.values(one.modules), ...Object.values(one.forms)].map(
				(entity) => entity.purpose,
			);
		expect(purposes(chosen).every((one) => one === undefined)).toBe(true);
		expect(purposes(await readExport(doc))).toEqual(purposes(chosen));
	});

	it("drops the app's logo, which a publish never writes", async () => {
		const doc = produce(caseApp(), (draft) => {
			draft.logo = "33333333-3333-4333-8333-333333333333" as never;
		});
		const chosen = choice("app-logo-is-absent").apply(doc);
		expect(chosen.logo).toBeUndefined();
		sameExport(chosen, doc);
		expect((await readExport(doc)).logo).toBeUndefined();
	});

	it("gives each menu and form the id a reading mints from its name", async () => {
		const survey = (name: string, id: string) => ({
			name,
			type: "survey" as const,
			fields: [f({ kind: "text", id, label: id })],
		});
		const doc = produce(
			buildDoc({
				modules: [
					{
						name: "Patients & visits",
						forms: [survey("Visit", "a"), survey("Visit", "b")],
					},
					{
						name: "Clinic follow-up",
						forms: [survey("Clinic follow-up", "c")],
					},
				],
			}),
			(draft) => {
				for (const module of Object.values(draft.modules))
					module.id = `menu-${module.name.length}`;
				for (const form of Object.values(draft.forms))
					form.id = `form-${form.uuid.slice(0, 4)}`;
			},
		);
		const row = choice("menu-and-form-ids-as-read");
		const chosen = row.apply(doc);
		const ids = (one: BlueprintDoc) => ({
			menus: one.moduleOrder.map((uuid) => one.modules[uuid]?.id),
			forms: one.moduleOrder.flatMap((uuid) =>
				(one.formOrder[uuid] ?? []).map((form) => one.forms[form]?.id),
			),
		});
		expect(ids(chosen)).toEqual({
			menus: ["patients_visits", "clinic_follow_up"],
			forms: ["visit", "visit_2", "clinic_follow_up"],
		});
		expect(row.apply(chosen)).toBe(chosen);
		sameExport(chosen, doc);
		expect(ids(await readExport(doc))).toEqual(ids(chosen));
	});

	it("holds each worker and location property the logic reads as a reading mints it, and none it does not read", async () => {
		const REGION = testUuid("assemble-world-region");
		const UNUSED = testUuid("assemble-world-unused");
		const doc = produce(
			buildDoc({
				modules: [
					{
						name: "Workers",
						forms: [
							{
								name: "Check",
								type: "survey",
								fields: [
									f({ kind: "hidden", id: "role", calculate: "#user/role" }),
									f({ kind: "text", id: "note", label: "Note" }),
								],
							},
						],
					},
				],
			}),
			(draft) => {
				draft.userProperties = {
					[UNUSED]: { uuid: UNUSED, slug: "unused", label: "Unused" },
					[REGION]: {
						uuid: REGION,
						slug: "region",
						label: "Region",
						required: true,
					},
				} as never;
				draft.userPropertyOrder = [UNUSED, REGION];
				const beds = testUuid("assemble-world-beds");
				draft.locationProperties = {
					[beds]: { uuid: beds, slug: "beds", label: "Beds" },
				} as never;
				draft.locationPropertyOrder = [beds];
				const note = Object.values(draft.fields).find(
					(one) => one.id === "note",
				);
				if (note?.kind === "text")
					note.relevant = eq(
						{ ...sessionUserProperty(REGION), source: "worker-record" },
						literal("north"),
					) as never;
			},
		);
		const named = choice("worker-fields-read-by-name-are-properties");
		const world = choice("world-properties-as-read");
		const minted = named.apply(doc);
		sameExport(minted, doc);
		const chosen = world.apply(minted);
		sameExport(chosen, doc);
		const role = mintEntityUuid(doc.appId, externalKey.userProperty("role"));
		const properties = (one: BlueprintDoc) =>
			(one.userPropertyOrder ?? []).map((uuid) => one.userProperties?.[uuid]);
		expect(properties(chosen)).toEqual([
			{ uuid: REGION, slug: "region", label: "region" },
			{ uuid: role, slug: "role", label: "role" },
		]);
		expect(chosen.locationProperties).toBeUndefined();
		expect(world.apply(named.apply(chosen))).toBe(chosen);
		const read = await readExport(doc);
		expect(properties(read)).toEqual(properties(chosen));
		expect(read.locationProperties).toBeUndefined();
	});

	it("reads the organization's levels as CommCare HQ's list gives them", async () => {
		const DISTRICT = testUuid("assemble-level-district");
		const CLINIC = testUuid("assemble-level-clinic");
		const doc = produce(caseApp(), (draft) => {
			draft.organizationLevels = {
				[CLINIC]: {
					uuid: CLINIC,
					code: "clinic",
					name: "Clinic",
					description: "Where workers sit",
					parentLevelUuid: DISTRICT,
					caseFlow: {
						workers: "assigned",
						ownsCases: true,
						descendantCases: { kind: "none" },
					},
					addressBook: { reach: "own-branch" },
				},
				[DISTRICT]: {
					uuid: DISTRICT,
					code: "district",
					name: "District",
					caseFlow: { workers: "none", ownsCases: false },
					addressBook: { reach: "own-branch" },
				},
			} as never;
			draft.organizationLevelOrder = [CLINIC, DISTRICT];
		});
		const row = choice("organization-levels-as-read");
		const chosen = row.apply(doc);
		sameExport(chosen, doc);
		const levels = (one: BlueprintDoc) =>
			(one.organizationLevelOrder ?? []).map(
				(uuid) => one.organizationLevels?.[uuid],
			);
		const district = {
			uuid: DISTRICT,
			code: "district",
			name: "District",
			// HQ's list gives each level's administrative flag, the inverse
			// of stock tracking; a level Nova sends is administrative.
			tracksStock: false,
			caseFlow: {
				workers: "assigned",
				ownsCases: false,
				descendantCases: { kind: "none" },
			},
			addressBook: { reach: "own-branch" },
		};
		expect(levels(chosen)).toEqual([
			district,
			{
				...district,
				uuid: CLINIC,
				code: "clinic",
				name: "Clinic",
				parentLevelUuid: DISTRICT,
				caseFlow: { ...district.caseFlow, ownsCases: true },
			},
		]);
		expect(row.apply(chosen)).toBe(chosen);
		expect(levels(await readExport(doc))).toEqual(levels(chosen));
	});
});

describe("a date and time question Nova split", () => {
	it("reads back as its three questions, the join a Hidden Value bound as a date and time", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [f({ kind: "datetime", id: "seen", label: "Seen" })],
						},
					],
				},
			],
		});
		const plan = planDatetimeSplits(structuredClone(doc));
		if (!plan.ok) throw new Error("The question splits.");
		const split = produce(doc, (draft) => {
			applyMutations(draft, plan.mutations);
		});
		const outcome = readHqApp(await inputFor(exportedBody(split)), {
			claims: "full",
		});
		if (outcome.kind !== "read")
			throw new Error(
				JSON.stringify(
					outcome.findings.map((one) => [one.code, one.detail.name]),
				),
			);
		const read = outcome.draft.doc.fields;
		const kinds = (fields: BlueprintDoc["fields"]) =>
			Object.values(fields)
				.map((field) => `${field.id}:${field.kind}`)
				.sort();
		expect(
			kinds(split.fields)
				.map((one) => one.split(":")[1])
				.sort(),
		).toEqual(["date", "hidden", "time"]);
		expect(kinds(read)).toEqual(kinds(split.fields));
	});
});
