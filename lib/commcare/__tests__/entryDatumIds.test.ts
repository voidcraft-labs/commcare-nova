import AdmZip from "adm-zip";
import * as fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	entryDatumSupplies,
	type Uuid,
} from "@/lib/domain";
import {
	chosen,
	chosenCaseDoc,
	chosenCaseProperty,
} from "@/lib/domain/__tests__/chosenCaseFixture";
import {
	instanceReadsDoc,
	reads,
} from "@/lib/domain/expression/__tests__/instanceReadsFixture";
import { eq, prop, term } from "@/lib/domain/expression/builders";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import {
	caseListStepDatumId,
	entryDatumIds,
	formLinkProjectionContext,
} from "../formLinkProjection";
import { runValidation } from "../validator/runner";
import { assertGenerated } from "./compilerEvidence";
import { expectEntryDatumAgreement } from "./entryDatumAgreement";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { SESSION_READS, sessionReadFixture } from "./sessionReadFixture";
import { suiteDocArbitrary } from "./suiteDocArbitrary";
import { blueprintDocArbitrary } from "./xformDocArbitrary";
import { onlyXml, readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

const ROOT = testUuid("datum-wire-households");
const CHILD = testUuid("datum-wire-members");
const ROOT_FORM = testUuid("datum-wire-household-form");
const CHILD_FORM = testUuid("datum-wire-member-form");
const FOLLOWUP = testUuid("datum-wire-followup");

function rows(doc: BlueprintDoc, module: Uuid, form: Uuid) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	expectEntryDatumAgreement(doc);
	return entryDatumIds(doc, formLinkProjectionContext(doc), module, form).map(
		({ id, refs, scalar }) => ({ id, refs, scalar }),
	);
}

function parentSelectionDoc(multiple: boolean) {
	return buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "member", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: ROOT,
				name: "Households",
				caseType: "household",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					...(multiple
						? { selection: { kind: "multiple" as const, maximum: 3 } }
						: {}),
				},
				forms: [
					{
						uuid: ROOT_FORM,
						name: "Visit household",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
			{
				uuid: CHILD,
				name: "Members",
				caseType: "member",
				parentCaseModuleUuid: ROOT,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: CHILD_FORM,
						name: "Visit member",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
}

function allElements(node: XmlEvidence): XmlEvidence[] {
	return [node, ...node.children.flatMap(allElements)];
}

describe("entry datum identities on the emitted session", () => {
	it("gives only non-repeat child creates an identity, keeping their action index", () => {
		const doc = buildDoc({
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "member", parent_type: "household", properties: [] },
			],
			modules: [
				{
					uuid: ROOT,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: ROOT_FORM,
							name: "Register household",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									label: "Name",
									caseWrite: { caseType: "household", property: "case_name" },
								}),
								f({
									kind: "repeat",
									id: "members",
									label: "Members",
									children: [
										f({
											kind: "text",
											id: "name",
											label: "Name",
											caseWrite: { caseType: "member", property: "case_name" },
										}),
									],
								}),
								f({
									kind: "text",
									id: "lead_name",
									label: "Lead member",
									caseWrite: { caseType: "member", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					uuid: CHILD,
					name: "Members",
					caseType: "member",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [],
				},
			],
		});
		expect(rows(doc, ROOT, ROOT_FORM)).toEqual([
			{
				id: "case_id_new_household_0",
				refs: [{ kind: "new-case" }],
				scalar: true,
			},
			{
				id: "case_id_new_member_2",
				refs: [{ kind: "new-child-case", caseType: "member" }],
				scalar: true,
			},
		]);
	});

	it("reads the case block's inherited create id and leaves renamed and unrelated placeholders unbound", () => {
		const doc = buildDoc(
			{
				caseTypes: [{ name: "household", properties: [] }],
				modules: [
					{
						uuid: ROOT,
						name: "Households",
						caseType: "household",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								uuid: ROOT_FORM,
								name: "Register household",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										label: "Name",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
								],
							},
						],
					},
					{
						uuid: CHILD,
						name: "More households",
						caseType: "household",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								uuid: CHILD_FORM,
								name: "Register another household",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										label: "Name",
										caseWrite: { caseType: "household", property: "case_name" },
									}),
								],
							},
							{
								uuid: FOLLOWUP,
								name: "Visit household",
								type: "followup",
								fields: [f({ kind: "text", id: "note", label: "Note" })],
							},
						],
					},
				],
			},
			(draft) => {
				draft.modules[CHILD].parentModuleUuid = ROOT;
			},
		);
		expect(rows(doc, CHILD, CHILD_FORM)).toEqual([
			{
				id: "case_id_new_household_0",
				refs: [{ kind: "new-case" }],
				scalar: true,
			},
			{ id: "case_id_new_household_0_household", refs: [], scalar: true },
		]);
		expect(rows(doc, CHILD, FOLLOWUP)).toEqual([
			{ id: "case_id_new_household_0", refs: [], scalar: true },
			{
				id: "case_id",
				refs: [{ kind: "selected-case", module: CHILD }],
				scalar: true,
			},
		]);
		const hq = expandDoc(doc);
		const archive = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const source = archive.readAsText("modules-1/forms-0.xml");
		const caseIdInitializer = onlyXml(
			allElements(readXmlEvidence(source)).filter(
				(node) =>
					node.name === "setvalue" &&
					node.attributes.ref === "/data/case/@case_id",
			),
		);
		expect(caseIdInitializer.attributes.value).toBe(
			"instance('commcaresession')/session/data/case_id_new_household_0",
		);
	});

	it.each([false, true])(
		"preserves parent selection identity and cardinality (multiple: %s)",
		(multiple) => {
			const doc = parentSelectionDoc(multiple);
			expect(rows(doc, CHILD, CHILD_FORM)).toEqual([
				{
					id: multiple ? "parent_selected_cases" : "parent_id",
					refs: [{ kind: "selected-case", module: ROOT }],
					scalar: !multiple,
				},
				{
					id: "case_id",
					refs: [{ kind: "selected-case", module: CHILD }],
					scalar: true,
				},
			]);
		},
	);

	it("retains both selected-module identities when the child reuses the root's selection", () => {
		const doc = produce(parentSelectionDoc(false), (draft) => {
			draft.modules[CHILD].caseType = "household";
			delete draft.modules[CHILD].parentCaseModuleUuid;
			draft.modules[CHILD].parentModuleUuid = ROOT;
		});
		expect(rows(doc, CHILD, CHILD_FORM)).toEqual([
			{
				id: "case_id",
				refs: [
					{ kind: "selected-case", module: CHILD },
					{ kind: "selected-case", module: ROOT },
				],
				scalar: true,
			},
		]);
	});

	it("holds an aligned child's chosen parent at the root's id and at its own chain id", () => {
		// Members, a child of the root, case-first Households menu, with
		// parent-select Households: HQ's build writes Members' filter with
		// the household as `parent_id`, then renames it to the root's
		// `case_id` as it aligns.
		const doc = produce(parentSelectionDoc(false), (draft) => {
			draft.modules[CHILD].parentModuleUuid = ROOT;
		});
		const household = { kind: "selected-case", module: ROOT } as const;
		const member = { kind: "selected-case", module: CHILD } as const;
		expect(
			entryDatumIds(doc, formLinkProjectionContext(doc), CHILD, CHILD_FORM)
				.filter((row) => row.refs.length > 0)
				.map(({ id, chainId, refs }) => ({ id, chainId, refs })),
		).toEqual([
			{ id: "case_id", chainId: "parent_id", refs: [household] },
			{ id: "case_id_member", chainId: "case_id", refs: [member] },
		]);
		expect(caseListStepDatumId(doc, CHILD)(household)).toBe("case_id");
		expect(caseListStepDatumId(doc, CHILD, "chainId")(household)).toBe(
			"parent_id",
		);
		// The list's own case is chosen at that very step, so it has no id there.
		expect(caseListStepDatumId(doc, CHILD)(member)).toBeUndefined();
	});

	it("identifies worker, non-repeat child, and grouped-tile supplies by their owning entries", () => {
		const doc = sessionReadFixture();
		expect(rows(doc, SESSION_READS.module, SESSION_READS.registration)).toEqual(
			[
				{
					id: "case_id_new_visit_0",
					refs: [{ kind: "new-case" }],
					scalar: true,
				},
				{
					id: "case_id_new_note_1",
					refs: [{ kind: "new-child-case", caseType: "note" }],
					scalar: true,
				},
				{ id: "usercase_id", refs: [{ kind: "worker-record" }], scalar: true },
			],
		);
		expect(rows(doc, SESSION_READS.module, SESSION_READS.followup)).toEqual([
			{
				id: "case_id",
				refs: [{ kind: "selected-case", module: SESSION_READS.module }],
				scalar: true,
			},
			{
				id: "case_id_parent_ids",
				refs: [{ kind: "tile-group-parents", module: SESSION_READS.module }],
				scalar: true,
			},
		]);
	});

	it("marks the inline search's query datum as the supply of what the search found, in its module's menu forms only", () => {
		const doc = instanceReadsDoc();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const context = formLinkProjectionContext(doc);
		const searched = (module: Uuid, form: Uuid) =>
			entryDatumIds(doc, context, module, form).flatMap((row) =>
				row.searchResults === undefined
					? []
					: [
							{
								id: row.id,
								refs: row.refs,
								scalar: row.scalar,
								...row.searchResults,
							},
						],
			);
		expect(searched(reads.find, reads.checkIn)).toEqual([
			{ id: "results:inline", refs: [], scalar: false, module: reads.find },
		]);
		expect(searched(reads.find, reads.register)).toEqual([]);
		expect(searched(reads.households, reads.visit)).toEqual([]);
		// The domain half names the same module at each form's point.
		for (const module of doc.moduleOrder)
			for (const form of doc.formOrder[module] ?? [])
				expect(
					entryDatumSupplies(doc, { kind: "form", module, form }).searchResults,
					`${module}/${form}`,
				).toEqual(
					searched(module, form)[0] === undefined
						? undefined
						: { module: searched(module, form)[0]?.module },
				);
	});

	it("agrees with domain supplies for every form in both compiler generators", () => {
		let entries = 0;
		assertGenerated(
			fc.property(
				blueprintDocArbitrary,
				suiteDocArbitrary,
				(fields, workflow) => {
					entries += expectEntryDatumAgreement(fields);
					const nested = produce(workflow, (draft) => {
						const [root, child] = draft.moduleOrder;
						if (root !== undefined && child !== undefined)
							draft.modules[child].parentModuleUuid = root;
					});
					entries += expectEntryDatumAgreement(nested);
				},
			),
			{ seed: 20261018, numRuns: 40 },
		);
		expect(entries).toBeGreaterThan(80);
	});
});

describe("a form's display condition reading the case chosen in a parent menu", () => {
	// The export prints the read under the id the form's entry holds the
	// parent's selection at, after root alignment, in both carriers: the
	// command's `relevant` in the local suite and `form_filter` in HQ's JSON,
	// which HQ copies into the command as written.
	it("prints the parent's datum id in the suite and in HQ's form filter", () => {
		const doc = chosenCaseDoc();
		doc.forms[chosen.memberForm].displayCondition = eq(
			term(prop("member", "village_name")),
			chosenCaseProperty(chosen.households, "household", "village_name"),
		);
		expect(
			runValidation(structuredClone(doc), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
		const parent = entryDatumIds(
			doc,
			formLinkProjectionContext(doc),
			chosen.members,
			chosen.memberForm,
		).find((row) =>
			row.refs.some(
				(ref) =>
					ref.kind === "selected-case" && ref.module === chosen.households,
			),
		);
		if (parent === undefined)
			throw new Error("The member form's entry holds no household selection.");
		const read = `instance('commcaresession')/session/data/${parent.id}`;

		const hq = expandDoc(doc);
		const filters = hq.modules.flatMap((mod) =>
			mod.forms.flatMap((form) =>
				form.form_filter === null || form.form_filter === undefined
					? []
					: [form.form_filter],
			),
		);
		expect(filters).toHaveLength(1);
		expect(filters[0]).toContain(read);

		const archive = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const relevant = allElements(
			readXmlEvidence(archive.readAsText("suite.xml")),
		).flatMap((node) =>
			node.name === "command" && node.attributes.relevant !== undefined
				? [node.attributes.relevant]
				: [],
		);
		expect(relevant).toHaveLength(1);
		expect(relevant[0]).toContain(read);
	});
});
