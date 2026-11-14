/**
 * An advanced form read back from Nova's own emission.
 *
 * Contract: for a document whose menu Nova emits advanced (its kind held),
 * `readCaseManagement` over `expandDoc(D)` gives each form D's type, D's case
 * operations with the placements `planPlacements(D)` gives them (every tag
 * held, the canonical member of `unheld-placements-are-held`), the menu its
 * held kind, and the menu's parent selection the one chain its forms' loads
 * agree on. The plausible failures: a chain read as another parent
 * selection, a tag lost (a publish would rename a session value HQ's forms
 * read), an open action read as the registration's own case or the reverse.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { projectedModulePreorder } from "@/lib/domain/moduleHierarchy";
import { advancedDocArbitrary } from "../../../__tests__/advancedDocArbitrary";
import {
	type AdvancedFixtureOptions,
	advancedFixture,
	chosen,
	HOUSEHOLDS,
	MEMBERS,
	OP,
	read,
	U,
} from "../../../__tests__/advancedPlacementFixture";
import { planPlacements } from "../../../placement";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
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

/** D's operations of a form, each with the placement the plan gives it. */
function written(doc: BlueprintDoc, formUuid: Uuid): unknown {
	const placements = planPlacements(doc, formUuid).placements;
	return (doc.forms[formUuid]?.caseOperations ?? []).map((operation) => {
		const planned = placements.get(operation.uuid);
		const { uuid: _uuid, id: _id, placement: _held, ...rest } = operation;
		return planned === undefined || planned.sharesWith !== undefined
			? rest
			: { ...rest, placement: planned.placement };
	});
}

const CASES: { name: string; options: AdvancedFixtureOptions }[] = [
	{
		name: "a follow-up of a chained menu that writes its own case",
		options: {
			formType: "followup",
			menu: "members",
			operations: (): CaseOperation[] => [
				{
					uuid: OP("own"),
					id: "member",
					action: "own",
					writes: [{ property: "age", value: read("age") }],
				},
			],
		},
	},
	{
		// Its own load writes and closes nothing, and its own arm is still the form's first change.
		name: "a follow-up whose own load changes nothing",
		options: {
			formType: "followup",
			menu: "members",
			operations: (): CaseOperation[] => [
				{ uuid: OP("own"), id: "member", action: "own" },
			],
		},
	},
	{
		name: "a follow-up that updates the parent it chose",
		options: {
			formType: "followup",
			menu: "members",
			operations: (): CaseOperation[] => [
				{
					uuid: OP("own"),
					id: "member",
					action: "own",
					writes: [{ property: "age", value: read("age") }],
				},
				{
					uuid: OP("parent"),
					id: "household",
					action: "update",
					caseType: "household",
					target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
					writes: [{ property: "remark", value: read("name") }],
				},
			],
		},
	},
	{
		name: "a registration whose own case is its one open action, with a child in each row",
		options: {
			formType: "registration",
			operations: (): CaseOperation[] => [
				{ uuid: OP("own"), id: "household", action: "own", name: read("name") },
				{
					uuid: OP("kid"),
					id: "member",
					action: "create",
					caseType: "member",
					target: { kind: "new" },
					name: read("kid_name"),
					forEach: { repeat: U("kids") },
					links: [
						{
							identifier: "parent",
							targetType: "household",
							target: { kind: "op", opUuid: OP("own") },
							relationship: "child",
						},
					],
				},
			],
		},
	},
	{
		// Two indexed open actions in one repeat: HQ's build nests each under its own
		// `case_<tag>`, so neither shares the row's block.
		name: "a registration with two indexed creates in one repeat",
		options: {
			formType: "registration",
			operations: (): CaseOperation[] => [
				{ uuid: OP("own"), id: "household", action: "own", name: read("name") },
				{
					uuid: OP("kid"),
					id: "member",
					action: "create",
					caseType: "member",
					target: { kind: "new" },
					name: read("kid_name"),
					forEach: { repeat: U("kids") },
					links: [
						{
							identifier: "parent",
							targetType: "household",
							target: { kind: "op", opUuid: OP("own") },
							relationship: "child",
						},
					],
				},
				{
					uuid: OP("kid-visit"),
					id: "visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: read("kid_name"),
					forEach: { repeat: U("kids") },
					links: [
						{
							identifier: "member",
							targetType: "member",
							target: { kind: "op", opUuid: OP("kid") },
							relationship: "child",
						},
					],
				},
			],
		},
	},
];

describe("an advanced form read back from Nova's own emission", () => {
	// The whole reading, its acceptance over the bound document included: the
	// plan is advanced, its loads and placements are the ones read, and the
	// actions it writes are the stored ones.
	for (const { name, options } of CASES)
		it(`reads ${name} whole, with no finding`, async () => {
			const { doc } = advancedFixture(options);
			const outcome = readHqApp(await inputFor(exportedBody(doc)));
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		});
	for (const { name, options } of CASES)
		it(`reads ${name} into D's operations, each tag held`, async () => {
			const { doc, formUuid, moduleUuid } = advancedFixture(options);
			const reading = await readCases(doc);
			const form = reading.forms.find(
				(one) => one.form.name === doc.forms[formUuid]?.name,
			);
			if (form === undefined)
				throw new Error("The app holds the form under test.");
			expect(form.form.type).toBe(doc.forms[formUuid]?.type);
			const modules = new Map<string, string>();
			for (const module of reading.ctx.draft.modules)
				modules.set(module.uuid, module.module.name ?? "");
			for (const [uuid, module] of Object.entries(doc.modules))
				modules.set(uuid, module.name);
			const ops = (form.form.caseOperations ?? []).map(
				({ uuid: _uuid, id: _id, ...rest }) => rest,
			);
			const readOps = named(named(ops, readNames(form)), modules);
			// A link to an earlier operation of the form names it by its id.
			const opIds = (operations: readonly CaseOperation[]) =>
				new Map(
					operations.map((operation) => [operation.uuid, `op:${operation.id}`]),
				);
			expect(named(readOps, opIds(form.form.caseOperations ?? []))).toEqual(
				named(
					named(named(written(doc, formUuid), docNames(doc)), modules),
					opIds(doc.forms[formUuid]?.caseOperations ?? []),
				),
			);
			const menu = reading.ctx.draft.modules.find(
				(module) => module.module.name === doc.modules[moduleUuid]?.name,
			);
			expect(menu?.module.heldKind).toBe("advanced");
			expect(
				reading.findings.filter((one) =>
					one.code.startsWith("forms-and-case-writes/"),
				),
			).toEqual([]);
		});

	it("reads every form of every advanced fuzz document back into its operations, each tag held", async () => {
		let advancedForms = 0;
		await fc.assert(
			fc.asyncProperty(advancedDocArbitrary, async (doc) => {
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
				const withoutIds = (operations: readonly CaseOperation[]) =>
					operations.map(
						({ id: _id, ...rest }) => rest,
					) as unknown as CaseOperation[];
				reading.forms.forEach((form, index) => {
					const formUuid = docForms[index] as Uuid;
					if (form.docType === "AdvancedForm") advancedForms += 1;
					const read = (form.form.caseOperations ??
						[]) as readonly CaseOperation[];
					expect(
						comparableOperations(withoutIds(read), readPaths(form), modules),
					).toEqual(
						comparableOperations(
							withoutIds(plannedOperations(doc, formUuid)),
							docPaths(doc, formUuid),
							modules,
						),
					);
				});
			}),
			{ numRuns: 8 },
		);
		expect(advancedForms).toBeGreaterThan(0);
	});

	it("reads the menu's parent selection from the chain its forms' loads agree on", async () => {
		const { doc } = advancedFixture({
			formType: "followup",
			menu: "members",
			operations: () => [
				{
					uuid: OP("own"),
					id: "member",
					action: "own",
					writes: [{ property: "age", value: read("age") }],
				},
			],
		});
		const reading = await readCases(doc);
		const byName = (name: string | undefined) =>
			reading.ctx.draft.modules.find((module) => module.module.name === name);
		const members = byName(doc.modules[MEMBERS]?.name);
		const households = byName(doc.modules[HOUSEHOLDS]?.name);
		expect(members?.module.parentCaseModuleUuid).toBe(households?.uuid);
	});
});
