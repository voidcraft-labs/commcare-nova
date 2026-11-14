/**
 * The last stage of a reading and the reader's canonical choices.
 *
 * Contract: where no finding stands, the draft's document parses whole and
 * its batch, applied to the empty document, rebuilds it, with every held
 * placement in one trailing `holdPlacements`; a document the schema refuses
 * gives no draft and the defect `assembly`; content no platform runs whole is
 * `no-platform-runs-everything` at each use, alone and beside another finding;
 * a generated translation key folds into its text once and is counted, and
 * none is ever `unrecognized`. Each canonical choice rewrites one member of its
 * pair into the other and leaves a document outside the pair as it was.
 *
 * Plausible failures: a batch that rebuilds another document, a fold counted
 * twice or never reaching the document, a refused document returned, a
 * declaration verdict silenced by another finding.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
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
import { placementsToHold } from "../../placementHolds";
import { assembleDocument, READER_CANONICAL_CHOICES } from "../assemble";
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

/** `doc` as the reading of the bare shell would hold it: its app id, frozen. */
function asRead(doc: BlueprintDoc): BlueprintDoc {
	return Object.freeze({ ...doc, appId: "app-1" }) as BlueprintDoc;
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
		const ctx = await beforeAssembly(retainedSourceBody("shell/app-source"));
		const doc = asRead(holding(caseApp()));
		ctx.doc = doc;
		assembleDocument(ctx);
		const draft = ctx.assembled;
		if (draft === undefined)
			throw new Error(JSON.stringify(ctx.close().findings));
		const rebuilt = produce(emptyBlueprintDoc("app-1"), (empty) => {
			applyMutations(empty, draft.batch);
		});
		expect(toPersistableDoc(rebuilt)).toEqual(toPersistableDoc(draft.doc));
		const holds = draft.batch.filter(
			(mutation) => mutation.kind === "holdPlacements",
		);
		expect(holds).toHaveLength(1);
		expect(draft.batch.at(-1)?.kind).toBe("holdPlacements");
		expect(draft.declaration.kind).toBe("choices");
	});

	it("gives no draft for a document the schema refuses, and says so", async () => {
		const ctx = await beforeAssembly(retainedSourceBody("shell/app-source"));
		const doc = caseApp();
		const question = Object.keys(doc.fields)[0] as Uuid;
		ctx.doc = asRead(
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
		const neither = asRead(
			produce(PLATFORM_FEATURE_FIXTURES["case-list-here"].with(), (draft) => {
				delete draft.appSettings.runsOnlyOn;
				for (const module of Object.values(draft.modules))
					module.caseSearchConfig = { formsReadSearch: true };
			}),
		);
		for (const other of [false, true]) {
			const ctx = await beforeAssembly(retainedSourceBody("shell/app-source"));
			if (other) ctx.accounting.finding(X.loadOrder, { kind: "app" });
			ctx.doc = neither;
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
		const read =
			outcome.kind === "read"
				? Object.values(outcome.draft.doc.fields)
				: undefined;
		const findings = outcome.kind === "account" ? outcome.findings : [];
		expect(
			findings.filter(
				(finding) =>
					finding.code ===
					"questions/hidden-value-bound-a-type-nova-would-not-write",
			),
		).toEqual([]);
		const kinds = Object.values(split.fields).map((field) => field.kind);
		expect(kinds.sort()).toEqual(["date", "hidden", "time"]);
		if (read !== undefined)
			expect(read.map((field) => field.kind).sort()).toEqual(kinds.sort());
	});
});
