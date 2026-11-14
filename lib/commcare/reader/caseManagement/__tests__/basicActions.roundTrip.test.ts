import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { projectedModulePreorder } from "@/lib/domain/moduleHierarchy";
import { proseText } from "@/lib/domain/prose";
import { blueprintDocArbitrary } from "../../../__tests__/xformDocArbitrary";
import { planPlacements } from "../../../placement";
import { codesOf, readMenusOf } from "../../menus/__tests__/menuReading";
import {
	comparableOperations,
	docNames,
	docPaths,
	named,
	plannedOperations,
	readCases,
	readNames,
	readPaths,
} from "./caseReading";

function app(forms: FormSpec[]): BlueprintDoc {
	return buildDoc({
		modules: [{ name: "Patients", caseType: "patient", forms }],
	});
}

const OUTCOME = testUuid("outcome");
const DONE = testUuid("option-done");

/** A document's operations of its first form, each with the placement the plan gives it, by name. */
function written(doc: BlueprintDoc): unknown {
	const formUuid = Object.keys(doc.forms)[0] as Uuid;
	const placements = planPlacements(doc, formUuid).placements;
	const operations = (doc.forms[formUuid]?.caseOperations ?? []).map(
		(operation) => {
			const planned = placements.get(operation.uuid);
			const { uuid: _uuid, ...rest } = operation;
			return planned?.sharesWith !== undefined || planned === undefined
				? rest
				: { ...rest, placement: planned.placement };
		},
	);
	return named(operations, docNames(doc));
}

describe("a basic form read back from Nova's own emission", () => {
	const cases: { name: string; forms: FormSpec[] }[] = [
		{
			name: "a follow-up that writes two properties",
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
						f({
							kind: "int",
							id: "weight",
							caseWrite: { caseType: "patient", property: "weight" },
						}),
					],
				},
			],
		},
		{
			name: "a close form that closes its case on a choice and writes one property",
			forms: [
				{
					name: "Discharge",
					type: "close",
					closeCondition: {
						kind: "eq",
						left: { kind: "term", term: { kind: "field", uuid: OUTCOME } },
						right: {
							kind: "term",
							term: { kind: "choice", field: OUTCOME, options: [DONE] },
						},
					},
					fields: [
						f({
							kind: "single_select",
							id: "outcome",
							uuid: OUTCOME,
							optionsSource: {
								kind: "inline",
								options: [
									{ value: "done", label: proseText("Done"), uuid: DONE },
									{
										value: "moved",
										label: proseText("Moved"),
										uuid: testUuid("option-moved"),
									},
								],
							},
							caseWrite: { caseType: "patient", property: "outcome" },
						}),
					],
				},
			],
		},
		{
			name: "a survey",
			forms: [
				{
					name: "Feedback",
					type: "survey",
					fields: [f({ kind: "text", id: "comment" })],
				},
			],
		},
	];

	for (const { name, forms } of cases)
		it(`reads ${name} into the operations and placements Nova wrote`, async () => {
			const doc = app(forms);
			const reading = await readCases(doc);
			const form = reading.forms[0];
			if (form === undefined) throw new Error("The app holds its form.");
			const docForm = Object.values(doc.forms)[0];
			expect(form.form.type).toBe(docForm?.type);
			const read = named(
				(form.form.caseOperations ?? []).map(
					({ uuid: _uuid, ...rest }) => rest,
				),
				readNames(form),
			);
			expect(read).toEqual(written(doc));
			expect(named(form.form.closeCondition, readNames(form))).toEqual(
				named(docForm?.closeCondition, docNames(doc)),
			);
			expect(
				reading.findings.filter((one) =>
					one.code.startsWith("forms-and-case-writes/"),
				),
			).toEqual([]);
		});

	it("reads every form of every fuzz document back into its operations, each placement the plan gives", async () => {
		let operationsRead = 0;
		await fc.assert(
			fc.asyncProperty(blueprintDocArbitrary, async (doc) => {
				const reading = await readCases(doc);
				expect(
					reading.findings.filter((one) =>
						one.code.startsWith("forms-and-case-writes/"),
					),
				).toEqual([]);
				const modules = new Map<string, string>();
				for (const [uuid, module] of Object.entries(doc.modules))
					modules.set(uuid, `menu:${module.name}`);
				for (const module of reading.ctx.draft.modules)
					modules.set(module.uuid, `menu:${module.module.name ?? ""}`);
				const docForms = projectedModulePreorder(doc).flatMap(
					(moduleUuid) => doc.formOrder[moduleUuid] ?? [],
				);
				expect(reading.forms.length).toBe(docForms.length);
				reading.forms.forEach((form, index) => {
					const formUuid = docForms[index] as Uuid;
					const read = (form.form.caseOperations ??
						[]) as readonly CaseOperation[];
					operationsRead += read.length;
					expect(comparableOperations(read, readPaths(form), modules)).toEqual(
						comparableOperations(
							plannedOperations(doc, formUuid),
							docPaths(doc, formUuid),
							modules,
						),
					);
				});
			}),
			{ numRuns: 12 },
		);
		expect(operationsRead).toBeGreaterThan(0);
	});

	/** A follow-up that opens a child case and closes it again, the close sharing the create's place. */
	function childWithClose(): BlueprintDoc {
		const VISIT = testUuid("rt-visit");
		const CHILD_NAME = testUuid("rt-child-name");
		const CREATE = testUuid("rt-create");
		return buildDoc(
			{
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								uuid: "rt-visit",
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "child", uuid: CHILD_NAME })],
							},
						],
					},
				],
			},
			(built) => {
				built.forms[VISIT] = {
					...built.forms[VISIT],
					caseOperations: [
						{ uuid: testUuid("rt-own"), id: "patient", action: "own" },
						{
							uuid: CREATE,
							id: "patient_1",
							action: "create",
							caseType: "patient",
							target: { kind: "new" },
							name: {
								kind: "term",
								term: { kind: "field", uuid: CHILD_NAME },
							},
							links: [
								{
									identifier: "parent",
									targetType: "patient",
									target: { kind: "session" },
									relationship: "child",
								},
							],
						},
						{
							uuid: testUuid("rt-close"),
							id: "patient_2",
							action: "close",
							caseType: "patient",
							target: { kind: "op", opUuid: CREATE },
						},
					] as CaseOperation[],
				} as never;
			},
		);
	}

	it("holds every placement of the read document, each close sharing the place it was read beside, through the settle", async () => {
		const docs = [...cases.map(({ forms }) => app(forms)), childWithClose()];
		for (const doc of docs) {
			const reading = await readMenusOf(doc);
			expect(
				codesOf(reading).filter(
					(code) =>
						code.startsWith("unrecognized:schema:Form") ||
						code.startsWith("forms-and-case-writes/"),
				),
			).toEqual([]);
			const read = reading.doc;
			if (read === undefined)
				throw new Error(
					`The reading holds a finding: ${codesOf(reading).join(", ")}`,
				);
			for (const [formUuid, form] of Object.entries(read.forms)) {
				const plan = planPlacements(read, formUuid as Uuid);
				expect(plan.inexpressible).toEqual([]);
				const operations = form.caseOperations ?? [];
				for (const operation of operations) {
					const planned = plan.placements.get(operation.uuid);
					if (operation.placement !== undefined)
						expect(planned?.held).toBe(true);
					else if (
						operation.action === "close" &&
						operation.target.kind === "op"
					)
						expect(planned?.sharesWith).toBe(operation.target.opUuid);
				}
			}
		}
	});
});
