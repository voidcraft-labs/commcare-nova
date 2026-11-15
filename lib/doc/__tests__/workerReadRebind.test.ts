/**
 * Declaring worker information under a name the app already reads.
 *
 * Contract (`userMutations.ts::addUserPropertyMutations`,
 * `updateUserPropertyMutations`): a read of the worker's record by a name no
 * worker information holds stands; once worker information takes that name,
 * the gate refuses a read of it by name (`worker-property-read-by-name`). So
 * the add, or the rename to that name, rebinds every such read to the
 * information's identity in the same batch, in a field's conditions, values,
 * text and choice wording, a current translation of that text, and a form's
 * close condition, and the gate admits the batch. The rebound reads are then
 * the information's references: a later rename keeps them, and a removal is
 * refused while they stand. The builder's command owner and its undo carry the
 * same batch, and its worker-language lens, which turns an edit of wording
 * into a translation, leaves a rebind in the source text, since a rebind
 * changes no wording.
 */

import { produce } from "immer";
import { afterEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	withUserSequences,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { createBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	addLanguageMutation,
	heldLanguageWireCodes,
} from "@/lib/doc/languageMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import {
	addUserPropertyMutations,
	removeUserPropertyPlan,
	updateUserPropertyMutations,
} from "@/lib/doc/userMutations";
import {
	type BlueprintDoc,
	collectTranslationUnits,
	type ProseTemplate,
	proseText,
	type TranslationEntry,
} from "@/lib/domain";
import { eq, literal, term } from "@/lib/domain/expression/builders";
import type { SessionUserRef } from "@/lib/domain/expression/types";
import { toastStore } from "@/lib/ui/toastStore";
import { assertAdmittedDoc } from "./admittedDoc";

const SURVEY_MODULE = testUuid("rebind-survey-module");
const SURVEY_FORM = testUuid("rebind-survey-form");
const CASE_MODULE = testUuid("rebind-case-module");
const CLOSE_FORM = testUuid("rebind-close-form");
const QUESTION = testUuid("rebind-question");
const HIDDEN = testUuid("rebind-hidden");
const SELECT = testUuid("rebind-select");
const OPTION = testUuid("rebind-option");
const REGION = testUuid("rebind-region");
const DISTRICT = testUuid("rebind-district");

const fromRecord = (field: string): SessionUserRef => ({
	kind: "session-user",
	field,
	source: "worker-record",
});

function regionLabel(words: string): ProseTemplate {
	return {
		parts: [
			{ kind: "text", text: `${words} ` },
			{ kind: "user-ref", property: "region" },
			{ kind: "text", text: " · " },
			{
				kind: "value",
				expression: eq(term(fromRecord("region")), literal("north")),
			},
		],
	};
}

/** An app that reads the worker's `region` by name from the worker's record,
 *  with no worker information of that name, and holds a current Spanish
 *  translation of the question's label. `district` is declared when asked. */
function fixture(options: { declareDistrict?: boolean } = {}): BlueprintDoc {
	const doc = buildDoc({
		appId: "rebind-app",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: SURVEY_MODULE,
				name: "Visits",
				forms: [
					{
						uuid: SURVEY_FORM,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: QUESTION,
								kind: "text",
								id: "notes",
								label: regionLabel("Region"),
								relevant: eq(term(fromRecord("region")), literal("north")),
							}),
							f({
								uuid: HIDDEN,
								kind: "hidden",
								id: "region_copy",
								calculate: term(fromRecord("region")),
							}),
							f({
								uuid: SELECT,
								kind: "single_select",
								id: "agree",
								options: [
									{ uuid: OPTION, value: "yes", label: regionLabel("Yes in") },
								],
							}),
						],
					},
				],
			},
			{
				uuid: CASE_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: CLOSE_FORM,
						name: "Discharge",
						type: "close",
						closeCondition: eq(term(fromRecord("region")), literal("north")),
						fields: [f({ kind: "text", id: "reason" })],
					},
				],
			},
		],
	});
	const withSpanish = produce(doc, (draft) => {
		applyMutations(draft, [
			addLanguageMutation(heldLanguageWireCodes(draft), { language: "spa" }),
		]);
	});
	const unit = labelUnit(withSpanish);
	const entry: TranslationEntry = {
		value: regionLabel("Región"),
		sourceFingerprint: unit.sourceFingerprint,
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
	};
	const translated = produce(withSpanish, (draft) => {
		applyMutations(draft, [
			{ kind: "setTranslation", language: "spa", unitId: unit.id, entry },
		]);
	});
	const result = options.declareDistrict
		? withUserSequences({
				...translated,
				userProperties: {
					[DISTRICT]: { uuid: DISTRICT, slug: "district", label: "District" },
				},
			})
		: translated;
	assertAdmittedDoc(result);
	return result;
}

function labelUnit(doc: BlueprintDoc) {
	const unit = collectTranslationUnits(doc).find(
		(candidate) =>
			candidate.owner.kind === "field" &&
			candidate.owner.fieldUuid === QUESTION &&
			candidate.role === "field-label",
	);
	if (unit === undefined) throw new Error("Expected the label's unit.");
	return unit;
}

/** Every worker read the document stores: `name:` for one by name, `id:` for
 *  one by identity. */
function workerReads(doc: BlueprintDoc): string[] {
	const reads: string[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const node = value as Record<string, unknown>;
		if (node.kind === "session-user") reads.push(`name:${node.field}`);
		if (node.kind === "user-ref") reads.push(`name:${node.property}`);
		if (node.kind === "session-user-property")
			reads.push(`id:${node.userPropertyUuid}`);
		if (node.kind === "user-property-ref")
			reads.push(`id:${node.userPropertyUuid}`);
		for (const [key, child] of Object.entries(node))
			if (key !== "refIndex") visit(child);
	};
	visit({
		modules: doc.modules,
		forms: doc.forms,
		fields: doc.fields,
		localization: doc.localization,
	});
	return [...new Set(reads)].sort();
}

function commit(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	if (!verdict.ok) throw new Error("Expected the batch to commit.");
	return verdict.nextDoc;
}

function printedRelevant(doc: BlueprintDoc): string {
	const field = doc.fields[QUESTION];
	if (field === undefined || !("relevant" in field) || !field.relevant)
		throw new Error("Expected the question's condition.");
	const printed = projectFormExpression(
		doc,
		{ entity: "field", uuid: QUESTION, slot: "relevant" },
		field.relevant,
		new Map(),
	);
	expect(printed.unresolved).toEqual([]);
	return printed.text;
}

afterEach(() => toastStore.clear());

describe("declaring worker information a read already names", () => {
	it("is refused without the rebind: the gate meets a read by name of a declared slug", () => {
		const doc = fixture();
		const verdict = mutationCommitVerdict(
			doc,
			[
				{
					kind: "addUserProperty",
					property: { uuid: REGION, slug: "region", label: "Region" },
					after: null,
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
	});

	it("rebinds every read of the name to the new information in the add's batch", () => {
		const doc = fixture();
		const labelBefore = labelUnit(doc);
		const printedBefore = printedRelevant(doc);

		const next = commit(
			doc,
			addUserPropertyMutations(doc, REGION, {
				slug: "region",
				label: "Region",
			}),
		);

		expect(workerReads(doc)).toEqual(["name:region"]);
		expect(workerReads(next)).toEqual([`id:${REGION}`]);
		expect(next.forms[CLOSE_FORM]?.closeCondition).toEqual(
			eq(
				term({
					kind: "session-user-property",
					userPropertyUuid: REGION,
					source: "worker-record",
				}),
				literal("north"),
			),
		);
		// The read prints the path it printed before.
		expect(printedRelevant(next)).toBe(printedBefore);
		// The Spanish label was current, so it is rewritten with its source and
		// stays current.
		const labelAfter = labelUnit(next);
		expect(labelAfter.sourceFingerprint).not.toBe(
			labelBefore.sourceFingerprint,
		);
		expect(
			next.localization?.translations.spa?.[labelAfter.id]?.sourceFingerprint,
		).toBe(labelAfter.sourceFingerprint);

		// The reads are now the information's: its removal is refused.
		const removal = removeUserPropertyPlan(next, REGION);
		expect(removal.ok).toBe(false);
	});

	it("rebinds the reads of a slug that worker information is renamed to, and a later rename keeps them", () => {
		const doc = fixture({ declareDistrict: true });

		const bare: Mutation[] = [
			{ kind: "updateUserProperty", uuid: DISTRICT, patch: { slug: "region" } },
		];
		expect(
			mutationCommitVerdict(doc, bare, LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(false);

		const renamed = commit(
			doc,
			updateUserPropertyMutations(doc, DISTRICT, { slug: "region" }),
		);
		expect(workerReads(renamed)).toEqual([`id:${DISTRICT}`]);

		const again = updateUserPropertyMutations(renamed, DISTRICT, {
			slug: "area",
		});
		expect(again).toEqual([
			{ kind: "updateUserProperty", uuid: DISTRICT, patch: { slug: "area" } },
		]);
		const moved = commit(renamed, again);
		expect(workerReads(moved)).toEqual([`id:${DISTRICT}`]);
		expect(printedRelevant(moved)).toBe("#user/area = 'north'");
	});

	it("commits the builder's add and rename as one batch that one undo reverts", () => {
		const doc = fixture({ declareDistrict: true });
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		store.getState().startTracking();
		const api = createBlueprintMutations(store, {
			canEdit: true,
			authoringLanguage: null,
			lookupCommitState: {
				kind: "unmanaged",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			},
		});
		const queued = store.getState().peekCommandBatches().length;

		const renamed = api.inline.updateUserProperty(DISTRICT, {
			slug: "region",
		});
		expect(renamed).toEqual({ ok: true });
		expect(workerReads(store.getState())).toEqual([`id:${DISTRICT}`]);
		expect(store.getState().peekCommandBatches().slice(queued)).toHaveLength(1);

		store.getState().undo();
		expect(workerReads(store.getState())).toEqual(["name:region"]);
		expect(store.getState().userProperties?.[DISTRICT]?.slug).toBe("district");

		const added = api.inline.addUserProperty({
			slug: "region",
			label: "Region",
		});
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(workerReads(store.getState())).toEqual([`id:${added.uuid}`]);
	});

	it("rebinds the source text while the builder shows the worker a translation", () => {
		// Under the Spanish lens an edit of the label's wording goes to the
		// Spanish translation. A rebind changes no wording: the English label
		// and the Spanish translation both come to read the information by its
		// identity, and the translation keeps its words and stays current.
		const doc = fixture({ declareDistrict: true });
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		store.getState().startTracking();
		const api = createBlueprintMutations(store, {
			canEdit: true,
			authoringLanguage: "spa",
			lookupCommitState: {
				kind: "unmanaged",
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			},
		});

		expect(api.inline.updateUserProperty(DISTRICT, { slug: "region" })).toEqual(
			{ ok: true },
		);
		const renamed = store.getState();
		expect(workerReads(renamed)).toEqual([`id:${DISTRICT}`]);
		const unit = labelUnit(renamed);
		const spanish = renamed.localization?.translations.spa?.[unit.id];
		expect(spanish?.sourceFingerprint).toBe(unit.sourceFingerprint);
		expect(spanish?.value).toMatchObject({
			parts: [
				{ kind: "text", text: "Región " },
				{ kind: "user-property-ref", userPropertyUuid: DISTRICT },
				{},
				{},
			],
		});
		expect(renamed.fields[QUESTION]).toMatchObject({
			label: {
				parts: [
					{ kind: "text", text: "Region " },
					{ kind: "user-property-ref", userPropertyUuid: DISTRICT },
					{},
					{},
				],
			},
		});

		store.getState().undo();
		const added = api.inline.addUserProperty({
			slug: "region",
			label: "Region",
		});
		expect(added).toEqual({ ok: true, uuid: expect.any(String) });
		if (!added.ok) return;
		expect(workerReads(store.getState())).toEqual([`id:${added.uuid}`]);
	});
});
