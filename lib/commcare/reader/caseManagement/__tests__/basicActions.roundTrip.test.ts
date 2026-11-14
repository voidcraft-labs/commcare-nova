import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { formField, term, unowned } from "@/lib/domain/expression/builders";
import { projectedModulePreorder } from "@/lib/domain/moduleHierarchy";
import { proseText } from "@/lib/domain/prose";
import { caseListOf } from "../../../../../proof/targeted/build";
import { expressionDocArbitrary } from "../../../__tests__/expressionDocArbitrary";
import {
	buildShape,
	destination,
	otherwise,
} from "../../../__tests__/formLinkDocArbitrary";
import { menuScreenDocArbitrary } from "../../../__tests__/menuScreenDocArbitrary";
import { namesDocArbitrary } from "../../../__tests__/namesDocArbitrary";
import { suiteDocArbitrary } from "../../../__tests__/suiteDocArbitrary";
import { blueprintDocArbitrary } from "../../../__tests__/xformDocArbitrary";
import { emittedModuleKind } from "../../../moduleKind";
import { planPlacements } from "../../../placement";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { READER_CANONICAL_CHOICES } from "../../assemble";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, readHqApp } from "../../index";
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

	/** Members chosen under their household, whose visit saves its own answers and, through the
	 *  household it was chosen under, the household's: each step typed or not, as Nova admits both. */
	const viaDocArbitrary: fc.Arbitrary<BlueprintDoc> = fc
		.record({
			typed: fc.boolean(),
			own: fc.integer({ min: 0, max: 2 }),
			above: fc.integer({ min: 1, max: 2 }),
		})
		.map(({ typed, own, above }) => {
			const VISIT = testUuid("rt-via-visit");
			const ids = [
				...Array.from({ length: own }, (_, i) => `note_${i}`),
				...Array.from({ length: above }, (_, i) => `size_${i}`),
			];
			return buildDoc(
				{
					caseTypes: [
						{
							name: "household",
							properties: ids
								.filter((id) => id.startsWith("size"))
								.map((id) => ({ name: id, label: id })),
						},
						{
							name: "member",
							parent_type: "household",
							properties: ids
								.filter((id) => id.startsWith("note"))
								.map((id) => ({ name: id, label: id })),
						},
					],
					modules: [
						{
							uuid: "rt-via-households",
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
											caseWrite: {
												caseType: "household",
												property: "case_name",
											},
										}),
									],
								},
							],
						},
						{
							name: "Members",
							caseType: "member",
							parentCaseModuleUuid: "rt-via-households",
							forms: [
								{
									uuid: "rt-via-visit",
									name: "Visit",
									type: "followup",
									fields: ids.map((id) =>
										f({ kind: "text", id, uuid: testUuid(`rt-via-${id}`) }),
									),
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
								uuid: testUuid("rt-via-own"),
								id: "member",
								action: "own",
								writes: ids.map((id) => ({
									property: id,
									value: term(formField(testUuid(`rt-via-${id}`))),
									...(id.startsWith("size") && {
										via: [
											typed
												? { identifier: "parent", throughCaseType: "household" }
												: { identifier: "parent" },
										],
									}),
								})),
							} as CaseOperation,
						],
					} as never;
				},
			);
		});

	/** The findings a whole reading raises at a form's case actions: a manifest entry of this
	 *  part, or an `unrecognized` its settle names. */
	function caseActionFindings(codes: readonly string[]): string[] {
		return codes.filter(
			(code) =>
				code.startsWith("forms-and-case-writes/") ||
				code.startsWith("unrecognized:schema:FormActions.") ||
				code.startsWith("unrecognized:schema:ConditionalCaseUpdate.") ||
				code.startsWith("unrecognized:schema:FormActionCondition.") ||
				code.startsWith("unrecognized:entry-fact:") ||
				code === "unrecognized:schema:Form.actions",
		);
	}

	const typedVia = READER_CANONICAL_CHOICES.find(
		(one) => one.id === "write-via-steps-are-typed",
	);
	const derivedIds = READER_CANONICAL_CHOICES.find(
		(one) => one.id === "basic-slot-operation-ids-are-derived",
	);

	const generators: [string, fc.Arbitrary<BlueprintDoc>][] = [
		["suiteDocArbitrary", suiteDocArbitrary],
		["menuScreenDocArbitrary", menuScreenDocArbitrary],
		[
			"formLinkDocArbitrary",
			fc
				.tuple(fc.array(destination, { maxLength: 3 }), otherwise)
				.map(([destinations, drawn]) => buildShape(destinations, drawn)),
		],
		["namesDocArbitrary", namesDocArbitrary],
		["expressionDocArbitrary", expressionDocArbitrary],
		["writes through the case above", viaDocArbitrary],
	];

	for (const [name, arbitrary] of generators)
		it(`reads every basic form of ${name} back into its operations, with nothing raised at its actions`, async () => {
			let operationsRead = 0;
			await fc.assert(
				fc.asyncProperty(arbitrary, async (drawn) => {
					const doc = typedVia?.apply(drawn) ?? drawn;
					const reading = await readCases(doc, { parentSelections: true });
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
					const docForms = projectedModulePreorder(doc).flatMap((moduleUuid) =>
						(doc.formOrder[moduleUuid] ?? []).map(
							(formUuid) => [moduleUuid, formUuid] as const,
						),
					);
					reading.forms.forEach((form, index) => {
						const [moduleUuid, formUuid] = docForms[index] as readonly [
							Uuid,
							Uuid,
						];
						if (emittedModuleKind(doc, moduleUuid) !== "basic") return;
						const read = (form.form.caseOperations ??
							[]) as readonly CaseOperation[];
						operationsRead += read.length;
						// A basic slot prints no operation's id: the reader derives it from the case
						// type, as the canonical row does.
						expect(
							comparableOperations(read, readPaths(form), modules),
						).toEqual(
							comparableOperations(
								plannedOperations(derivedIds?.apply(doc) ?? doc, formUuid),
								docPaths(doc, formUuid),
								modules,
							),
						);
					});
					// The whole reading, its settle included, raises nothing at a form's case actions.
					expect(caseActionFindings(codesOf(await readMenusOf(doc)))).toEqual(
						[],
					);
				}),
				{ numRuns: 6 },
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

/**
 * The own arm's owner, as Nova prints it. Contract: a registration's and a
 * follow-up's own arm whose owner is a question's answer takes Case
 * Management's own slot, which HQ's form actions hold as the update key
 * `owner_id` naming the question; one that leaves its case unowned holds a
 * value no question gives, so the plan keeps that arm in a Save to Case block.
 * Each reads back from Nova's export, with no finding, to the owner the
 * canonical document holds, and the slot's owner is claimed under its own
 * row. The plausible failure: the owner key read as an ordinary write, or
 * dropped, gives a document whose case is owned by whoever submits it.
 */
describe("an own arm's owner read back from Nova's own emission", () => {
	const ownerId = (key: string) => testUuid(`owner-${key}`);

	function owned(
		type: "registration" | "followup",
		owner: "question" | "unowned",
	): BlueprintDoc {
		return buildDoc(
			{
				appId: "app-1",
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
					},
				],
				modules: [
					{
						uuid: ownerId("menu"),
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListOf([
							plainColumn(ownerId("name-column"), "case_name", "Name"),
						]),
						forms: [
							{
								uuid: ownerId("form"),
								name: "Visit",
								type,
								fields: [
									f({ kind: "text", uuid: ownerId("name"), id: "name" }),
									f({ kind: "text", uuid: ownerId("worker"), id: "worker" }),
								],
							},
						],
					},
				],
			},
			(built) => {
				const form = built.forms[ownerId("form")];
				if (form !== undefined)
					form.caseOperations = [
						{
							uuid: ownerId("own"),
							id: "patient",
							action: "own",
							...(type === "registration" && {
								name: term(formField(ownerId("name"))),
							}),
							owner:
								owner === "question"
									? term(formField(ownerId("worker")))
									: unowned(),
						} as CaseOperation,
					];
			},
		);
	}

	it.each([
		["registration", "question", "basic"],
		["followup", "question", "basic"],
		["registration", "unowned", "save-to-case"],
		["followup", "unowned", "save-to-case"],
	] as const)(
		"reads a %s's own arm owned by a %s, kept in %s, back to the canonical owner",
		async (type, owner, kept) => {
			const doc = owned(type, owner);
			expect(
				planPlacements(doc, ownerId("form")).placements.get(ownerId("own"))
					?.placement.kind,
			).toBe(kept);
			const outcome = readHqApp(
				await inputFor(exportedBody(doc), {
					resolver: matchingResolver(
						"app-1",
						externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
					),
					knownCaseTypes: knownCaseTypesOf(doc),
				}),
			);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			const canonical = READER_CANONICAL_CHOICES.reduce(
				(current, choice) => choice.apply(current),
				doc,
			);
			const ownOf = (one: BlueprintDoc) =>
				one.forms[ownerId("form")]?.caseOperations?.find(
					(operation) => operation.action === "own",
				);
			expect(ownOf(outcome.draft.doc)?.owner).toEqual(ownOf(canonical)?.owner);
			expect(ownOf(canonical)?.owner).toEqual(ownOf(doc)?.owner);
			const claimed =
				outcome.claims.counts["forms-and-case-writes/update-key-owner-id"] ?? 0;
			if (kept === "basic") expect(claimed).toBeGreaterThan(0);
			else expect(claimed).toBe(0);
		},
	);
});
