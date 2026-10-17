/**
 * The one allocator of generated node names: what it gives a form whose
 * authored names equal its bases, that it is a function of the document, and
 * that the XForm builder and `formActions.ts` read the same names from it.
 */
import { type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import {
	type GeneratedNodePlan,
	planGeneratedNodes,
} from "@/lib/commcare/xform/generatedNodes";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	type CaseOperation,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/predicate";
import { directRepeatCountReference } from "@/lib/domain/repeatCount";
import { FormPath } from "../xform/formPath";
import { emissionFixtures } from "./emissionFixtures";

function collisionDoc(): { doc: BlueprintDoc; formUuid: Uuid } {
	const doc = buildDoc({
		appName: "Generated names",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "photo_url", label: proseText("Photo") },
					{ name: "seen_at", label: proseText("Seen"), data_type: "datetime" },
				],
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
							f({ kind: "text", id: "nova_url_photo" }),
							f({
								kind: "image",
								id: "photo",
								caseWrite: {
									caseType: "patient",
									property: "photo_url",
									mode: "url",
								},
							}),
							f({ kind: "text", id: "nova_operations" }),
							f({ kind: "text", id: "nova_datetime_when" }),
							f({
								kind: "datetime",
								id: "when",
								caseWrite: { caseType: "patient", property: "seen_at" },
							}),
							f({ kind: "text", id: "other" }),
							f({ kind: "text", id: "nova_constraint_message_x" }),
							f({
								kind: "text",
								id: "message_x",
								validate:
									"count(#form/other[. = 'yes']) > 0 and count(#form/other[. = 'no']) = 0",
							}),
							f({
								kind: "text",
								id: "x",
								validate: ". != ''",
								// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${` is what makes a message protected
								validate_msg: proseText("Write ${1}"),
							}),
							f({ kind: "text", id: "nova_count_items" }),
							f({
								kind: "repeat",
								id: "items",
								repeat_mode: "count_bound",
								repeat_count: "2",
								children: [f({ kind: "text", id: "note" })],
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const key = Object.values(doc.fields).find((field) => field.id === "other");
	if (key === undefined) throw new Error("Missing key question");
	const operations: CaseOperation[] = [
		{
			uuid: "make" as Uuid,
			id: "make",
			action: "create",
			caseType: "patient",
			target: { kind: "new", idFrom: key.uuid },
			name: term(formField(key.uuid)),
			condition: eq(formField(key.uuid), literal("yes")),
		},
		{
			uuid: "taken" as Uuid,
			id: "nova_keyed_make",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			rename: term(formField(key.uuid)),
		},
	];
	doc.forms[formUuid].caseOperations = operations;
	return { doc, formUuid };
}

/** Every name a plan gives the collision form, in allocation order. */
function names(doc: BlueprintDoc, formUuid: Uuid, plan: GeneratedNodePlan) {
	const field = (id: string) => {
		const found = Object.values(doc.fields).find((field) => field.id === id);
		if (found === undefined) throw new Error(`Missing ${id}`);
		return found.uuid;
	};
	return {
		constraintCounts: [0, 1].map((n) =>
			plan.constraintCount(field("message_x"), n),
		),
		constraintMessage: plan.constraintMessage(field("x")),
		url: plan.url(field("photo")),
		datetime: plan.datetime(field("when")),
		count: plan.count(field("items")),
		operations: plan.operations(FormPath.root()),
		selectedCases: plan.selectedCases(FormPath.root()),
		keyedCount: plan.keyedCount("make" as Uuid),
		keyed: plan.keyed("make" as Uuid),
		condition: plan.condition("make" as Uuid),
		guards: [
			plan.guard("make" as Uuid, "text"),
			plan.guard("taken" as Uuid, "text"),
		],
		nodes: plan.nodes,
		formUuid,
	};
}

describe("planGeneratedNodes", () => {
	it("steps around every authored name, Connect ids at the root among them", () => {
		const { doc, formUuid } = collisionDoc();
		doc.connectType = "deliver";
		doc.forms[formUuid].connect = {
			deliver_unit: { id: "nova_selected_cases", name: "Visit" },
		};
		const plan = planGeneratedNodes(doc, formUuid);
		expect(names(doc, formUuid, plan)).toMatchObject({
			constraintCounts: [
				"nova_constraint_message_x_0",
				"nova_constraint_message_x_1",
			],
			// The authored sibling takes the base and the earlier count its
			// first suffix, so the message takes the next.
			constraintMessage: "nova_constraint_message_x_2",
			url: "nova_url_photo_1",
			datetime: "nova_datetime_when_1",
			count: "nova_count_items_1",
			operations: "nova_operations_1",
			selectedCases: "nova_selected_cases_1",
			keyedCount: "nova_count_nova_keyed_make_1",
			keyed: "nova_keyed_make_1",
			condition: "nova_condition_make",
			guards: ["nova_guard_make_text", "nova_guard_nova_keyed_make_text"],
		});
	});

	it("gives a copy of a document the plan the document has", () => {
		const { doc, formUuid } = collisionDoc();
		const copy = structuredClone(doc);
		expect(names(copy, formUuid, planGeneratedNodes(copy, formUuid))).toEqual(
			names(doc, formUuid, planGeneratedNodes(doc, formUuid)),
		);
	});

	it.each(emissionFixtures())(
		"$name: names counts and protected messages as today",
		({ doc }) => {
			for (const formUuid of Object.keys(doc.forms) as Uuid[]) {
				const plan = planGeneratedNodes(doc, formUuid);
				const messages = new Set(
					plan.nodes
						.filter((node) => node.purpose === "constraint-message")
						.map((node) => node.owner),
				);
				const visit = (parentUuid: Uuid) => {
					const siblings = new Set(
						orderedFieldUuids(doc, parentUuid).map(
							(uuid) => doc.fields[uuid].id,
						),
					);
					// Today each allocator steps around its siblings' authored names;
					// no fixture holds a suffixed name that meets a generated one.
					const free = (base: string) => {
						let name = base;
						for (let n = 1; siblings.has(name); n++) name = `${base}_${n}`;
						return name;
					};
					for (const uuid of orderedFieldUuids(doc, parentUuid)) {
						const field = doc.fields[uuid];
						if (
							field.kind === "repeat" &&
							field.repeat_mode === "count_bound" &&
							directRepeatCountReference(field.repeat_count, doc.fields) ===
								undefined
						)
							expect(plan.count(uuid)).toBe(free(`nova_count_${field.id}`));
						if (messages.has(uuid))
							expect(plan.constraintMessage(uuid)).toBe(
								free(`nova_constraint_message_${field.id}`),
							);
						visit(uuid);
					}
				};
				visit(formUuid);
			}
		},
	);
});

it("names the URL and datetime siblings in the form's actions as its XForm writes them, under a collision", () => {
	const { doc, formUuid } = collisionDoc();
	doc.forms[formUuid].caseOperations = undefined;
	const hq = expandDoc(doc, {
		attachmentTarget: {
			origin: "https://www.commcarehq.org",
			domain: "demo-project",
		},
	});
	const form = hq.modules[0].forms[0];
	const source = hq._attachments[`${form.unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing source XForm");
	const data = (
		[...parseDocument(source, { xmlMode: true }).children].filter(isTag)[0]
			.children as Element[]
	)
		.filter(isTag)
		.flatMap((head) => head.children.filter(isTag))
		.flatMap((model) => model.children.filter(isTag))
		.find((instance) => instance.name === "instance" && !instance.attribs.src)
		?.children.filter(isTag)[0];
	const dataNames = new Set(
		data?.children.filter(isTag).map((element) => element.name),
	);
	const update = form.actions.update_case.update;
	expect(update.photo_url.question_path).toBe("/data/nova_url_photo_1");
	expect(update.seen_at.question_path).toBe("/data/nova_datetime_when_1");
	expect(dataNames.has("nova_url_photo_1")).toBe(true);
	expect(dataNames.has("nova_datetime_when_1")).toBe(true);
});
