/**
 * The diff fuzz corpora: two independently built admitted endpoints per draw,
 * over structure, order, scalars, options, media and held placements. The
 * diff's own round trip and the wording of the differences of two documents
 * (`documentChanges.test.ts`) both draw from them.
 */
import * as fc from "fast-check";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { asUuid } from "@/lib/domain/uuid";

export const endpointArb = fc.record({
	modules: fc.integer({ min: 1, max: 7 }),
	forms: fc.integer({ min: 0, max: 7 }),
	owners: fc.tuple(fc.nat({ max: 2 }), fc.nat({ max: 2 }), fc.nat({ max: 2 })),
	reverse: fc.boolean(),
	nested: fc.boolean(),
	group: fc.boolean(),
	grouped: fc.boolean(),
	optional: fc.boolean(),
	secret: fc.boolean(),
	decimal: fc.boolean(),
	// The number question as a text question: a change of kind no conversion
	// makes, which the diff writes as its removal and its re-add.
	textNumber: fc.boolean(),
	// The group as a label, the question it holds then at the root right after
	// it: a container reborn with a child on one side only.
	groupLabel: fc.boolean(),
	// Two more questions after the number question, at the root or in a group
	// of their own, so that a group's removal moves them out next to a number
	// question that may be reborn.
	tail: fc.constantFrom("absent", "root", "wrapped"),
	// The `fields` record's keys in the reverse of the order they are built,
	// so the record's order is not the order the questions show in.
	keysReversed: fc.boolean(),
	media: fc.boolean(),
	extraOption: fc.boolean(),
	text: fc.nat({ max: 2 }),
	// Each form's query repeat: absent, present and unheld, or holding one of
	// the two placements a query over no answer can express.
	queryRepeat: fc.constantFrom("absent", "unheld", "model-iteration", "count"),
});

/** Open patients: a query that reads no answer of the form, so either
 *  placement expresses the repeat. */
const OPEN_PATIENTS = {
	kind: "project",
	of: {
		kind: "cases",
		source: "casedb",
		where: [eq(prop("patient", "case_name"), literal("open"))],
	},
	value: prop("patient", "case_id"),
} as const;
export type Endpoint =
	typeof endpointArb extends fc.Arbitrary<infer T> ? T : never;
/** The admitted document one draw describes. */
export function endpoint(spec: Endpoint): BlueprintDoc {
	const indices = [0, 1, 2].filter(
		(index) => (spec.modules & (1 << index)) !== 0,
	);
	if (spec.reverse) indices.reverse();
	const formIndices = [0, 1, 2].filter(
		(index) => (spec.forms & (1 << index)) !== 0,
	);
	if (spec.reverse) formIndices.reverse();
	const doc = buildDoc({
		appId: "independent-diff",
		appName: `App ${spec.text}`,
		caseTypes: [{ name: "patient", properties: [] }],
		modules: indices.map((index, position) => {
			const forms = formIndices
				.filter(
					(formIndex) =>
						indices[spec.owners[formIndex] % indices.length] === index,
				)
				.map((formIndex) => {
					const key = `independent-form-${formIndex}`;
					const optional = f({
						uuid: testUuid(`${key}-optional`),
						kind: spec.secret ? "secret" : "text",
						id: "optional",
						label: proseText(`Optional ${spec.text}`),
					});
					const group = spec.groupLabel
						? f({
								uuid: testUuid(`${key}-group`),
								kind: "label",
								id: "group",
								label: proseText("Group"),
							})
						: f({
								uuid: testUuid(`${key}-group`),
								kind: "group",
								id: "group",
								children: spec.optional && spec.grouped ? [optional] : [],
							});
					const number = f({
						uuid: testUuid(`${key}-number`),
						kind: spec.textNumber ? "text" : spec.decimal ? "decimal" : "int",
						id: "number",
						label: proseText("Number"),
					});
					const tail = [
						f({
							uuid: testUuid(`${key}-tail`),
							kind: "text",
							id: "tail",
							label: proseText("Tail"),
						}),
						f({
							uuid: testUuid(`${key}-tail-two`),
							kind: "text",
							id: "tail_two",
							label: proseText("Tail two"),
						}),
					];
					const fields = [
						f({
							uuid: testUuid(`${key}-base`),
							kind: "text",
							id: "base",
							label: proseText(`Base ${spec.text}`),
							...(spec.media
								? {
										label_media: {
											image: testMediaAssetId("independent-label"),
										},
									}
								: {}),
						}),
						...(spec.tail === "absent" ? [number] : []),
						f({
							uuid: testUuid(`${key}-select`),
							kind: "single_select",
							id: "select",
							optionsSource: {
								kind: "inline",
								options: [0, 1, ...(spec.extraOption ? [2] : [])].map(
									(option) => ({
										uuid: testUuid(`${key}-option-${option}`),
										value: `value_${option}`,
										label: proseText(`Option ${option} ${spec.text}`),
									}),
								),
							},
						}),
						...(spec.group ? [group] : []),
						...(spec.optional &&
						(!spec.group || !spec.grouped || spec.groupLabel)
							? [optional]
							: []),
						...(spec.queryRepeat === "absent"
							? []
							: [
									f({
										uuid: testUuid(`${key}-visits`),
										kind: "repeat",
										id: "visits",
										label: proseText("Visits"),
										repeat_mode: "query_bound",
										data_source: { ids_query: OPEN_PATIENTS },
										...(spec.queryRepeat === "unheld"
											? {}
											: { placement: spec.queryRepeat }),
										children: [
											f({
												uuid: testUuid(`${key}-visit-note`),
												kind: "text",
												id: "visit_note",
												label: proseText("Visit note"),
											}),
										],
									}),
								]),
						...(spec.tail === "absent" ? [] : [number]),
						...(spec.tail === "root" ? tail : []),
						...(spec.tail === "wrapped"
							? [
									f({
										uuid: testUuid(`${key}-wrap`),
										kind: "group",
										id: "wrap",
										children: tail,
									}),
								]
							: []),
					];
					if (spec.reverse) fields.reverse();
					return {
						uuid: testUuid(key),
						id: `form_${formIndex}`,
						name: `Form ${formIndex} ${spec.text}`,
						type: "followup" as const,
						...(spec.optional ? { purpose: "Notes" } : {}),
						fields,
					};
				});
			return {
				uuid: testUuid(`independent-module-${index}`),
				id: `module_${index}`,
				name: `Module ${index} ${spec.text}`,
				caseType: "patient",
				...(forms.length === 0 ? { caseListMenuItem: {} } : {}),
				...(spec.nested && position === indices.length - 1 && position > 0
					? { parentModuleUuid: testUuid(`independent-module-${indices[0]}`) }
					: {}),
				caseListConfig: {
					columns: [
						plainColumn(
							testUuid(`independent-column-${index}`),
							"case_name",
							"Name",
						),
					],
					searchInputs: [],
				},
				forms,
			};
		}),
	});
	if (spec.media) doc.logo = testMediaAssetId("independent-logo");
	if (spec.keysReversed) {
		const entries = Object.entries(doc.fields).reverse();
		for (const [uuid] of entries) delete doc.fields[asUuid(uuid)];
		for (const [uuid, field] of entries) doc.fields[asUuid(uuid)] = field;
	}
	return doc;
}
