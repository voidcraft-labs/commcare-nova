/**
 * The reader's work grows with a form, not with its square.
 *
 * Contract: `ReadWork` (JSON values and XML nodes visited, texts read with
 * `readFormSyntax`, expected trees built for a generated node) is a function
 * of the input alone, and a form of 400 questions costs each counter at most
 * twice what a form of 200 costs. Both forms are emitted by the production
 * emitter in three languages, each beside one registration of an advanced
 * menu whose open action names an owner node, and together they hold
 * generated nodes of every purpose: a lifted validation count, a protected
 * validation message, a count repeat's count, a query repeat in the count
 * placement, a trimmed case name, a date and time's case text, a capture's
 * link, a keyed create with its count, its condition, its guard and its
 * clock, and the owner node. Each export reads with no finding, so no block
 * the reader refuses skips the work the counters measure. Deterministic; no
 * clock.
 *
 * Plausible failure: a stage that walks every node, or rebuilds every
 * generated tree, once per question, which doubles twice when the form
 * doubles. Where `rebuilds` is the counter that fails, the generated-node
 * recognizer is rebuilding a tree per candidate instead of once per owner.
 */

import { produce } from "immer";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseOperation,
	type LanguageTag,
	type ProseTemplate,
	proseText,
	type Uuid,
} from "@/lib/domain";
import {
	actingUser,
	eq,
	formField,
	literal,
	now,
	term,
} from "@/lib/domain/expression";
import { collectTranslationUnits } from "@/lib/domain/translationUnits";
import { expandDoc } from "../../expander";
import type { GeneratedNodePurpose } from "../../xform/generatedNodes";
import { readHqApp } from "../index";
import type { ReadWork } from "../types";
import { inputFor } from "./novaExport";
import { retainedSourceBody } from "./readerInput";

/** The project space `readerInput` reads from, which a capture's link names. */
const TARGET = { origin: "https://india.commcarehq.org", domain: "clinic" };
const QUESTIONS_PER_BLOCK = 20;

/** Twenty questions, each generated purpose of a block among their nodes. */
function block(i: number): FieldSpec[] {
	const id = (name: string) => testUuid(`work-${name}-${i}`);
	const label = (text: string): ProseTemplate => ({
		parts: [
			{ kind: "text", text: `${text} ${i}, after ` },
			{ kind: "field-ref", uuid: id("text") },
		],
	});
	return [
		f({ uuid: id("text"), kind: "text", id: `text_${i}`, label: `Text ${i}` }),
		f({ uuid: id("key"), kind: "text", id: `key_${i}`, label: label("Key") }),
		f({ uuid: id("on"), kind: "text", id: `on_${i}`, label: label("On") }),
		f({
			kind: "int",
			id: `gate_${i}`,
			label: label("Gate"),
			validate: `count(#form/roster_${i}/answer[. = 'x']) >= 1`,
			validate_msg: label("Needs one x"),
		}),
		f({
			kind: "repeat",
			id: `roster_${i}`,
			label: label("Roster"),
			children: [f({ kind: "text", id: "answer", label: label("Answer") })],
		}),
		f({
			kind: "repeat",
			id: `rows_${i}`,
			label: label("Rows"),
			repeat_mode: "count_bound",
			repeat_count: `#form/gate_${i} + 1`,
			children: [f({ kind: "text", id: "row", label: label("Row") })],
		} as FieldSpec),
		f({
			kind: "repeat",
			id: `found_${i}`,
			label: label("Found"),
			repeat_mode: "query_bound",
			data_source: { ids_query: `#form/text_${i}` },
			children: [
				f({ kind: "text", id: "seen", label: label("Seen") }),
				f({
					kind: "hidden",
					id: "made",
					calculate: "current()/../../@current_index",
				}),
			],
		} as FieldSpec),
		f({
			kind: "single_select",
			id: `pick_${i}`,
			label: label("Pick"),
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
		}),
		f({
			kind: "datetime",
			id: `seen_at_${i}`,
			label: label("Seen at"),
			caseWrite: { caseType: "patient", property: `seen_at_${i}` },
		}),
		f({
			kind: "image",
			id: `photo_${i}`,
			label: label("Photo"),
			caseWrite: { caseType: "patient", property: `photo_${i}` },
		}),
		...Array.from({ length: 6 }, (_, n) =>
			f({ kind: "text", id: `note_${i}_${n}`, label: label(`Note ${n}`) }),
		),
	];
}

/** A keyed create of a visit per block: its count, its condition, its guard and its clock. */
function operations(blocks: number): CaseOperation[] {
	return Array.from({ length: blocks }, (_, i) => ({
		uuid: testUuid(`work-create-${i}`),
		id: `create_visit_${i}`,
		action: "create" as const,
		caseType: "visit",
		target: { kind: "new" as const, idFrom: testUuid(`work-key-${i}`) },
		name: term(formField(testUuid(`work-text-${i}`))),
		owner: actingUser(),
		condition: eq(formField(testUuid(`work-on-${i}`)), literal("yes")),
		writes: [{ property: "occurred_at", value: now() }],
	}));
}

/** One follow-up form of `blocks` blocks, its text in three languages. */
function formOf(blocks: number): BlueprintDoc {
	const fields = Array.from({ length: blocks }, (_, i) => block(i)).flat();
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					...Array.from({ length: blocks }, (_, i) => [
						{
							name: `seen_at_${i}`,
							label: proseText("Seen at"),
							data_type: "datetime" as const,
						},
						{ name: `photo_${i}`, label: proseText("Photo") },
					]).flat(),
				],
			},
			{
				name: "visit",
				properties: [
					{
						name: "occurred_at",
						label: proseText("Occurred at"),
						data_type: "datetime" as const,
					},
				],
			},
			{
				name: "episode",
				parent_type: "patient",
				relationship: "extension" as const,
				properties: [{ name: "note", label: proseText("Note") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "renamed",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							...fields,
						],
					},
				],
			},
			{
				name: "Visits",
				caseType: "visit",
				caseListMenuItem: {},
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
			// An after-submit link that carries the episode a registration creates makes
			// this menu advanced, and the create an open action with its owner node.
			{
				name: "Care",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						formLinks: [
							{
								target: {
									type: "form" as const,
									moduleUuid: testUuid("work-episodes"),
									formUuid: testUuid("work-review"),
								},
							},
						],
						fields: [
							f({
								kind: "text",
								id: "patient_name",
								label: "Patient name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "episode_name",
								label: "Episode name",
								caseWrite: { caseType: "episode", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: "work-episodes",
				name: "Episodes",
				caseType: "episode",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "work-review",
						name: "Review",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "review_note",
								label: "Review note",
								caseWrite: { caseType: "episode", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0] as Uuid]?.[0];
	const form = formUuid === undefined ? undefined : doc.forms[formUuid];
	if (form === undefined) throw new Error("The document holds its one form.");
	form.caseOperations = [...(form.caseOperations ?? []), ...operations(blocks)];
	const languages: [LanguageTag, string][] = [
		["spa" as LanguageTag, "es"],
		["fra" as LanguageTag, "fr"],
	];
	const mutations: Mutation[] = languages.map(([language, wireCode]) => ({
		kind: "addLanguage",
		language: { language },
		wireCode,
	}));
	for (const unit of collectTranslationUnits(doc)) {
		if (unit.owner.kind !== "field" && unit.owner.kind !== "select-option")
			continue;
		if (unit.valueKind !== "prose") continue;
		const source = unit.source as ProseTemplate;
		for (const [language, wireCode] of languages)
			mutations.push({
				kind: "setTranslation",
				language,
				unitId: unit.id,
				entry: {
					value: {
						parts: source.parts.map((part) =>
							part.kind === "text"
								? { kind: "text", text: `${part.text} (${wireCode})` }
								: part,
						),
					},
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng" as LanguageTag,
				},
			});
	}
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

/** The node name each generated purpose is allocated under, by its base's prefix. */
const PURPOSE_NAMES: Readonly<Record<GeneratedNodePurpose, string>> = {
	"constraint-count": "nova_constraint_gate_",
	"constraint-message": "nova_constraint_message_",
	count: "nova_count_rows_",
	"query-ids": "nova_query_ids_",
	"query-count": "nova_query_count_",
	"query-position": "nova_query_position_",
	"query-id": "nova_query_id_",
	"query-index": "nova_query_index_",
	trimmed: "nova_trimmed_",
	datetime: "nova_datetime_",
	url: "nova_url_",
	keyed: "nova_keyed_",
	"keyed-count": "nova_count_nova_keyed_",
	condition: "nova_condition_",
	guard: "nova_guard_",
	instant: "nova_instant_",
	owner: "nova_owner_",
};

/** The purposes the case management stage reads as a Save to Case block's region, which a
 *  reading records as the operations it read, not as folded nodes. */
const CASE_REGION_PURPOSES: ReadonlySet<GeneratedNodePurpose> = new Set([
	"keyed",
	"keyed-count",
	"condition",
	"guard",
	"instant",
]);

/**
 * The work of reading `doc`'s export, and the purposes of the nodes the reading folded: each
 * generated node the reading's facts record, and each case region node of the source, which a
 * reading with no finding has read as its block's.
 */
async function workOf(
	doc: BlueprintDoc,
): Promise<{ work: ReadWork; purposes: Set<GeneratedNodePurpose> }> {
	const emitted = expandDoc(doc, { attachmentTarget: TARGET });
	const outcome = readHqApp(
		await inputFor({
			...retainedSourceBody("shell/app-source"),
			langs: ["en", "es", "fr"],
			modules: JSON.parse(JSON.stringify(emitted.modules)),
			_attachments: emitted._attachments,
		}),
	);
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read") throw new Error("The export did not read.");
	const sources = Object.values(emitted._attachments).join("\n");
	return {
		work: outcome.work,
		purposes: new Set([
			...outcome.draft.facts.forms.flatMap((form) =>
				form.generated.map((node) => node.purpose),
			),
			...[...CASE_REGION_PURPOSES].filter((purpose) =>
				sources.includes(`<${PURPOSE_NAMES[purpose]}`),
			),
		]),
	};
}

it("reads a form of 400 questions with at most twice the work of one of 200", {
	// Two emissions and two whole readings of a few hundred questions.
	timeout: 60_000,
}, async () => {
	const blocks = 200 / QUESTIONS_PER_BLOCK;
	const small = await workOf(formOf(blocks));
	const large = await workOf(formOf(blocks * 2));
	expect([...small.purposes].sort()).toEqual(
		(Object.keys(PURPOSE_NAMES) as GeneratedNodePurpose[]).sort(),
	);
	for (const counter of ["nodes", "syntaxReads", "rebuilds"] as const) {
		expect(small.work[counter]).toBeGreaterThan(0);
		expect([counter, large.work[counter] <= 2 * small.work[counter]]).toEqual([
			counter,
			true,
		]);
	}
});
