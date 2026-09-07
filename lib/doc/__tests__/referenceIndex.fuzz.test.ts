/**
 * Incremental maintenance is compared with a fresh build after admitted edits.
 * Both paths share extraction, so this proves maintenance consistency; explicit
 * independently named edges in referenceIndex.test.ts own extraction correctness.
 * Every run is reproducible: fixture and command identities depend only on the
 * supplied seed/steps. Changed-edge counters compare values, never Immer identity.
 */
import { isDeepStrictEqual } from "node:util";
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	canonicalProseTemplate,
	plainColumn,
} from "@/lib/domain";
import { eq, formField, literal, prop, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("index-fuzz-module");
const FORM = testUuid("index-fuzz-form");
const A = testUuid("index-fuzz-a");
const B = testUuid("index-fuzz-b");
const WATCHER = testUuid("index-fuzz-watcher");
const SELECT = testUuid("index-fuzz-select");
const OPTION = testUuid("index-fuzz-option");
const EXTRA_OPTION = testUuid("index-fuzz-extra-option");
const TEMPORARY = testUuid("index-fuzz-temporary");
const OPERATION = testUuid("index-fuzz-operation");
const COLUMN = testUuid("index-fuzz-column");

function seedDoc(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: ["metric_a", "metric_b", "metric_out"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text",
				})),
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(COLUMN, "case_name", "Name")],
					searchInputs: [],
					filter: eq(prop("patient", "metric_a"), literal("yes")),
				},
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: A,
								kind: "text",
								id: "a",
								caseWrite: { caseType: "patient", property: "metric_a" },
							}),
							f({ uuid: B, kind: "text", id: "b" }),
							f({
								uuid: WATCHER,
								kind: "text",
								id: "watcher",
								relevant: {
									parts: [
										{ kind: "field-ref", uuid: A },
										{ kind: "text", text: " != ''" },
									],
								},
							}),
							f({
								uuid: SELECT,
								kind: "single_select",
								id: "choice",
								optionsSource: {
									kind: "inline",
									options: [
										{ uuid: OPTION, value: "base", label: proseText("Base") },
										{
											uuid: testUuid("second-base-option"),
											value: "second",
											label: proseText("Second"),
										},
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[FORM].caseOperations = [
		{
			uuid: OPERATION,
			id: "record_metric",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [{ property: "metric_out", value: term(formField(A)) }],
		},
	];
	assertAdmittedDoc(doc);
	doc.refIndex = buildReferenceIndex(doc);
	return doc;
}

const kinds = [
	"relevant",
	"label",
	"writer",
	"filter",
	"option",
	"temporary",
	"operation",
] as const;
type Kind = (typeof kinds)[number];
type Op = { kind: Kind; pick: number };
const opArb = fc.record({
	kind: fc.constantFrom(...kinds),
	pick: fc.integer({ min: 0, max: 2 }),
});

function lower(doc: BlueprintDoc, { kind, pick }: Op): Mutation[] {
	const fieldUuid = pick === 0 ? A : B;
	const property = pick === 0 ? "metric_a" : "metric_b";
	switch (kind) {
		case "relevant":
			return [
				{
					kind: "updateField",
					uuid: WATCHER,
					targetKind: "text",
					patch: {
						relevant:
							pick === 2
								? null
								: {
										parts: [
											{ kind: "field-ref", uuid: fieldUuid },
											{ kind: "text", text: " != ''" },
										],
									},
					},
				},
			];
		case "label":
			return [
				{
					kind: "updateField",
					uuid: WATCHER,
					targetKind: "text",
					patch: {
						label:
							pick === 2
								? proseText("No references")
								: canonicalProseTemplate([
										{ kind: "field-ref", uuid: fieldUuid },
										{ kind: "text", text: " reads " },
										{ kind: "case-ref", caseType: "patient", property },
									]),
					},
				},
			];
		case "writer":
			return [
				{
					kind: "updateField",
					uuid: A,
					targetKind: "text",
					patch: {
						caseWrite: pick === 2 ? null : { caseType: "patient", property },
					},
				},
			];
		case "filter":
			return [
				{
					kind: "setCaseListMeta",
					uuid: MODULE,
					patch: {
						filter:
							pick === 2 ? null : eq(prop("patient", property), literal("yes")),
					},
				},
			];
		case "option": {
			const field = doc.fields[SELECT];
			if (
				field.kind !== "single_select" ||
				field.optionsSource.kind !== "inline"
			)
				throw new Error("inline select missing");
			const exists = field.optionsSource.options.some(
				(option) => option.uuid === EXTRA_OPTION,
			);
			if (pick === 2)
				return exists
					? [{ kind: "removeOption", fieldUuid: SELECT, uuid: EXTRA_OPTION }]
					: [];
			const label = canonicalProseTemplate([
				{ kind: "case-ref", caseType: "patient", property },
			]);
			return [
				...(!exists
					? [
							{
								kind: "addOption" as const,
								fieldUuid: SELECT,
								option: {
									uuid: EXTRA_OPTION,
									value: "extra",
									label: proseText("Before edit"),
								},
								after: OPTION,
							},
						]
					: []),
				{
					kind: "updateOption",
					fieldUuid: SELECT,
					uuid: EXTRA_OPTION,
					option: { uuid: EXTRA_OPTION, value: "extra", label },
				},
			];
		}
		case "temporary":
			return doc.fields[TEMPORARY] === undefined
				? [
						{
							kind: "addField",
							parentUuid: FORM,
							field: {
								uuid: TEMPORARY,
								kind: "text",
								id: "temporary",
								label: canonicalProseTemplate([
									{ kind: "case-ref", caseType: "patient", property },
								]),
								relevant: {
									parts: [
										{ kind: "field-ref", uuid: fieldUuid },
										{ kind: "text", text: " != ''" },
									],
								},
							},
						},
					]
				: [{ kind: "removeField", uuid: TEMPORARY }];
		case "operation":
			return [
				{
					kind: "updateForm",
					uuid: FORM,
					patch: {},
					caseOperationPatch: {
						operation: "update-write",
						uuid: OPERATION,
						property: "metric_out",
						patch: {
							value:
								pick === 2
									? term(literal("constant"))
									: term(formField(fieldUuid)),
						},
					},
				},
			];
	}
}

describe("reference-index maintenance across admitted mutation sequences", () => {
	it("equals a fresh build after every generated batch and changes edges in every generated family", async () => {
		const changed = new Map<Kind, number>(kinds.map((kind) => [kind, 0]));
		const initial = seedDoc();
		await fc.assert(
			fc.property(fc.array(opArb, { minLength: 1, maxLength: 18 }), (ops) => {
				let doc = initial;
				for (const op of ops) {
					const mutations = lower(doc, op);
					const verdict = mutationCommitVerdict(
						doc,
						mutations,
						LOOKUP_CONTEXT_UNAVAILABLE,
					);
					expect(
						verdict.ok,
						JSON.stringify({
							op,
							findings: verdict.ok ? [] : verdict.findings,
						}),
					).toBe(true);
					const next = produce(doc, (draft) => {
						applyMutations(draft, mutations);
					});
					expect(next.refIndex).toEqual(buildReferenceIndex(next));
					if (!isDeepStrictEqual(next.refIndex, doc.refIndex))
						changed.set(op.kind, (changed.get(op.kind) ?? 0) + 1);
					doc = next;
				}
			}),
			{ numRuns: 80, seed: 20260611 },
		);
		for (const kind of kinds)
			expect(
				changed.get(kind),
				`no actual edge transition for ${kind}`,
			).toBeGreaterThan(0);
	});
});
