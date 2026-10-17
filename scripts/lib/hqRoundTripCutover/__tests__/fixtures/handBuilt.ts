/**
 * The hand-built pre-step fixtures: a document for each step of the
 * transform, each blocker code and each reason for a change that writes
 * nothing whose shape no corpus fixture holds, plus one holding an open
 * workspace's app. Each is built from a corpus document of the pre-step tree
 * with the shape it names written in, and the capture refuses one the
 * pre-step schema and gate do not admit. Its `check` reads the raw carriers,
 * so `fixtures.test.ts` holds each to its shape at any head of the stack.
 */

import { produce } from "immer";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import type { Json, JsonRecord, RawDocument } from "../../oldShape";
import type { FixtureProject, FixtureWitnesses } from "./preStep";

export interface HandBuiltFixture {
	readonly id: string;
	readonly holds: string;
	/** Builds the document from the pre-step corpus documents, by id. */
	readonly build: (base: (id: string) => BlueprintDoc) => BlueprintDoc;
	readonly check: (document: RawDocument) => boolean;
	readonly project?: FixtureProject;
	/** The corpus document whose Project data (lookup tables, uploads) the fixture's Project holds. */
	readonly projectFrom?: string;
	/** Stored case schema rows that differ from the document's derivation. */
	readonly storedSchemas?: (
		derived: Readonly<Record<string, unknown>>,
	) => Readonly<Record<string, unknown>>;
	readonly witnesses: FixtureWitnesses;
}

const NAVIGATION = {
	menu: asUuid("17a69048-be0c-59d4-a7a2-9bda805659b8"),
	visit: asUuid("cd8766da-7326-51ee-aa0b-f8101304f9ea"),
	register: asUuid("cb8763b4-7126-5ec8-ac0b-fb361104f6c4"),
	answer: asUuid("f8d4b97c-9f51-5998-aa67-295205b7246c"),
	name: asUuid("f6d4b656-a551-530a-a467-1fe003b72146"),
};

/** A fixed uuid for an entity a fixture adds. */
function fixtureUuid(n: number) {
	return asUuid(`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);
}

function text(value: string) {
	return { parts: [{ kind: "text" as const, text: value }] };
}

function record(value: Json | undefined): JsonRecord | undefined {
	return value !== null &&
		value !== undefined &&
		typeof value === "object" &&
		!Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function list(value: Json | undefined): readonly Json[] {
	return Array.isArray(value) ? value : [];
}

function parts(value: Json | undefined): string {
	return list(record(value)?.parts)
		.map((part) => {
			const run = record(part);
			return run?.kind === "text" ? String(run.text) : "";
		})
		.join("");
}

const fields = (document: RawDocument) => Object.values(document.fields);
const forms = (document: RawDocument) => Object.values(document.forms);
const modules = (document: RawDocument) => Object.values(document.modules);
const columns = (document: RawDocument) =>
	modules(document).flatMap((module) =>
		list(record(module.caseListConfig)?.columns).map((column) =>
			record(column),
		),
	);
const operations = (document: RawDocument) =>
	forms(document).flatMap((form) =>
		list(form.caseOperations).map((operation) => record(operation)),
	);

/** navigation-base with one more question in Visit. */
function withVisitField(
	base: (id: string) => BlueprintDoc,
	field: Record<string, unknown>,
): BlueprintDoc {
	return produce(base("navigation-base"), (draft) => {
		const uuid = field.uuid as ReturnType<typeof asUuid>;
		draft.fields[uuid] = field as never;
		draft.fieldOrder[NAVIGATION.visit]?.push(uuid);
		draft.fieldParent[uuid] = NAVIGATION.visit;
	});
}

const CHECKS = {
	menu: fixtureUuid(0xc01),
	form: fixtureUuid(0xc02),
	field: fixtureUuid(0xc03),
	column: fixtureUuid(0xc04),
};

/** A typed time literal. */
function time(value: string) {
	return {
		kind: "term" as const,
		term: { kind: "literal" as const, value, data_type: "time" as const },
	};
}

/**
 * navigation-base with a case-first menu, Checks, whose one follow-up form
 * shows only when the patient's visit time is after eight, and, with
 * `menuCondition`, whose own display condition orders two times.
 */
function withChecksMenu(
	base: (id: string) => BlueprintDoc,
	menuCondition: boolean,
): BlueprintDoc {
	return produce(base("navigation-base"), (draft) => {
		const patient = draft.caseTypes?.find((type) => type.name === "patient");
		patient?.properties.push({
			name: "visit_time",
			data_type: "time",
			label: text("Visit time"),
		} as never);
		draft.modules[CHECKS.menu] = {
			uuid: CHECKS.menu,
			id: "checks",
			name: "Checks",
			caseType: "patient",
			caseListConfig: {
				columns: [
					{
						uuid: CHECKS.column,
						kind: "plain",
						field: "case_name",
						header: "Name",
					},
				],
				listColumnOrder: [CHECKS.column],
				detailColumnOrder: [CHECKS.column],
				searchInputs: [],
			},
			...(menuCondition && {
				displayCondition: {
					kind: "gt",
					left: time("11:00"),
					right: time("10:00"),
				},
			}),
		} as never;
		draft.forms[CHECKS.form] = {
			uuid: CHECKS.form,
			id: "check",
			name: "Check",
			type: "followup",
			displayCondition: {
				kind: "gt",
				left: {
					kind: "term",
					term: { kind: "prop", caseType: "patient", property: "visit_time" },
				},
				right: time("08:00"),
			},
		} as never;
		draft.fields[CHECKS.field] = {
			uuid: CHECKS.field,
			kind: "time",
			id: "arrived",
			label: text("Arrived"),
			caseWrite: { caseType: "patient", property: "visit_time" },
		} as never;
		draft.moduleOrder.push(CHECKS.menu);
		draft.formOrder[CHECKS.menu] = [CHECKS.form];
		draft.fieldOrder[CHECKS.form] = [CHECKS.field];
		draft.fieldParent[CHECKS.field] = CHECKS.form;
	});
}

function displayConditionOrdersTime(condition: Json | undefined): boolean {
	const predicate = record(condition);
	if (predicate === undefined) return false;
	const sides = [record(predicate.left), record(predicate.right)];
	return (
		["gt", "gte", "lt", "lte"].includes(String(predicate.kind)) &&
		sides.some(
			(side) =>
				record(side?.term)?.data_type === "time" ||
				record(side?.term)?.property === "visit_time",
		)
	);
}

/** A lookup table definition with one text column, as a fixture's Project holds it. */
function lookupTable(id: string, tag: string, columnIds: readonly string[]) {
	return {
		id,
		name: tag,
		tag,
		definitionRevision: "1",
		columns: columnIds.map((columnId, index) => ({
			id: columnId,
			wireName: index === 0 ? "code" : "name",
			label: index === 0 ? "code" : "name",
			dataType: "text",
		})),
	};
}

/**
 * targeted-lookup-reserved-tags' two tables, whose tags hold casedb and
 * ledgerdb, beside a table under the casedb tag's rename and each of its
 * suffixed forms _2 to _99, so the rename finds no free tag.
 */
function reservedTagLookup() {
	const renamed = "clinic_case_db_codes";
	const taken = [
		renamed,
		...Array.from({ length: 98 }, (_, index) => `${renamed}_${index + 2}`),
	];
	return {
		projectId: "project-targeted-lookup",
		projectRevision: "1",
		definitions: [
			lookupTable(
				"d8dbbcf0-0f5e-7bb4-a5ac-36165523d8e0",
				"clinic_casedb_codes",
				[
					"62d5a386-5297-7222-a2f0-59687640a116",
					"b093f8e4-8df9-7b40-a281-4e5ac6795f74",
				],
			),
			lookupTable(
				"3c0c6f97-ce38-7af3-aa88-1a15ab2b5a27",
				"stock_ledgerdb_codes",
				[
					"70813dd3-2b92-76b7-aa7b-b26d343b7483",
					"f744d22d-daec-7001-afa9-7ccbb2cfa81d",
				],
			),
			...taken.map((tag, index) =>
				lookupTable(
					`018f0000-0000-7000-8000-${(0x100000 + index).toString(16).padStart(12, "0")}`,
					tag,
					[
						`018f0000-0000-7000-8000-${(0x200000 + index).toString(16).padStart(12, "0")}`,
					],
				),
			),
		],
		rowsByTable: {},
	};
}

export const HAND_BUILT_FIXTURES: readonly HandBuiltFixture[] = [
	{
		id: "hand-media-slots",
		holds:
			"an image on a hint, an image on a validation message and an image on a group's label",
		build: (base) => base("targeted-media-slots"),
		projectFrom: "targeted-media-slots",
		check: (document) =>
			fields(document).some((field) => field.hint_media !== undefined) &&
			fields(document).some(
				(field) => field.validate_msg_media !== undefined,
			) &&
			fields(document).some(
				(field) =>
					(field.kind === "group" || field.kind === "repeat") &&
					field.label_media !== undefined,
			),
		witnesses: {
			steps: ["media-slots"],
			blockers: [],
			reasons: ["media-slot-removed"],
		},
	},
	{
		id: "hand-hidden-inert-default",
		holds:
			"a Hidden Value whose default is the one-part text '' beside no calculate, writing a property the registration form does not preload, and one in a follow-up that does",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const inRegister = fixtureUuid(0x101);
				const inVisit = fixtureUuid(0x102);
				draft.fields[inRegister] = {
					uuid: inRegister,
					kind: "hidden",
					id: "status_seed",
					default_value: text("''"),
					caseWrite: { caseType: "patient", property: "visit_status" },
				} as never;
				draft.fields[inVisit] = {
					uuid: inVisit,
					kind: "hidden",
					id: "status_kept",
					default_value: text("''"),
					caseWrite: { caseType: "patient", property: "visit_status" },
				} as never;
				draft.fieldOrder[NAVIGATION.register]?.push(inRegister);
				draft.fieldOrder[NAVIGATION.visit]?.push(inVisit);
				draft.fieldParent[inRegister] = NAVIGATION.register;
				draft.fieldParent[inVisit] = NAVIGATION.visit;
			}),
		check: (document) =>
			fields(document).filter(
				(field) =>
					field.kind === "hidden" &&
					field.calculate === undefined &&
					parts(field.default_value) === "''" &&
					list(record(field.default_value)?.parts).length === 1,
			).length === 2,
		witnesses: {
			steps: ["hidden-inert-default"],
			blockers: [],
			reasons: ["hidden-value-saves-blank"],
		},
	},
	{
		id: "hand-case-operation-ids",
		holds: "a case operation whose id is instance",
		build: (base) =>
			produce(base("case-operation-query"), (draft) => {
				for (const form of Object.values(draft.forms)) {
					for (const operation of form.caseOperations ?? []) {
						if (operation.id === "tag_visit") operation.id = "instance";
					}
				}
			}),
		check: (document) =>
			operations(document).some((operation) => operation?.id === "instance"),
		witnesses: {
			steps: ["case-operation-ids"],
			blockers: [],
			reasons: ["case-operation-renamed"],
		},
	},
	{
		id: "hand-option-values",
		holds:
			"a select storing two options of one value, and a catalog list property with two options of one value",
		build: (base) =>
			produce(
				withVisitField(base, {
					uuid: fixtureUuid(0x201),
					kind: "single_select",
					id: "consent",
					label: text("Consent"),
					optionsSource: {
						kind: "inline",
						options: [
							{ uuid: fixtureUuid(0x202), value: "yes", label: text("Yes") },
							{ uuid: fixtureUuid(0x203), value: "yes", label: text("Agreed") },
							{ uuid: fixtureUuid(0x204), value: "no", label: text("No") },
						],
					},
				}),
				(draft) => {
					const patient = draft.caseTypes?.find(
						(type) => type.name === "patient",
					);
					patient?.properties.push({
						name: "risk",
						data_type: "single_select",
						label: text("Risk"),
						options: [
							{ value: "high", label: text("High") },
							{ value: "high", label: text("Very high") },
						],
					} as never);
				},
			),
		check: (document) =>
			fields(document).some((field) => {
				const values = list(record(field.optionsSource)?.options).map(
					(option) => record(option)?.value,
				);
				return new Set(values).size < values.length;
			}),
		witnesses: {
			steps: ["option-values"],
			blockers: [],
			reasons: ["option-value-split"],
		},
	},
	{
		id: "hand-option-labels",
		holds:
			"a stored option whose label is blank in every language and carries no media",
		build: (base) =>
			withVisitField(base, {
				uuid: fixtureUuid(0x301),
				kind: "single_select",
				id: "visit_kind",
				label: text("Visit kind"),
				optionsSource: {
					kind: "inline",
					options: [
						{ uuid: fixtureUuid(0x302), value: "home", label: { parts: [] } },
						{
							uuid: fixtureUuid(0x303),
							value: "clinic",
							label: text("Clinic"),
						},
					],
				},
			}),
		check: (document) =>
			fields(document).some((field) =>
				list(record(field.optionsSource)?.options).some(
					(option) =>
						parts(record(option)?.label) === "" &&
						record(option)?.media === undefined,
				),
			),
		witnesses: {
			steps: ["option-labels"],
			blockers: [],
			reasons: ["option-label-filled"],
		},
	},
	{
		id: "hand-empty-forms",
		holds:
			"a form holding a Hidden Value and no question, and a sectioned form whose first section holds none",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const flat = fixtureUuid(0x401);
				const sectioned = fixtureUuid(0x402);
				const flatHidden = fixtureUuid(0x403);
				const section = fixtureUuid(0x404);
				const sectionHidden = fixtureUuid(0x405);
				draft.forms[flat] = {
					uuid: flat,
					id: "tally",
					name: "Tally",
					type: "survey",
				} as never;
				draft.forms[sectioned] = {
					uuid: sectioned,
					id: "sectioned_tally",
					name: "Sectioned tally",
					type: "survey",
				} as never;
				draft.fields[flatHidden] = {
					uuid: flatHidden,
					kind: "hidden",
					id: "stamp",
					calculate: text("today()"),
				} as never;
				draft.fields[section] = {
					uuid: section,
					kind: "section",
					id: "first",
					label: text("First"),
				} as never;
				draft.fields[sectionHidden] = {
					uuid: sectionHidden,
					kind: "hidden",
					id: "stamp",
					calculate: text("today()"),
				} as never;
				draft.formOrder[NAVIGATION.menu]?.push(flat, sectioned);
				draft.fieldOrder[flat] = [flatHidden];
				draft.fieldOrder[sectioned] = [section];
				draft.fieldOrder[section] = [sectionHidden];
				draft.fieldParent[flatHidden] = flat;
				draft.fieldParent[section] = sectioned;
				draft.fieldParent[sectionHidden] = section;
			}),
		check: (document) =>
			forms(document).some((form) =>
				(document.fieldOrder[String(form.uuid)] ?? []).every(
					(uuid) => document.fields[uuid]?.kind === "hidden",
				),
			),
		witnesses: {
			steps: ["empty-forms"],
			blockers: [],
			reasons: ["empty-form-label-added"],
		},
	},
	{
		id: "hand-unsupplied-session-reads",
		holds:
			"a calculate that reads a session datum the form's entry does not declare",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const uuid = fixtureUuid(0x501);
				draft.fields[uuid] = {
					uuid,
					kind: "hidden",
					id: "referrer",
					calculate: text(
						"instance('commcaresession')/session/data/referrer_id",
					),
				} as never;
				draft.fieldOrder[NAVIGATION.register]?.push(uuid);
				draft.fieldParent[uuid] = NAVIGATION.register;
			}),
		check: (document) =>
			fields(document).some((field) =>
				parts(field.calculate).includes("/session/data/referrer_id"),
			),
		witnesses: {
			steps: ["unsupplied-session-reads"],
			blockers: [],
			reasons: ["session-read-removed"],
		},
	},
	{
		id: "hand-post-submit",
		holds:
			"follow-up forms returning to the previous screen in a single-select menu under a multi-select one, and the reverse",
		build: (base) => base("targeted-multi-select-destinations"),
		check: (document) =>
			modules(document).some(
				(module) => record(module.caseListConfig)?.multiSelect !== undefined,
			) || modules(document).length > 1,
		witnesses: {
			steps: ["post-submit"],
			blockers: [],
			reasons: ["after-submit-destination-moved"],
		},
	},
	{
		id: "hand-id-mapping-keys",
		holds: "an ID-mapping column whose value holds an ampersand",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const config = draft.modules[NAVIGATION.menu]?.caseListConfig;
				if (config === undefined) throw new Error("No case list.");
				const uuid = fixtureUuid(0x601);
				config.columns.push({
					uuid,
					kind: "id-mapping",
					field: "notes",
					header: "Notes",
					mapping: [
						{ value: "a&b", label: "Both" },
						{ value: "plain", label: "Plain" },
					],
				} as never);
				config.listColumnOrder.push(uuid);
				config.detailColumnOrder.push(uuid);
			}),
		check: (document) =>
			columns(document).some((column) =>
				list(column?.mapping).some((entry) =>
					/[&<>"']/.test(String(record(entry)?.value)),
				),
			),
		witnesses: {
			steps: ["id-mapping-keys"],
			blockers: [],
			reasons: ["id-mapping-entry-removed"],
		},
	},
	{
		id: "hand-date-patterns",
		holds: "a date column whose pattern holds a straight apostrophe",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const config = draft.modules[NAVIGATION.menu]?.caseListConfig;
				if (config === undefined) throw new Error("No case list.");
				const uuid = fixtureUuid(0x701);
				config.columns.push({
					uuid,
					kind: "date",
					field: "date_opened",
					header: "Opened",
					pattern: "%d %b '%y",
				} as never);
				config.listColumnOrder.push(uuid);
				config.detailColumnOrder.push(uuid);
			}),
		check: (document) =>
			columns(document).some(
				(column) =>
					column?.kind === "date" && String(column.pattern).includes("'"),
			),
		witnesses: {
			steps: ["date-patterns"],
			blockers: [],
			reasons: ["date-pattern-apostrophe-replaced"],
		},
	},
	{
		id: "hand-tile-hidden-calculated-sort",
		holds:
			"a tile list holding a calculated column hidden from Results that carries an order rule",
		build: (base) =>
			produce(base("targeted-custom-tile"), (draft) => {
				const [menu] = draft.moduleOrder;
				const config =
					menu === undefined ? undefined : draft.modules[menu]?.caseListConfig;
				if (config === undefined) throw new Error("No case list.");
				const uuid = fixtureUuid(0x801);
				config.columns.push({
					uuid,
					kind: "calculated",
					header: "Order",
					expression: {
						kind: "term",
						term: { kind: "prop", caseType: "visit", property: "case_name" },
					},
					visibleInList: false,
					sort: { direction: "asc", priority: 0 },
				} as never);
				config.listColumnOrder.push(uuid);
				config.detailColumnOrder.push(uuid);
			}),
		check: (document) =>
			columns(document).some(
				(column) =>
					column?.kind === "calculated" &&
					column.visibleInList === false &&
					column.sort !== undefined,
			),
		witnesses: {
			steps: ["tile-hidden-calculated-sort"],
			blockers: [],
			reasons: ["tile-order-rule-removed"],
		},
	},
	{
		id: "hand-sort-property-ownership",
		holds: "two order rules over one property in one list",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const config = draft.modules[NAVIGATION.menu]?.caseListConfig;
				if (config === undefined) throw new Error("No case list.");
				const [first] = config.columns;
				if (first !== undefined) first.sort = { direction: "asc", priority: 0 };
				const uuid = fixtureUuid(0x901);
				config.columns.push({
					uuid,
					kind: "plain",
					field: "case_name",
					header: "Name again",
					sort: { direction: "desc", priority: 1 },
				} as never);
				config.listColumnOrder.push(uuid);
				config.detailColumnOrder.push(uuid);
			}),
		check: (document) => {
			const sorted = columns(document).filter(
				(column) => column?.sort !== undefined,
			);
			return (
				new Set(sorted.map((column) => column?.field)).size < sorted.length
			);
		},
		witnesses: {
			steps: ["sort-property-ownership"],
			blockers: [],
			reasons: [
				"order-rule-removed-same-property",
				"order-rule-moved-to-first-column",
			],
		},
	},
	{
		id: "hand-target-parse",
		holds:
			"an ordinary document, which a step that writes a slot no schema admits turns into a target that does not parse",
		build: (base) => base("navigation-base"),
		check: (document) => document.moduleOrder.length === 1,
		witnesses: { steps: [], blockers: ["target-parse"], reasons: [] },
	},
	{
		id: "hand-case-schema-change",
		holds:
			"an active stored case schema row that differs from the document's derivation",
		build: (base) => base("navigation-base"),
		storedSchemas: (derived) =>
			Object.fromEntries(
				Object.entries(derived).map(([name, schema], index) => [
					name,
					index === 0
						? {
								...(schema as object),
								properties: { notes: { type: "integer" } },
							}
						: schema,
				]),
			),
		check: (document) => document.moduleOrder.length === 1,
		witnesses: { steps: [], blockers: ["case-schema-change"], reasons: [] },
	},
	{
		id: "hand-unresolved-relative-path",
		holds:
			"a relative path in a text run that names a question the id rule renames and does not resolve through the form tree",
		build: (base) =>
			produce(base("targeted-invalid-question-ids"), (draft) => {
				const [menu] = draft.moduleOrder;
				const [form] = menu === undefined ? [] : (draft.formOrder[menu] ?? []);
				if (form === undefined) throw new Error("No form.");
				const uuid = fixtureUuid(0xa01);
				draft.fields[uuid] = {
					uuid,
					kind: "hidden",
					id: "echo",
					calculate: text("../../_notes"),
				} as never;
				draft.fieldOrder[form]?.push(uuid);
				draft.fieldParent[uuid] = form;
			}),
		check: (document) =>
			fields(document).some((field) =>
				parts(field.calculate).includes("../_notes"),
			),
		witnesses: {
			steps: [],
			blockers: ["unresolved-relative-path"],
			reasons: [],
		},
	},
	{
		id: "hand-link-identifier-reserved",
		holds: "a case operation link whose identifier is instance",
		build: (base) =>
			produce(base("case-operation-query"), (draft) => {
				for (const form of Object.values(draft.forms)) {
					for (const operation of form.caseOperations ?? []) {
						for (const link of (
							operation as { links?: { identifier: string }[] }
						).links ?? []) {
							if (link.identifier === "parent") link.identifier = "instance";
						}
					}
				}
			}),
		check: (document) =>
			operations(document).some((operation) =>
				list(operation?.links).some(
					(link) => record(link)?.identifier === "instance",
				),
			),
		witnesses: {
			steps: [],
			blockers: ["link-identifier-reserved"],
			reasons: [],
		},
	},
	{
		id: "hand-reserved-property-write",
		holds: "a Save to Case block writing a case property named instance",
		build: (base) =>
			produce(base("case-operation-query"), (draft) => {
				for (const form of Object.values(draft.forms)) {
					for (const operation of form.caseOperations ?? []) {
						for (const write of (
							operation as { writes?: { property: string }[] }
						).writes ?? []) {
							if (write.property === "source_id") write.property = "instance";
						}
					}
				}
				const visit = draft.caseTypes?.find((type) => type.name === "visit");
				const declared = visit?.properties.find(
					(property) => property.name === "source_id",
				);
				if (declared === undefined) throw new Error("No source_id property.");
				declared.name = "instance";
			}),
		check: (document) =>
			operations(document).some((operation) =>
				list(operation?.writes).some(
					(write) => record(write)?.property === "instance",
				),
			),
		witnesses: {
			steps: [],
			blockers: ["reserved-property-write", "target-gate"],
			reasons: [],
		},
	},
	{
		id: "hand-form-root-read",
		holds: "a calculate that reads the form's root alone, count(/data)",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const uuid = fixtureUuid(0xb01);
				draft.fields[uuid] = {
					uuid,
					kind: "hidden",
					id: "size",
					calculate: text("count(/data)"),
				} as never;
				draft.fieldOrder[NAVIGATION.register]?.push(uuid);
				draft.fieldParent[uuid] = NAVIGATION.register;
			}),
		check: (document) =>
			fields(document).some(
				(field) => parts(field.calculate) === "count(/data)",
			),
		witnesses: {
			steps: [],
			blockers: ["form-root-read", "target-gate"],
			reasons: [],
		},
	},
	{
		id: "hand-foreign-media",
		holds: "a form icon naming an uploaded asset its Project does not hold",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const form = draft.forms[NAVIGATION.visit];
				if (form === undefined) throw new Error("No Visit form.");
				(form as { icon?: string }).icon =
					"018f0000-0000-7000-8000-0000000a0002";
			}),
		check: (document) =>
			forms(document).some((form) => typeof form.icon === "string"),
		witnesses: {
			steps: [],
			blockers: ["target-export-readiness"],
			reasons: [],
		},
	},
	{
		id: "hand-time-ordering",
		holds:
			"a form-logic comparison of two times, and a follow-up form whose display condition orders a time property",
		build: (base) => withChecksMenu(base, false),
		check: (document) =>
			forms(document).some((form) =>
				displayConditionOrdersTime(form.displayCondition),
			),
		witnesses: {
			steps: ["time-ordering"],
			blockers: [],
			reasons: ["time-comparison-never-true"],
		},
	},
	{
		id: "hand-time-ordering-form-logic",
		holds: "form logic that orders two time questions",
		build: (base) => base("targeted-time-ordering"),
		check: (document) =>
			fields(document).some((field) => / < /.test(parts(field.relevant))),
		witnesses: {
			steps: ["time-ordering"],
			blockers: [],
			reasons: ["time-comparison-never-true"],
		},
	},
	{
		id: "hand-hidden-from-menu",
		holds:
			"a menu whose display condition orders two times, and a form whose display condition orders a time property",
		build: (base) => withChecksMenu(base, true),
		check: (document) =>
			modules(document).some((module) =>
				displayConditionOrdersTime(module.displayCondition),
			),
		witnesses: {
			steps: ["hidden-from-menu"],
			blockers: [],
			reasons: ["hidden-from-menu-set"],
		},
	},
	{
		id: "hand-hidden-menu-is-a-destination",
		holds:
			"a menu whose display condition orders two times, which a form link targets",
		build: (base) =>
			produce(withChecksMenu(base, true), (draft) => {
				const visit = draft.forms[NAVIGATION.visit];
				if (visit === undefined) throw new Error("No Visit form.");
				visit.formLinks = [
					{
						uuid: fixtureUuid(0xc11),
						target: { type: "module", moduleUuid: CHECKS.menu },
					},
				] as never;
			}),
		check: (document) =>
			forms(document).some((form) =>
				list(form.formLinks).some(
					(link) => record(record(link)?.target)?.moduleUuid === CHECKS.menu,
				),
			),
		witnesses: {
			steps: [],
			blockers: ["hidden-menu-is-a-destination"],
			reasons: [],
		},
	},
	{
		id: "hand-search-term-matches-nothing",
		holds: "a search's filter that asks whether date_opened is blank",
		build: (base) =>
			produce(base("targeted-search-hq-compile"), (draft) => {
				const menu = draft.moduleOrder.find(
					(uuid) => draft.modules[uuid]?.caseListConfig !== undefined,
				);
				const config =
					menu === undefined ? undefined : draft.modules[menu]?.caseListConfig;
				const caseType =
					menu === undefined ? undefined : draft.modules[menu]?.caseType;
				if (config === undefined || caseType === undefined)
					throw new Error("No searched list.");
				config.filter = {
					kind: "not",
					clause: {
						kind: "is-blank",
						left: {
							kind: "term",
							term: { kind: "prop", caseType, property: "date_opened" },
						},
					},
				} as never;
			}),
		check: (document) =>
			modules(document).some((module) =>
				JSON.stringify(record(module.caseListConfig)?.filter ?? null).includes(
					'"is-blank"',
				),
			),
		witnesses: {
			steps: ["time-ordering"],
			blockers: [],
			reasons: ["search-term-matches-nothing"],
		},
	},
	{
		id: "hand-validated-barcode-secret",
		holds: "a barcode question and a secret question, each with a validation",
		build: (base) => base("targeted-validated-barcode-secret"),
		check: (document) =>
			["barcode", "secret"].every((kind) =>
				fields(document).some(
					(field) => field.kind === kind && field.validate !== undefined,
				),
			),
		witnesses: {
			steps: [],
			blockers: [],
			reasons: ["validation-now-enforced"],
		},
	},
	{
		id: "hand-linked-follow-up",
		holds:
			"a write-free follow-up in a single-select menu that two after-submit links open, one with datums and one without, beside a follow-up with one write a link with datums opens",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const checkIn = fixtureUuid(0xd01);
				const note = fixtureUuid(0xd02);
				draft.forms[checkIn] = {
					uuid: checkIn,
					id: "check_in",
					name: "Check-in",
					type: "followup",
				} as never;
				draft.fields[note] = {
					uuid: note,
					kind: "text",
					id: "note",
					label: text("Note"),
				} as never;
				draft.formOrder[NAVIGATION.menu]?.push(checkIn);
				draft.fieldOrder[checkIn] = [note];
				draft.fieldParent[note] = checkIn;
				const datums = [{ name: "case_id", xpath: text("'explicit-patient'") }];
				const register = draft.forms[NAVIGATION.register];
				const visit = draft.forms[NAVIGATION.visit];
				if (register === undefined || visit === undefined)
					throw new Error("No forms.");
				register.formLinks = [
					{
						uuid: fixtureUuid(0xd11),
						condition: {
							parts: [
								{ kind: "user-ref", property: "username" },
								{ kind: "text", text: " = 'alice'" },
							],
						},
						target: {
							type: "form",
							moduleUuid: NAVIGATION.menu,
							formUuid: checkIn,
						},
						datums,
					},
					{
						uuid: fixtureUuid(0xd12),
						target: {
							type: "form",
							moduleUuid: NAVIGATION.menu,
							formUuid: NAVIGATION.visit,
						},
						datums,
					},
				] as never;
				visit.formLinks = [
					{
						uuid: fixtureUuid(0xd13),
						target: {
							type: "form",
							moduleUuid: NAVIGATION.menu,
							formUuid: checkIn,
						},
					},
				] as never;
			}),
		check: (document) =>
			forms(document).some((form) =>
				list(form.formLinks).some((link) => record(link)?.datums !== undefined),
			) &&
			forms(document).some((form) =>
				list(form.formLinks).some((link) => record(link)?.datums === undefined),
			),
		witnesses: {
			steps: [],
			blockers: [],
			reasons: [
				"follow-up-now-touches-case",
				"linked-follow-up-now-writes-case",
			],
		},
	},
	{
		id: "hand-close-conditions",
		holds: "close forms whose conditions the Case Management tab cannot state",
		build: (base) => base("targeted-close-conditions"),
		check: (document) =>
			forms(document).some((form) => form.closeCondition !== undefined),
		witnesses: {
			steps: [],
			blockers: [],
			reasons: ["close-moves-to-save-to-case"],
		},
	},
	{
		id: "hand-survey-menu",
		holds: "a menu with a case type whose forms are all surveys",
		build: (base) => base("targeted-survey-menu"),
		check: (document) =>
			document.moduleOrder.some((menu) => {
				const module = document.modules[menu];
				const menuForms = document.formOrder[menu] ?? [];
				return (
					typeof module?.caseType === "string" &&
					menuForms.length > 0 &&
					menuForms.every((form) => document.forms[form]?.type === "survey")
				);
			}),
		witnesses: {
			steps: [],
			blockers: [],
			reasons: ["survey-menu-takes-case-type"],
		},
	},
	{
		id: "hand-case-list-order",
		holds:
			"a row list holding a column hidden from Results that sorts, and a plain column over case_id",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				const config = draft.modules[NAVIGATION.menu]?.caseListConfig;
				if (config === undefined) throw new Error("No case list.");
				const hidden = fixtureUuid(0xe01);
				const record = fixtureUuid(0xe02);
				config.columns.push(
					{
						uuid: hidden,
						kind: "plain",
						field: "notes",
						header: "Notes",
						visibleInList: false,
						sort: { direction: "asc", priority: 0 },
					} as never,
					{
						uuid: record,
						kind: "plain",
						field: "case_id",
						header: "Record",
					} as never,
				);
				config.listColumnOrder.push(hidden, record);
				config.detailColumnOrder.push(hidden, record);
			}),
		check: (document) =>
			columns(document).some(
				(column) =>
					column?.visibleInList === false && column.sort !== undefined,
			) && columns(document).some((column) => column?.field === "case_id"),
		witnesses: {
			steps: [],
			blockers: [],
			reasons: [
				"case-list-order-changes",
				"case-list-search-matches-hidden-fields",
				"hidden-order-column-not-in-sort-menu",
				"record-id-column-now-shows",
			],
		},
	},
	{
		id: "hand-lookup-tag-collision",
		holds:
			"selects over tables whose tags hold casedb and ledgerdb, in a Project that holds every tag a rename could take for one of them",
		build: (base) => base("targeted-lookup-reserved-tags"),
		project: { lookup: reservedTagLookup() },
		check: (document) =>
			fields(document).some(
				(field) => record(field.optionsSource)?.kind === "lookup",
			),
		witnesses: {
			steps: [],
			blockers: ["lookup-tag-rename-collision", "lookup-tag-unparsable"],
			reasons: ["lookup-tag-renamed"],
		},
	},
	{
		id: "hand-logo",
		holds: "an app logo naming an uploaded image",
		build: (base) =>
			produce(base("navigation-base"), (draft) => {
				draft.logo = asMediaAssetId("018f0000-0000-7000-8000-0000000a0003");
			}),
		project: {
			media: {
				"018f0000-0000-7000-8000-0000000a0003": {
					kind: "image",
					mimeType: "image/png",
					extension: ".png",
					sizeBytes: 68,
					sha256: "a".repeat(64),
				},
			},
		},
		check: (document) => typeof document.logo === "string",
		witnesses: {
			steps: [],
			blockers: [],
			reasons: ["logo-upload-in-hq"],
		},
	},
	{
		id: "hand-xpath-query-input",
		holds:
			"a simple search input named _xpath_query beside the reserved include_closed",
		build: (base) =>
			produce(base("targeted-search-hq-compile"), (draft) => {
				const menu = draft.moduleOrder.find(
					(uuid) =>
						(draft.modules[uuid]?.caseListConfig?.searchInputs.length ?? 0) > 0,
				);
				const config =
					menu === undefined ? undefined : draft.modules[menu]?.caseListConfig;
				if (config === undefined) throw new Error("No search inputs.");
				config.searchInputs.push({
					uuid: fixtureUuid(0xf01),
					kind: "simple",
					label: "Query",
					name: "_xpath_query",
					property: "owner_id",
					type: "text",
				} as never);
			}),
		check: (document) =>
			modules(document).some((module) =>
				list(record(module.caseListConfig)?.searchInputs).some(
					(input) => record(input)?.name === "_xpath_query",
				),
			),
		witnesses: {
			steps: ["reserved-search-inputs"],
			blockers: [],
			reasons: ["search-input-renamed", "search-input-removed"],
		},
	},
	{
		id: "hand-open-workspace",
		holds: "an ordinary saved app, which a test opens private work over",
		build: (base) => base("navigation-base"),
		check: (document) => document.moduleOrder.length === 1,
		witnesses: {
			steps: [],
			blockers: [],
			reasons: ["unsaved-assistant-work-discarded"],
		},
	},
];
