import { z } from "zod";
import {
	formLinkProjectionContext,
	formLinkTargetDatumIds,
} from "@/lib/commcare/formLinkProjection";
import type { FormParseScope } from "@/lib/commcare/xpath/formParseScope";
import { parseAuthoredFormExpression } from "@/lib/doc/expressionText";
import { prepareFormRecordName } from "@/lib/doc/formRecordName";
import {
	type BlueprintDoc,
	caseWriteSchema,
	fieldKinds,
	formLinkTargetSchema,
	formRootFieldIds,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import {
	type FormStructure,
	type FormStructureChoices,
	type FormStructureConnect,
	type FormStructureField,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import {
	type Expression,
	type FieldExpressionSlotRef,
	type FormExpressionSlotRef,
	formLinkDatumNameSchema,
} from "@/lib/domain/expression/types";
import { formEntrySchema } from "@/lib/domain/forms";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	expressionSlotKey,
	expressionSlotValue,
} from "@/lib/domain/referenceSlots";
import { catalogFieldDefaults } from "../contentProcessing";
import {
	type ConnectIdDraft,
	connectIdsInConfig,
	planConnectIds,
	reserveExplicitConnectIds,
} from "../tools/shared/connectIds";
import type { ToolInvocationContext } from "../workspace/types";
import { AuthoringInputError } from "./errors";
import type { AuthoringPath } from "./schema";
import { printAuthoringText } from "./text";

type Input = Record<string, unknown>;
type FormSlot = FieldExpressionSlotRef | FormExpressionSlotRef;
const object = z.record(z.string(), z.unknown());
const objects = z.array(object);
const connectKinds = [
	"learn_module",
	"assessment",
	"deliver_unit",
	"task",
] as const;
const pathKey = (path: AuthoringPath) => JSON.stringify(path);

/** Catalog defaults become ordinary authored input before the one creation
 * allocation pass. Execution consumes the same option identities afterward. */
export function stageFieldDefaults(
	toolName: string,
	input: Input,
	doc: BlueprintDoc,
): void {
	if (toolName !== "addFields") return;
	input.fields = objects.parse(input.fields).map((field) => {
		const defaults = catalogFieldDefaults(field, doc.caseTypes ?? []);
		return {
			...field,
			...(defaults.kind === undefined ? {} : { kind: defaults.kind }),
			...(defaults.label === undefined
				? {}
				: { label: printAuthoringText(defaults.label, doc) }),
			...(defaults.options === undefined
				? {}
				: {
						optionsSource: {
							kind: "inline",
							options: defaults.options.map((option) => ({
								value: option.value,
								label: printAuthoringText(option.label, doc),
							})),
						},
					}),
		};
	});
}

function structuralConnect(
	raw: Input,
	previous: FormStructureConnect,
	replace: boolean,
): ConnectIdDraft {
	const result: ConnectIdDraft = replace ? {} : { ...previous };
	for (const kind of connectKinds) {
		if (raw[kind] === null) delete result[kind];
		if (raw[kind] == null) continue;
		const block = object.parse(raw[kind]);
		const id = z.string().nullish().parse(block.id) ?? previous[kind]?.id;
		result[kind] = id === undefined ? {} : { id };
	}
	return result;
}

/** Finalize every Connect identity before reading one authored expression.
 * The shared ID planner also validates those explicit IDs during execution. */
function stageConnect(
	toolName: string,
	input: Input,
	doc: BlueprintDoc,
): Map<Uuid, FormStructureConnect> {
	const result = new Map<Uuid, FormStructureConnect>();
	const mode =
		toolName === "configureConnect"
			? z.enum(["learn", "deliver"]).nullable().parse(input.mode)
			: doc.connectType;
	if (mode === null) return result;
	const candidates: {
		form: FormStructure;
		raw: Input;
		draft: ConnectIdDraft;
	}[] = [];
	if (toolName === "configureConnect") {
		const requested = new Map(
			objects
				.parse(input.participants ?? [])
				.map((item) => [uuidSchema.parse(item.formUuid), item]),
		);
		for (const moduleUuid of doc.moduleOrder)
			for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
				const participant = requested.get(formUuid);
				if (participant === undefined) continue;
				const form = formStructure(doc, formUuid);
				if (form === undefined)
					throw new AuthoringInputError(
						"This Connect form is no longer in the app.",
					);
				const raw = object.parse(participant.connect);
				participant.connect = raw;
				const previous = doc.forms[formUuid]?.connect ?? {};
				candidates.push({
					form,
					raw,
					draft: structuralConnect(raw, previous, true),
				});
			}
		// Preserve the original participant objects after zod's structural reads.
		input.participants = [...requested.values()];
	} else if (toolName === "updateForm" && input.connect != null) {
		const form = formStructure(doc, uuidSchema.parse(input.formUuid));
		if (form === undefined)
			throw new AuthoringInputError(
				"This Connect form is no longer in the app.",
			);
		const raw = object.parse(input.connect);
		input.connect = raw;
		candidates.push({
			form,
			raw,
			draft: structuralConnect(
				raw,
				doc.forms[form.formUuid]?.connect ?? {},
				false,
			),
		});
	}
	const replacing = new Set(candidates.map(({ form }) => form.formUuid));
	const taken = new Set<string>();
	if (toolName !== "configureConnect")
		for (const saved of Object.values(doc.forms)) {
			if (!replacing.has(saved.uuid) && saved.connect !== undefined)
				for (const id of connectIdsInConfig(saved.connect)) taken.add(id);
		}
	for (const { form, draft } of candidates) {
		const errors = reserveExplicitConnectIds(
			draft,
			taken,
			formRootFieldIds(doc, form.formUuid),
		);
		if (errors.length) throw new AuthoringInputError(errors.join("; "));
	}
	for (const { form, raw, draft } of candidates) {
		const local = new Set(taken);
		for (const id of connectIdsInConfig(draft)) local.delete(id);
		const planned = planConnectIds(
			draft,
			mode,
			doc.modules[form.moduleUuid]?.name ?? "",
			doc.forms[form.formUuid]?.name ?? "",
			local,
			formRootFieldIds(doc, form.formUuid),
		);
		if (!planned.ok) throw new AuthoringInputError(planned.error);
		for (const kind of connectKinds) {
			const block = planned.config[kind];
			if (block === undefined) continue;
			if (raw[kind] != null)
				raw[kind] = { ...object.parse(raw[kind]), id: block.id };
			taken.add(block.id);
		}
		result.set(form.formUuid, planned.config);
	}
	return result;
}

function choices(
	raw: unknown,
	previous?: FormStructureChoices,
): FormStructureChoices | undefined {
	if (raw === undefined) return previous;
	if (raw === null) return undefined;
	const source = object.parse(raw);
	if (source.kind === "inline")
		return {
			kind: "inline",
			options: objects.parse(source.options).map((option) => ({
				uuid: uuidSchema.parse(option.optionUuid),
				value: z.string().parse(option.value),
			})),
		};
	if (source.kind === "cases")
		return { kind: "cases", caseType: z.string().parse(source.caseType) };
	if (source.kind === "lookup")
		return {
			kind: "lookup",
			tableId: lookupTableIdSchema.parse(source.tableId),
		};
	throw new AuthoringInputError(
		"Choose an inline, case, or table choice source.",
	);
}

function fieldDeclaration(
	raw: Input,
	uuid: Uuid,
	parent: Uuid,
	previous?: FormStructureField,
): FormStructureField {
	const repeat = raw.repeat == null ? undefined : object.parse(raw.repeat);
	const prose = new Set(previous?.proseSlots ?? []);
	for (const slot of ["label", "hint", "help"] as const) {
		if (raw[slot] === null) prose.delete(slot);
		else if (raw[slot] !== undefined) prose.add(slot);
	}
	if (raw.validate === null) prose.delete("validate_msg");
	else if (raw.validate != null && object.parse(raw.validate).msg !== undefined)
		prose.add("validate_msg");
	const choice = choices(raw.optionsSource, previous?.choices);
	const caseWrite =
		raw.caseWrite === undefined
			? previous?.caseWrite
			: raw.caseWrite === null
				? undefined
				: caseWriteSchema.parse(raw.caseWrite);
	const kind = z.enum(fieldKinds).parse(raw.kind ?? previous?.kind);
	return {
		uuid,
		parent,
		kind,
		id: z.string().parse(raw.id ?? previous?.id),
		...(caseWrite === undefined ? {} : { caseWrite }),
		...(kind !== "repeat"
			? {}
			: {
					repeatMode: z
						.enum(["user_controlled", "count_bound", "query_bound"])
						.parse(repeat?.mode ?? previous?.repeatMode ?? "user_controlled"),
				}),
		...(choice === undefined ? {} : { choices: choice }),
		proseSlots: [...prose],
	};
}

function fieldSlot(
	uuid: Uuid,
	path: AuthoringPath,
): FieldExpressionSlotRef | undefined {
	if (
		path.length === 1 &&
		["relevant", "calculate", "default_value", "required"].includes(
			String(path[0]),
		)
	)
		return {
			entity: "field",
			uuid,
			slot: path[0] as "relevant" | "calculate" | "default_value" | "required",
		};
	if (path[0] === "validate" && path[1] === "expr")
		return { entity: "field", uuid, slot: "validate" };
	if (path[0] === "repeat" && path[1] === "count")
		return { entity: "field", uuid, slot: "repeat_count" };
	if (path[0] === "repeat" && path[1] === "ids_query")
		return { entity: "field", uuid, slot: "ids_query" };
	return undefined;
}

/** A call-local declaration view, never an incomplete document. It carries
 * final identities and memoizes the production parser for pending slots. */
export function prepareFormAuthoring(args: {
	toolName: string;
	input: Input;
	ctx: ToolInvocationContext;
	formUuid?: Uuid;
	authoringAt(path: AuthoringPath): FormParseScope["authoring"];
	lookup(): LookupDefinitionIndex;
}) {
	const { toolName, input, ctx } = args;
	const doc = ctx.snapshot.doc;
	const formUuid = args.formUuid;
	const connect = stageConnect(toolName, input, doc);
	const forms = new Map<Uuid, FormStructure>();
	const sources = new Map<
		string,
		{ slot: FormSlot; path: AuthoringPath; source: string }
	>();
	const paths = new Map<string, FormSlot>();
	const parsed = new Map<string, Expression | undefined>();
	const visiting = new Set<string>();
	if (toolName === "editField") {
		const uuid = uuidSchema.parse(input.fieldUuid);
		const updates = object.parse(input.updates);
		for (const slot of [
			"relevant",
			"calculate",
			"default_value",
			"required",
			"validate",
		] as const)
			if (updates[slot] === null)
				parsed.set(
					expressionSlotKey({ entity: "field", uuid, slot }),
					undefined,
				);
		if (updates.repeat != null) {
			const repeat = object.parse(updates.repeat);
			for (const [mode, slot] of [
				["count_bound", "repeat_count"],
				["query_bound", "ids_query"],
			] as const)
				if (repeat.mode !== mode)
					parsed.set(
						expressionSlotKey({ entity: "field", uuid, slot }),
						undefined,
					);
		}
	}
	const connectInputs =
		toolName === "configureConnect"
			? objects.parse(input.participants ?? []).map((item) => ({
					uuid: uuidSchema.parse(item.formUuid),
					raw: object.parse(item.connect),
				}))
			: toolName === "updateForm" &&
					input.connect != null &&
					formUuid !== undefined
				? [{ uuid: formUuid, raw: object.parse(input.connect) }]
				: [];
	for (const { uuid, raw } of connectInputs)
		for (const [block, member, slot] of [
			["assessment", "user_score", "assessment_user_score"],
			["deliver_unit", "entity_id", "deliver_entity_id"],
			["deliver_unit", "entity_name", "deliver_entity_name"],
		] as const) {
			const value =
				raw[block] == null ? raw[block] : object.parse(raw[block])[member];
			if (
				value === null ||
				(toolName === "configureConnect" && value === undefined)
			)
				parsed.set(
					expressionSlotKey({ entity: "form", uuid, slot }),
					undefined,
				);
		}
	const recordName =
		toolName === "updateForm" &&
		input.recordName !== undefined &&
		formUuid !== undefined
			? prepareFormRecordName(doc, formUuid)
			: undefined;
	if (recordName !== undefined) {
		ctx.preparedRecordNames ??= new Map();
		ctx.preparedRecordNames.set(expressionSlotKey(recordName.slot), recordName);
	}
	function read(slot: FormSlot): Expression | undefined {
		const key = expressionSlotKey(slot);
		if (parsed.has(key)) return parsed.get(key);
		const pending = sources.get(key);
		if (pending === undefined) return expressionSlotValue(doc, slot);
		if (visiting.has(key))
			throw new AuthoringInputError(
				`The expression at ${pending.path.join(".")} depends on itself while binding its form context.`,
			);
		visiting.add(key);
		try {
			const form =
				slot.entity === "form"
					? forms.get(slot.uuid)
					: [...forms.values()].find((form) => form.fields.has(slot.uuid));
			const value = parseAuthoredFormExpression(
				{
					doc,
					slot,
					lookup: args.lookup(),
					current: expressionSlotValue(doc, slot),
					form,
					authoring: args.authoringAt(pending.path),
				},
				pending.source,
			);
			parsed.set(key, value);
			return value;
		} finally {
			visiting.delete(key);
		}
	}
	function ensure(uuid: Uuid): FormStructure {
		const prior = forms.get(uuid);
		if (prior !== undefined) return prior;
		const saved =
			recordName?.form.formUuid === uuid
				? recordName.form
				: formStructure(doc, uuid);
		if (saved === undefined)
			throw new AuthoringInputError(
				"This expression's form is no longer in the app.",
			);
		const fields = new Map(saved.fields);
		const order = new Map<Uuid, readonly Uuid[]>(
			[...saved.fieldOrder].map(([owner, children]) => [owner, [...children]]),
		);
		if (uuid === formUuid && toolName === "addFields") {
			const additions = objects.parse(input.fields);
			const ids = new Set(
				additions.map((item) => uuidSchema.parse(item.fieldUuid)),
			);
			const top = new Map<Uuid, Uuid[]>();
			for (const item of additions) {
				const id = uuidSchema.parse(item.fieldUuid);
				const parent = uuidSchema.parse(
					item.parentUuid ?? input.parentUuid ?? uuid,
				);
				fields.set(id, fieldDeclaration(item, id, parent));
				if (ids.has(parent))
					order.set(parent, [...(order.get(parent) ?? []), id]);
				else {
					const siblings = top.get(parent) ?? [];
					siblings.push(id);
					top.set(parent, siblings);
				}
				if (
					!order.has(id) &&
					["group", "section", "repeat"].includes(String(item.kind))
				)
					order.set(id, []);
			}
			for (const [parent, added] of top) {
				const siblings = [...(order.get(parent) ?? [])];
				const before =
					input.beforeFieldUuid === undefined
						? -1
						: siblings.indexOf(uuidSchema.parse(input.beforeFieldUuid));
				const after =
					input.afterFieldUuid === undefined
						? -1
						: siblings.indexOf(uuidSchema.parse(input.afterFieldUuid));
				siblings.splice(
					before >= 0 ? before : after >= 0 ? after + 1 : siblings.length,
					0,
					...added,
				);
				order.set(parent, siblings);
			}
		} else if (
			uuid === formUuid &&
			(toolName === "editField" || toolName === "setFieldOptionsSource")
		) {
			const id = uuidSchema.parse(input.fieldUuid);
			const previous = fields.get(id);
			if (previous === undefined)
				throw new AuthoringInputError("This field is no longer in the form.");
			const raw =
				toolName === "editField"
					? object.parse(input.updates)
					: { optionsSource: input.source };
			fields.set(id, fieldDeclaration(raw, id, previous.parent, previous));
		}
		const links = new Map(saved.links);
		if (
			uuid === formUuid &&
			(toolName === "addFormLinks" || toolName === "updateFormLink")
		) {
			const additions =
				toolName === "addFormLinks"
					? objects.parse(input.links)
					: [{ linkUuid: input.linkUuid, link: input.link }];
			const projection = formLinkProjectionContext(doc, {
				entryMetadataOnly: true,
			});
			for (const item of additions) {
				const link = object.parse(item.link);
				const target = formLinkTargetSchema.parse(link.target);
				const targetNames = formLinkTargetDatumIds(doc, projection, target);
				const datums = objects.parse(link.datums ?? []).map((datum) => {
					if (typeof datum.name !== "string")
						return formLinkDatumNameSchema.parse(datum.name);
					const matches = targetNames.filter(
						(row) => row.id === datum.name && row.scalar,
					);
					const ref =
						matches.length === 1
							? matches[0].refs.find((ref) => ref.kind === "selected-case")
							: undefined;
					if (ref === undefined)
						throw new AuthoringInputError(
							`The target does not read a selection named ${datum.name}.`,
						);
					return ref;
				});
				links.set(uuidSchema.parse(item.linkUuid), { target, datums });
			}
		}
		const result: FormStructure = {
			...saved,
			...(uuid !== formUuid ||
			toolName !== "updateForm" ||
			input.entry === undefined
				? {}
				: {
						entry:
							input.entry === null
								? undefined
								: formEntrySchema.parse({
										...object.parse(input.entry),
										...(object.parse(input.entry).label === null
											? { label: undefined }
											: {}),
									}),
					}),
			fields,
			fieldOrder: order,
			links,
			connect: connect.get(uuid) ?? saved.connect,
			expressionAt: read,
		};
		forms.set(uuid, result);
		return result;
	}
	if (formUuid !== undefined && doc.forms[formUuid] !== undefined)
		ensure(formUuid);
	for (const uuid of connect.keys()) ensure(uuid);

	function slotAt(path: AuthoringPath): FormSlot | undefined {
		if (
			toolName === "addFields" &&
			path[0] === "fields" &&
			typeof path[1] === "number"
		)
			return fieldSlot(
				uuidSchema.parse(objects.parse(input.fields)[path[1]].fieldUuid),
				path.slice(2),
			);
		if (toolName === "editField" && path[0] === "updates")
			return fieldSlot(uuidSchema.parse(input.fieldUuid), path.slice(1));
		if (toolName === "updateForm" && path[0] === "recordName")
			return recordName?.slot;
		let owner = formUuid;
		let local = path;
		if (
			toolName === "configureConnect" &&
			path[0] === "participants" &&
			typeof path[1] === "number"
		) {
			owner = uuidSchema.parse(
				objects.parse(input.participants)[path[1]].formUuid,
			);
			local = path.slice(2);
		}
		if (owner === undefined) return undefined;
		if (local[0] === "connect") {
			if (local[1] === "assessment" && local[2] === "user_score")
				return { entity: "form", uuid: owner, slot: "assessment_user_score" };
			if (local[1] === "deliver_unit" && local[2] === "entity_id")
				return { entity: "form", uuid: owner, slot: "deliver_entity_id" };
			if (local[1] === "deliver_unit" && local[2] === "entity_name")
				return { entity: "form", uuid: owner, slot: "deliver_entity_name" };
		}
		let linkUuid: Uuid | undefined;
		if (
			toolName === "addFormLinks" &&
			path[0] === "links" &&
			typeof path[1] === "number"
		) {
			linkUuid = uuidSchema.parse(objects.parse(input.links)[path[1]].linkUuid);
			local = path.slice(3);
		} else if (toolName === "updateFormLink" && path[0] === "link") {
			linkUuid = uuidSchema.parse(input.linkUuid);
			local = path.slice(1);
		}
		if (linkUuid !== undefined) {
			if (local[0] === "condition")
				return {
					entity: "form",
					uuid: owner,
					slot: "form_link_condition",
					member: { linkUuid },
				};
			if (local[0] === "datums" && typeof local[1] === "number") {
				const datum = forms.get(owner)?.links.get(linkUuid)?.datums[local[1]];
				if (datum !== undefined)
					return {
						entity: "form",
						uuid: owner,
						slot: "form_link_datum_xpath",
						member: { linkUuid, datum },
					};
			}
		}
		return undefined;
	}
	return {
		forms,
		register(value: unknown, path: AuthoringPath) {
			const slot = slotAt(path);
			if (slot === undefined)
				throw new AuthoringInputError(
					`The expression at ${path.join(".")} has no evaluating slot.`,
				);
			const raw = z.union([z.string(), z.boolean()]).parse(value);
			const source =
				typeof raw === "boolean" ? (raw ? "true()" : "false()") : raw;
			paths.set(pathKey(path), slot);
			sources.set(expressionSlotKey(slot), { slot, path, source });
		},
		parse(path: AuthoringPath) {
			const slot = paths.get(pathKey(path));
			if (slot === undefined)
				throw new AuthoringInputError(
					`The expression at ${path.join(".")} was not prepared.`,
				);
			const result = read(slot);
			if (result !== undefined) return result;
			if (
				[
					"recordName",
					"count",
					"ids_query",
					"user_score",
					"xpath",
					"expr",
				].includes(String(path.at(-1)))
			)
				throw new AuthoringInputError(
					`The expression at ${path.join(".")} cannot be empty.`,
				);
			return toolName === "editField" || toolName === "updateForm"
				? null
				: undefined;
		},
		datum(path: AuthoringPath) {
			const slot = slotAt(path);
			if (slot?.entity !== "form" || slot.slot !== "form_link_datum_xpath")
				throw new AuthoringInputError(
					`The datum at ${path.join(".")} has no target.`,
				);
			return slot.member.datum;
		},
	};
}
