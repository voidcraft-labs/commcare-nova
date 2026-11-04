/**
 * Extension child cases. An extension child is a create
 * operation with an `extension` link. HQ's basic build ignores a subcase's
 * relationship (`xform.py::XForm._create_casexml`), so a basic subcase holds
 * child creates only: an extension create no link carries is a Save to Case
 * block in `nova_operations` with a new id of its own, and one a link
 * carries is an advanced open action indexed to its parent as an extension.
 *
 * Catches the inert subcase coming back (a `subcases` entry with
 * relationship `extension` or condition `never`, or a block reading a
 * session value for its id), a basic child that keeps a former extension's
 * index, and a carried extension that loses its datum or its owner.
 */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { planFormCaseWire } from "@/lib/commcare/casePlacementPlan";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { linkCarriedCreates } from "@/lib/commcare/formLinkProjection";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema, type Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	type ExtensionScenario,
	extensionCaseFixture,
	extensionScenarios,
} from "./extensionCaseFixture";
import { basicForm } from "./hqBasicShape";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

const ATTACHMENT_TARGET = {
	origin: "https://www.commcarehq.org",
	domain: "demo-project",
};

function one(nodes: Element[]): Element {
	expect(nodes).toHaveLength(1);
	const node = nodes[0];
	if (!node) throw new Error("Missing wire node");
	return node;
}
function xmlTree(xml: string) {
	new SaxesParser({ xmlns: true }).write(xml).close();
	return parseDocument(xml, { xmlMode: true });
}
function at(parent: Element, name: string) {
	return one(parent.children.filter(isTag).filter((e) => e.name === name));
}
function modelOf(xml: string): Element {
	const tree = xmlTree(xml);
	return at(at(one(tree.children.filter(isTag)), "h:head"), "model");
}
function dataOf(model: Element): Element {
	return at(
		one(
			model.children
				.filter(isTag)
				.filter((e) => e.name === "instance" && !e.attribs.src),
		),
		"data",
	);
}

/** The case-recording form of a fixture, and its operations by case type. */
function recordCare(doc: BlueprintDoc) {
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = moduleUuid && doc.formOrder[moduleUuid]?.[0];
	if (moduleUuid === undefined || formUuid === undefined)
		throw new Error("The fixture has no case-recording form.");
	const byType = new Map<string, Uuid>();
	for (const op of doc.forms[formUuid]?.caseOperations ?? [])
		if (op.action === "create") byType.set(op.caseType, op.uuid);
	const op = (caseType: string): Uuid => {
		const uuid = byType.get(caseType);
		if (uuid === undefined)
			throw new Error(`The fixture creates no ${caseType} case.`);
		return uuid;
	};
	return { moduleUuid, formUuid, op };
}

/** Every `OpenSubCaseAction` an HQ application holds, across every form. */
function everySubcase(app: unknown): { relationship: string; type: string }[] {
	const found: { relationship: string; type: string }[] = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		if (record.doc_type === "OpenSubCaseAction") {
			const condition = record.condition as { type: string };
			found.push({
				relationship: String(record.relationship),
				type: condition.type,
			});
		}
		for (const child of Object.values(record)) walk(child);
	};
	walk(app);
	return found;
}

const uncarried = extensionScenarios.filter(
	(scenario): scenario is Exclude<ExtensionScenario, "registration"> =>
		scenario !== "registration",
);

/** Where a scenario's root-scope operations group stands, from `/data`. */
function operationsParent(scenario: ExtensionScenario): string {
	switch (scenario) {
		case "repeat":
			return "/data/records";
		case "query":
			return "/data/records/item";
		case "multiple":
			return "/data/nova_selected_cases/item";
		case "multiple-repeat":
			return "/data/records/nova_selected_cases/item";
		default:
			return "/data";
	}
}

describe("an extension child no link carries", () => {
	it.each(uncarried)(
		"is a Save to Case block with a new id of its own, and the basic children renumber (%s)",
		(scenario) => {
			const doc = extensionCaseFixture(scenario);
			expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
				true,
			);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const { moduleUuid, formUuid, op } = recordCare(doc);
			expect(emittedModuleKind(doc, moduleUuid)).toBe("basic");
			expect(linkCarriedCreates(doc, formUuid).size).toBe(0);

			const plan = planFormCaseWire(doc, formUuid, {
				attachmentTarget: ATTACHMENT_TARGET,
			});
			if (plan.kind !== "basic") throw new Error("Expected a basic form.");
			// The visit, a child, is HQ's only subcase: index 0 where the two
			// extension children no longer stand beside it.
			expect(
				plan.actions.subcases.map((subcase) => [
					subcase.case_type,
					subcase.relationship,
					subcase.condition.type,
				]),
			).toEqual([["visit", "child", "always"]]);
			const multiple =
				scenario === "multiple" || scenario === "multiple-repeat";
			expect(
				plan.saveToCase
					.filter(
						(block) =>
							block.subject.kind === "operation" &&
							(block.subject.operationUuid === op("episode") ||
								block.subject.operationUuid === op("consent")),
					)
					.map((block) => block.path),
			).toEqual(
				["episode", "consent"].map((name) =>
					multiple
						? ["nova_selected_cases", "item", "nova_operations", name]
						: ["nova_operations", name],
				),
			);
			// Only the visit outside a repeat is given a datum, at its new index.
			const repeated = scenario !== "followup" && scenario !== "multiple";
			const ownDatum =
				scenario === "repeat" || scenario === "query"
					? ["case_id_new_patient_0"]
					: [];
			expect(plan.datums.map((datum) => datum.id)).toEqual([
				...ownDatum,
				...(repeated ? [] : ["case_id_new_visit_0"]),
			]);

			const hq = expandDoc(doc, { attachmentTarget: ATTACHMENT_TARGET });
			expect(
				everySubcase(hq).filter(
					(s) => s.relationship === "extension" || s.type === "never",
				),
			).toEqual([]);
			const form = basicForm(hq, 0, 0);
			const source = hq._attachments[`${form.unique_id}.xml`];
			if (typeof source !== "string") throw new Error("Missing source form");
			const zip = new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			);
			const local = zip.readAsText("modules-0/forms-0.xml");

			// The suite gives the entry the datums the plan states, and no other
			// new case's.
			const suite = xmlTree(zip.readAsText("suite.xml"));
			const entry = one(
				findAll(
					(e) =>
						e.name === "entry" &&
						e.children
							.filter(isTag)
							.some(
								(n) =>
									n.name === "form" &&
									n.children.some(
										(t) => t.type === "text" && t.data === form.xmlns,
									),
							),
					suite.children,
				),
			);
			expect(
				at(entry, "session")
					.children.filter(isTag)
					.filter(
						(e) =>
							e.name === "datum" && e.attribs.id?.startsWith("case_id_new_"),
					)
					.map((e) => ({ id: e.attribs.id, function: e.attribs.function })),
			).toEqual(
				plan.datums.map((datum) => ({ id: datum.id, function: "uuid()" })),
			);

			for (const xml of [source, local]) {
				const model = modelOf(xml);
				const binds = model.children
					.filter(isTag)
					.filter((e) => e.name === "bind");
				const bindAt = (path: string) =>
					one(binds.filter((b) => b.attribs.nodeset === path)).attribs;
				// No `nova_subcases` group is written where no held path names one.
				expect(
					findAll((e) => e.name === "nova_subcases", dataOf(model).children),
				).toEqual([]);
				for (const type of ["episode", "consent"]) {
					const path = `${operationsParent(scenario)}/nova_operations/${type}/case`;
					const block = one(
						findAll(
							(e) =>
								e.name === "case" &&
								e.parent !== null &&
								(e.parent as Element).name === type &&
								(e.parent?.parent as Element | null)?.name ===
									"nova_operations",
							dataOf(model).children,
						),
					);
					expect(block.attribs.xmlns).toBe(
						"http://commcarehq.org/case/transaction/v2",
					);
					expect(at(at(block, "index"), "parent").attribs).toEqual({
						case_type: "patient",
						relationship: "extension",
					});
					expect(bindAt(`${path}/create/case_type`).calculate).toBe(
						`'${type}'`,
					);
					// The id is a new one: a setvalue at the form root, a bind in
					// a row. No block reads a session value for its id.
					const idSetvalues = model.children
						.filter(isTag)
						.filter(
							(e) =>
								e.name === "setvalue" && e.attribs.ref === `${path}/@case_id`,
						);
					const idBinds = binds.filter(
						(b) => b.attribs.nodeset === `${path}/@case_id`,
					);
					if (scenario === "followup") {
						expect(one(idSetvalues).attribs).toEqual({
							ref: `${path}/@case_id`,
							event: "xforms-ready",
							value: "uuid()",
						});
						expect(idBinds).toEqual([]);
					} else {
						expect(idSetvalues).toEqual([]);
						expect(one(idBinds).attribs.calculate).toBe("uuid()");
					}
				}
				// Only the blocks HQ's build writes (the form's own `case`, a
				// basic subcase's) read the datum their entry mints.
				expect(
					model.children
						.filter(isTag)
						.filter(
							(e) =>
								(e.name === "setvalue" || e.name === "bind") &&
								(e.attribs.ref ?? e.attribs.nodeset ?? "").includes("/nova_") &&
								(e.attribs.ref ?? e.attribs.nodeset ?? "").endsWith(
									"/@case_id",
								) &&
								(e.attribs.value ?? e.attribs.calculate ?? "").includes(
									"case_id_new_",
								),
						),
				).toEqual([]);
			}
			// The local archive writes the visit where HQ's build does: its own
			// `subcase_0` at the root, or its repeat row's own `case`.
			if (scenario === "followup")
				expect(
					dataOf(modelOf(local))
						.children.filter(isTag)
						.map((e) => e.name)
						.filter((name) => /^(subcase_\d+|case)$/.test(name)),
				).toEqual(["subcase_0", "case"]);
		},
	);

	it("keeps a published extension child's held block in its nova_subcases group", () => {
		const doc = extensionCaseFixture("followup");
		const { formUuid, op } = recordCare(doc);
		const form = doc.forms[formUuid];
		const episode = op("episode");
		const held: BlueprintDoc = {
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: {
					...form,
					caseOperations: (form?.caseOperations ?? []).map((operation) =>
						operation.uuid === episode
							? {
									...operation,
									placement: {
										kind: "save-to-case" as const,
										path: ["nova_subcases", "nova_subcase_0"] as [
											string,
											...string[],
										],
									},
								}
							: operation,
					),
				},
			},
		};
		expect(runValidation(held, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const plan = planFormCaseWire(held, formUuid);
		expect(
			plan.saveToCase.find(
				(block) =>
					block.subject.kind === "operation" &&
					block.subject.operationUuid === episode,
			),
		).toMatchObject({
			path: ["nova_subcases", "nova_subcase_0"],
			held: true,
		});
		const hq = expandDoc(held);
		const source = hq._attachments[`${basicForm(hq, 0, 0).unique_id}.xml`];
		if (typeof source !== "string") throw new Error("Missing source form");
		const model = modelOf(source);
		const rootNames = dataOf(model)
			.children.filter(isTag)
			.map((e) => e.name);
		// The held group stands after the authored questions, where the
		// published app holds it; the unheld consent stays in nova_operations.
		expect(rootNames[0]).toBe("nova_operations");
		expect(rootNames.at(-1)).toBe("nova_subcases");
		const path = "/data/nova_subcases/nova_subcase_0/case";
		expect(
			at(at(at(dataOf(model), "nova_subcases"), "nova_subcase_0"), "case")
				.attribs.xmlns,
		).toBe("http://commcarehq.org/case/transaction/v2");
		expect(
			one(
				model.children
					.filter(isTag)
					.filter(
						(e) =>
							e.name === "setvalue" && e.attribs.ref === `${path}/@case_id`,
					),
			).attribs.value,
		).toBe("uuid()");
		expect(at(at(dataOf(model), "nova_operations"), "consent").name).toBe(
			"consent",
		);
	});
});

describe("an extension child a link carries", () => {
	it("is an advanced open action indexed to its parent as an extension, owned by the worker", () => {
		const doc = extensionCaseFixture("registration");
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const { moduleUuid, formUuid, op } = recordCare(doc);
		expect([...linkCarriedCreates(doc, formUuid)]).toEqual([op("episode")]);
		expect(emittedModuleKind(doc, moduleUuid)).toBe("advanced");

		const plan = planFormCaseWire(doc, formUuid, {
			attachmentTarget: ATTACHMENT_TARGET,
		});
		if (plan.kind !== "advanced") throw new Error("Expected an advanced form.");
		expect(plan.saveToCase).toEqual([]);
		expect(plan.loads).toEqual([]);
		const opens = plan.actions.open_cases;
		expect(opens.map((open) => [open.case_type, open.case_tag])).toEqual([
			["patient", "open_patient_0"],
			["episode", "open_episode_1"],
			["visit", "open_visit_2"],
			["consent", "open_consent_3"],
		]);
		const [patient, episode, visit, consent] = opens;
		expect(patient?.case_indices).toEqual([]);
		for (const [open, relationship] of [
			[episode, "extension"],
			[visit, "child"],
			[consent, "extension"],
		] as const)
			expect(open?.case_indices).toEqual([
				{
					doc_type: "CaseIndex",
					tag: "open_patient_0",
					reference_id: "parent",
					relationship,
					relationship_question: "",
				},
			]);
		// HQ's build leaves a case whose every index is an extension unowned
		// (`xform.py::autoset_owner_id_for_advanced_action`), so the worker
		// is named through a generated node; the child is owned by HQ's build.
		expect(episode?.case_properties.owner_id).toEqual({
			question_path: "/data/nova_owner_episode",
			update_mode: "always",
		});
		expect(consent?.case_properties.owner_id).toEqual({
			question_path: "/data/nova_owner_consent",
			update_mode: "always",
		});
		expect(visit?.case_properties.owner_id).toBeUndefined();
		expect(
			plan.generated.map((node) => ({
				operationUuid: node.operationUuid,
				scope: node.scope.toXPath(),
				name: node.name,
				value: node.value,
			})),
		).toEqual([
			{
				operationUuid: op("episode"),
				scope: "/data",
				name: "nova_owner_episode",
				value: "acting-user",
			},
			{
				operationUuid: op("consent"),
				scope: "/data",
				name: "nova_owner_consent",
				value: "acting-user",
			},
		]);
		expect(episode?.case_properties.photo?.question_path).toBe(
			"/data/nova_url_episode_photo",
		);
		// Each open action outside a repeat is given its datum by its index in
		// `open_cases`, and the carried episode is the one the link reads.
		expect(plan.datums.map((datum) => [datum.id, datum.ref])).toEqual([
			["case_id_new_patient_0", { kind: "new-case" }],
			[
				"case_id_new_episode_1",
				{ kind: "new-child-case", caseType: "episode" },
			],
			["case_id_new_visit_2", { kind: "new-child-case", caseType: "visit" }],
			[
				"case_id_new_consent_3",
				{ kind: "new-child-case", caseType: "consent" },
			],
		]);
		expect(
			plan.appendedNames.map((name) => [name.scope.toXPath(), name.name]),
		).toEqual([
			["/data", "case_open_patient_0"],
			["/data", "case_open_episode_1"],
			["/data", "case_open_visit_2"],
			["/data", "case_open_consent_3"],
		]);
		expect(Object.keys(plan.actions)).toEqual([
			"doc_type",
			"load_update_cases",
			"open_cases",
		]);
	});
});

it("writes no required on a Hidden Value that names an extension child", () => {
	// HQ's form builder marks `required` on a Hidden Value "Required is not
	// allowed." on every save; the name a hidden value calculates is never
	// blank for want of an answer.
	const doc = buildDoc({
		appName: "Hidden child name",
		caseTypes: [
			{ name: "patient", properties: [] },
			{
				name: "episode",
				parent_type: "patient",
				relationship: "extension",
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
						name: "Open episode",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "episode_name",
								calculate: "'Episode'",
								caseWrite: { caseType: "episode", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				name: "Episodes",
				caseType: "episode",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Review episode",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: proseText("Note"),
								caseWrite: { caseType: "episode", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	const source = hq._attachments[`${basicForm(hq, 0, 0).unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing source form");
	const model = modelOf(source);
	const nameBinds = model.children
		.filter(isTag)
		.filter(
			(e) => e.name === "bind" && e.attribs.nodeset === "/data/episode_name",
		);
	expect(one(nameBinds).attribs.required).toBeUndefined();
	// A Hidden Value takes no validation condition either.
	expect(one(nameBinds).attribs.constraint).toBeUndefined();
	// The episode is a Save to Case block in the root operations group, which
	// stands before the authored questions.
	expect(
		dataOf(model)
			.children.filter(isTag)
			.map((e) => e.name)[0],
	).toBe("nova_operations");
	expect(
		findAll(
			(e) =>
				e.name === "bind" && e.attribs.nodeset.endsWith("/create/case_name"),
			model.children,
		).map((e) => e.attribs.nodeset),
	).toEqual(["/data/nova_operations/episode/case/create/case_name"]);
});

// A several-case form's selection inside a repeat is the count placement, as a
// query repeat there is: model iteration's absolute `@current_index` counts the
// rows of every outer row, so a second outer row would read an index past its
// own ids (`questions/model-iteration-repeat-nested-in-another-repeat-of-any-kind`).
// Catches a nested selection written as model iteration again, a row id read
// from `@id`, and a row guard that names the row itself (Core refuses that
// form as cyclical).
it("writes a selection inside a repeat in the count placement", () => {
	const doc = extensionCaseFixture("multiple-repeat");
	const hq = expandDoc(doc);
	const form = hq.modules[0].forms[0];
	const source = hq._attachments[`${form.unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing source form");
	const tree = xmlTree(source);
	const html = one(tree.children.filter(isTag));
	const model = at(at(html, "h:head"), "model");
	const data = dataOf(model);
	const selection = at(at(data, "records"), "nova_selected_cases");
	expect(selection.attribs).toEqual({});
	expect(selection.children.filter(isTag).map((e) => e.name)).toEqual([
		"nova_query_ids_nova_selected_cases",
		"nova_query_count_nova_selected_cases",
		"item",
	]);
	const item = at(selection, "item");
	expect(item.attribs).toEqual({ "jr:template": "" });
	expect(item.children.filter(isTag).map((e) => e.name)).toEqual([
		"nova_query_id_nova_selected_cases",
		"nova_query_index_nova_selected_cases",
		"nova_operations",
	]);
	const wrapper = "/data/records/nova_selected_cases";
	const binds = model.children.filter(isTag).filter((e) => e.name === "bind");
	const bindAt = (path: string) =>
		one(binds.filter((b) => b.attribs.nodeset === path)).attribs;
	expect(
		bindAt(`${wrapper}/nova_query_count_nova_selected_cases`),
	).toMatchObject({
		type: "xsd:int",
		calculate: "count-selected(../nova_query_ids_nova_selected_cases)",
	});
	expect(bindAt(`${wrapper}/item`).relevant).toBe(
		"position() < ../nova_query_count_nova_selected_cases",
	);
	expect(
		bindAt(`${wrapper}/item/nova_query_id_nova_selected_cases`).calculate,
	).toBe(
		"if(../nova_query_index_nova_selected_cases < ../../nova_query_count_nova_selected_cases, selected-at(../../nova_query_ids_nova_selected_cases, ../nova_query_index_nova_selected_cases), '')",
	);
	// Only the row's id and index are set, when the row is made.
	expect(
		model.children
			.filter(isTag)
			.filter(
				(e) => e.name === "setvalue" && e.attribs.ref?.startsWith(wrapper),
			)
			.map((e) => [e.attribs.event, e.attribs.ref, e.attribs.value]),
	).toEqual([
		[
			"jr-insert",
			`${wrapper}/item/nova_query_id_nova_selected_cases`,
			"if(position(..) < int(../../nova_query_count_nova_selected_cases), selected-at(../../nova_query_ids_nova_selected_cases, position(..)), '')",
		],
		[
			"jr-insert",
			`${wrapper}/item/nova_query_index_nova_selected_cases`,
			"position(..)",
		],
	]);
	const repeat = one(
		findAll(
			(e) => e.name === "repeat" && e.attribs.nodeset === `${wrapper}/item`,
			html.children,
		),
	);
	expect(repeat.attribs["jr:count"]).toBe(
		`${wrapper}/nova_query_count_nova_selected_cases`,
	);
	expect(repeat.parent && (repeat.parent as Element).parent).toMatchObject({
		name: "group",
		attribs: { ref: wrapper },
	});
});
