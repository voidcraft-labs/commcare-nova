/**
 * The last stage of a reading and the reader's canonical choices.
 *
 * Contract: over drafts the stages built from an export, where no finding
 * stands, the draft's document parses whole and its batch, applied to the
 * empty document, rebuilds it, with every held placement in one trailing
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
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { planDatetimeSplits } from "@/lib/doc/datetimeSplit";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	translationSourceFingerprint,
	type Uuid,
} from "@/lib/domain";
import { PLATFORM_FEATURE_FIXTURES } from "@/lib/domain/__tests__/platformFeatureFixtures";
import { caseOperationFixture } from "../../__tests__/caseOperationFixture";
import { expandDoc } from "../../expander";
import { placementsToHold } from "../../placementHolds";
import { assembleDocument, READER_CANONICAL_CHOICES } from "../assemble";
import { catalogAsRead } from "../caseManagement/catalog";
import type { ReadContext } from "../context";
import { readHqApp, STAGES } from "../index";
import type { AppStringTable } from "../types";
import { X } from "../xform/claims";
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
		const rebuilt = produce(emptyBlueprintDoc(ctx.input.appId), (empty) => {
			applyMutations(empty, draft.batch);
		});
		expect(toPersistableDoc(rebuilt)).toEqual(toPersistableDoc(draft.doc));
		const holds = draft.batch.filter(
			(mutation) => mutation.kind === "holdPlacements",
		);
		expect(holds).toHaveLength(1);
		expect(draft.batch.at(-1)?.kind).toBe("holdPlacements");
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
	it("folds into the text it overrides, once, and is counted", async () => {
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
			"application-and-settings/translations-generated-key-over-one-text",
		]);
		if (outcome.kind !== "read")
			throw new Error(
				JSON.stringify(outcome.findings.map((one) => one.detail.name)),
			);
		expect(outcome.draft.facts.foldedTranslationKeys).toBe(1);
		const menu = outcome.draft.doc.moduleOrder[0] as Uuid;
		expect(outcome.draft.doc.modules[menu]?.name).toBe("Patients");
	});

	it("writes two keys of one unit in another language as one translation, and counts both", async () => {
		const doc = produce(caseApp(), (draft) => {
			draft.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra"],
				wireCodes: { eng: "en", fra: "fra" },
				translations: { fra: {} },
			} as never;
		});
		const shell = retainedSourceBody("shell/app-source");
		const body = exportedBody(doc, {
			root: {
				langs: ["en", "fra"],
				translations: {
					...(shell.translations as Record<string, unknown>),
					fra: {
						"modules.m0": "Les clients",
						"case_lists.m0": "Les clients",
					},
				},
			},
		});
		/* Nova's build spells the menu's name under both ids, in each language, from one unit. */
		const strings = (read: BlueprintDoc): AppStringTable => {
			const menu = read.moduleOrder[0] as Uuid;
			const unit = makeTranslationUnitId("module", menu, "name");
			const name = read.modules[menu]?.name ?? "";
			const translated = read.localization?.translations.fra?.[unit]?.value;
			const fra = typeof translated === "string" ? translated : name;
			return {
				languages: {
					en: { "modules.m0": name, "case_lists.m0": name },
					fra: { "modules.m0": fra, "case_lists.m0": fra },
				},
				units: { "modules.m0": unit, "case_lists.m0": unit },
			};
		};
		const outcome = readHqApp(
			{ ...(await inputFor(body)), appStrings: strings },
			{ claims: "full" },
		);
		if (outcome.kind !== "read")
			throw new Error(
				JSON.stringify(outcome.findings.map((one) => one.detail.name)),
			);
		const records = [...outcome.claims.records()].filter((record) =>
			record.entry.includes("translations-generated-key"),
		);
		expect(records.map((record) => record.entry)).toEqual([
			"application-and-settings/translations-generated-key-over-one-text",
			"application-and-settings/translations-generated-key-over-one-text",
		]);
		expect(outcome.draft.facts.foldedTranslationKeys).toBe(2);
		const read = outcome.draft.doc;
		const menu = read.moduleOrder[0] as Uuid;
		expect(read.modules[menu]?.name).toBe("Clients");
		expect(
			read.localization?.translations.fra?.[
				makeTranslationUnitId("module", menu, "name")
			],
		).toMatchObject({
			value: "Les clients",
			sourceFingerprint: translationSourceFingerprint("text", "Clients"),
		});
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
		const sections = choice("root-question-lists-are-sections").apply(lists);
		expect(
			Object.values(sections.fields).find((one) => one.id === "one")?.kind,
		).toBe("section");
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
		const fields = Object.values(
			choice("plain-flag-on-blank-text-is-absent").apply(
				choice("blank-container-label-is-absent").apply(doc),
			).fields,
		) as unknown as Record<string, unknown>[];
		expect(fields.find((one) => one.id === "g")).not.toHaveProperty("label");
		expect(fields.find((one) => one.id === "b")).not.toHaveProperty(
			"plainHelp",
		);
	});

	it("keeps a plain flag on a blank text that carries media, a choice's alike, and drops one on a blank choice with none", () => {
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
				const [withMedia, without] = pick.optionsSource.options;
				Object.assign(withMedia ?? {}, {
					label: { parts: [] },
					media: { image },
					plainLabel: true,
				});
				Object.assign(without ?? {}, {
					label: { parts: [] },
					plainLabel: true,
				});
			},
		);
		const read = choice("plain-flag-on-blank-text-is-absent").apply(doc);
		const pick = Object.values(read.fields).find(
			(one) => one.id === "pick",
		) as unknown as {
			plainLabel?: true;
			optionsSource: { options: { plainLabel?: true }[] };
		};
		expect(pick.plainLabel).toBe(true);
		expect(pick.optionsSource.options.map((one) => one.plainLabel)).toEqual([
			true,
			undefined,
		]);
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
		const name = Object.values(read.fields).find(
			(one) => one.id === "case_name",
		);
		expect(name).not.toHaveProperty("required");
		const note = Object.values(read.fields).find((one) => one.id === "note");
		expect(note).toEqual(
			Object.values(doc.fields).find((one) => one.id === "note"),
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
		expect(catalog.caseTypes).toEqual(catalogAsRead(doc));
		expect(
			catalog.caseTypes?.[0]?.properties.map((one) => one.name),
		).not.toContain("unread");
		expect(placementsToHold(doc)).not.toEqual([]);
		const held = choice("unheld-placements-are-held").apply(doc);
		expect(placementsToHold(held)).toEqual([]);
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
