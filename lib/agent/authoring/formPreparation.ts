import { produce } from "immer";
import { z } from "zod";
import { formLinkProjectionContext } from "@/lib/commcare/formLinkProjection";
import type { FormParseScope } from "@/lib/commcare/xpath/formParseScope";
import { parseAuthoredFormExpression } from "@/lib/doc/expressionText";
import {
	applyFormEntryChange,
	formEntryChangeSchema,
} from "@/lib/doc/formEntryMutations";
import { namedFormLinkTargetDatums } from "@/lib/doc/formLinkReview";
import { prepareFormRecordName } from "@/lib/doc/formRecordName";
import {
	type BlueprintDoc,
	type FormType,
	fieldKinds,
	formLinkTargetSchema,
	formTypeLabels,
	moduleUuidOfForm,
	resolveFormLinkTarget,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { newFormSelectionTag } from "@/lib/domain/advancedEntryDatums";
import { literal, term } from "@/lib/domain/expression/builders";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import {
	type FormStructure,
	type FormStructureChoices,
	type FormStructureField,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import {
	type Expression,
	type FieldExpressionSlotRef,
	type FormExpressionSlotRef,
	formLinkDatumNameSchema,
	formLinkSelectionName,
} from "@/lib/domain/expression/types";
import { androidAppInputMember } from "@/lib/domain/fields/androidApp";
import { formRootNameSchema } from "@/lib/domain/formAnswerRoot";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { rowTimingSchema } from "@/lib/domain/queryRepeatPlacement";
import {
	expressionSlotKey,
	expressionSlotValue,
	FORM_REFERENCE_SLOTS,
} from "@/lib/domain/referenceSlots";
import { catalogFieldDefaults } from "../contentProcessing";
import type { ToolInvocationContext } from "../workspace/types";
import { AuthoringInputError } from "./errors";
import type { AuthoringPath } from "./schema";
import { printAuthoringText } from "./text";

const activityKind = z.enum([
	"learning-module",
	"assessment",
	"delivery",
	"assigned-task",
]);
const activitySlots = {
	score: "assessment_user_score",
	entityId: "deliver_entity_id",
	entityName: "deliver_entity_name",
	workAreaId: "deliver_work_area_id",
} as const satisfies Record<string, FieldExpressionSlotRef["slot"]>;

type Input = Record<string, unknown>;
type FormSlot = FieldExpressionSlotRef | FormExpressionSlotRef;
const object = z.record(z.string(), z.unknown());
const objects = z.array(object);
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
	if (source.kind === "available-cases") return { kind: "available-cases" };
	if (source.kind === "lookup")
		return {
			kind: "lookup",
			tableId: lookupTableIdSchema.parse(source.tableId),
		};
	throw new AuthoringInputError(
		"Choose an inline, case, all available cases, or table choice source.",
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
	for (const slot of [
		"label",
		"hint",
		"help",
		"addFirstLabel",
		"addLabel",
	] as const) {
		if (raw[slot] === null) prose.delete(slot);
		else if (raw[slot] !== undefined) prose.add(slot);
	}
	if (raw.validate === null) prose.delete("validate_msg");
	else if (raw.validate != null && object.parse(raw.validate).msg !== undefined)
		prose.add("validate_msg");
	const choice = choices(raw.optionsSource, previous?.choices);
	const kind = z.enum(fieldKinds).parse(raw.kind ?? previous?.kind);
	return {
		uuid,
		parent,
		kind,
		id: z.string().parse(raw.id ?? previous?.id),
		...(kind === "connect_activity" && {
			activityKind: activityKind.parse(
				raw.activity === undefined
					? previous?.activityKind
					: object.parse(raw.activity).kind,
			),
		}),
		...(kind !== "repeat"
			? {}
			: {
					...(repeat?.when === undefined
						? { rowTiming: previous?.rowTiming }
						: {
								rowTiming:
									rowTimingSchema.nullish().parse(repeat.when) ?? undefined,
							}),
					...(previous?.heldQueryPlacement === undefined
						? {}
						: { heldQueryPlacement: previous.heldQueryPlacement }),
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
	field: Input,
): FieldExpressionSlotRef | undefined {
	if (
		path[0] === "androidApp" &&
		path[1] === "send" &&
		typeof path[2] === "number" &&
		path[3] === "value"
	) {
		const inputs = objects.parse(object.parse(field.androidApp).send);
		return {
			entity: "field",
			uuid,
			slot: "android_app_input",
			member: androidAppInputMember(inputs, path[2]),
		};
	}
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
	if (path.length === 2 && path[0] === "activity") {
		for (const [member, slot] of Object.entries(activitySlots))
			if (path[1] === member) return { entity: "field", uuid, slot };
	}
	if (path[0] === "validate" && path[1] === "expr")
		return { entity: "field", uuid, slot: "validate" };
	if (path[0] === "repeat" && path[1] === "count")
		return { entity: "field", uuid, slot: "repeat_count" };
	if (path[0] === "repeat" && path[1] === "ids_query")
		return { entity: "field", uuid, slot: "ids_query" };
	return undefined;
}

/**
 * The document an `updateForm` call's expressions bind against: where the
 * call sets or clears the form's registration from the case list, the
 * module's slot as the call leaves it, so a `#search/` read in the same call
 * resolves exactly where the committed form will resolve it.
 */
function withPendingCaseListRegistration(
	toolName: string,
	input: Input,
	doc: BlueprintDoc,
	formUuid: Uuid | undefined,
): BlueprintDoc {
	if (
		toolName !== "updateForm" ||
		formUuid === undefined ||
		input.case_list_registration === undefined
	)
		return doc;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (moduleUuid === undefined || module === undefined) return doc;
	const { caseListRegistrationForm: current, ...rest } = module;
	if (input.case_list_registration === null)
		return current?.kind === "after-empty-search" &&
			current.formUuid === formUuid
			? { ...doc, modules: { ...doc.modules, [moduleUuid]: rest } }
			: doc;
	const label = object.parse(input.case_list_registration).label;
	return {
		...doc,
		modules: {
			...doc.modules,
			[moduleUuid]: {
				...rest,
				caseListRegistrationForm: {
					kind: "after-empty-search",
					formUuid,
					...(typeof label === "string" && { label }),
				},
			},
		},
	};
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
	const formUuid = args.formUuid;
	const baseline = withPendingCaseListRegistration(
		toolName,
		input,
		ctx.snapshot.doc,
		formUuid,
	);
	// Read an incoming formula in its final ordered slot. Its value isn't
	// needed to bind references; earlier choices and their identities are.
	let doc = baseline;
	let incomingSlot: FormSlot | undefined;
	if (toolName === "editFormEntry" && formUuid) {
		const edit = structuredClone(object.parse(input.edit));
		if (
			edit.operation === "add-choice" ||
			edit.operation === "edit-choice" ||
			edit.operation === "add-value" ||
			edit.operation === "edit-value"
		) {
			const adding =
				edit.operation === "add-choice" || edit.operation === "add-value";
			const field = adding ? "value" : "patch";
			const row = object.parse(edit[field]);
			const choice =
				edit.operation === "add-choice" || edit.operation === "edit-choice";
			if (choice && adding)
				row.tag = newFormSelectionTag(
					doc,
					formUuid,
					z.string().parse(row.name),
				);
			if (choice && row.source != null) {
				const source = object.parse(row.source);
				if (source.kind === "expression")
					row.source = { ...source, value: term(literal("")) };
			}
			if (!choice && row.value !== undefined) row.value = term(literal(""));
			edit[field] = row;
			const change = formEntryChangeSchema.parse(edit);
			doc = produce(doc, (draft) =>
				applyFormEntryChange(draft, formUuid, change),
			);
			const supplyUuid = uuidSchema.parse(adding ? row.uuid : edit.uuid);
			incomingSlot = {
				entity: "form",
				uuid: formUuid,
				slot: choice ? "form_selection_source" : "form_entry_value",
				member: { supplyUuid },
			};
		}
	}
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
		if (updates.activity !== undefined) {
			const activity = object.parse(updates.activity);
			for (const [member, slot] of Object.entries(activitySlots))
				if (activity[member] === undefined)
					parsed.set(
						expressionSlotKey({ entity: "field", uuid, slot }),
						undefined,
					);
		}
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
		} else if (uuid === formUuid && toolName === "setFormSections") {
			/* The form as the partition leaves it: each page at the form's
			 * root in the order given, a new page declared under the identity
			 * the call's identity pass gave it, and each named question under
			 * its page. A question the form does not hold is the planner's to
			 * refuse. */
			const sections = objects.parse(input.sections);
			if (sections.length > 0) {
				const pages: Uuid[] = [];
				for (const [index, section] of sections.entries()) {
					const page = uuidSchema.parse(section.sectionUuid);
					const previous = fields.get(page);
					fields.set(
						page,
						fieldDeclaration(
							previous === undefined
								? {
										kind: "section",
										id: `section_${index + 1}`,
										label: section.label,
									}
								: { label: section.label },
							page,
							uuid,
							previous,
						),
					);
					const members = z
						.array(uuidSchema)
						.parse(section.fields)
						.filter((member) => fields.has(member));
					for (const member of members) {
						const field = fields.get(member);
						if (field !== undefined)
							fields.set(member, { ...field, parent: page });
					}
					order.set(page, members);
					pages.push(page);
				}
				order.set(uuid, pages);
			}
		}
		const links = new Map(saved.links);
		const otherwiseLink =
			toolName === "setFormOtherwise" &&
			input.otherwise !== null &&
			typeof input.otherwise === "object" &&
			object.parse(input.otherwise).kind === "link"
				? object.parse(input.otherwise)
				: undefined;
		if (
			uuid === formUuid &&
			(toolName === "addFormLinks" ||
				toolName === "updateFormLink" ||
				otherwiseLink !== undefined)
		) {
			const additions =
				toolName === "addFormLinks"
					? objects.parse(input.links)
					: otherwiseLink !== undefined
						? [{ linkUuid: otherwiseLink.linkUuid, link: otherwiseLink }]
						: [{ linkUuid: input.linkUuid, link: input.link }];
			const projection = formLinkProjectionContext(doc, {
				entryMetadataOnly: true,
			});
			for (const item of additions) {
				const link = object.parse(item.link);
				const target = formLinkTargetSchema.parse(link.target);
				const resolved = resolveFormLinkTarget(doc, uuid, target);
				const targetNames =
					resolved === undefined
						? []
						: namedFormLinkTargetDatums(doc, projection, resolved);
				const datums = objects.parse(link.datums ?? []).map((datum) => {
					if (typeof datum.name !== "string")
						return formLinkDatumNameSchema.parse(datum.name);
					const matches = targetNames.filter(
						(row) =>
							(row.id === datum.name || row.name === datum.name) && row.scalar,
					);
					const ref =
						matches.length === 1
							? formLinkSelectionName(matches[0].refs)
							: undefined;
					if (ref === undefined)
						throw new AuthoringInputError(
							`The target does not read a selection named ${datum.name}.`,
						);
					return ref;
				});
				links.set(uuidSchema.parse(item.linkUuid), {
					target,
					datums,
					...(otherwiseLink !== undefined && { role: "otherwise" as const }),
				});
			}
		}
		const result: FormStructure = {
			...saved,
			...(toolName === "updateForm" &&
				uuid === formUuid &&
				input.answerRoot !== undefined && {
					dataRootName:
						input.answerRoot === null
							? undefined
							: formRootNameSchema.parse(input.answerRoot),
				}),
			fields,
			fieldOrder: order,
			links,
			expressionAt: read,
		};
		forms.set(uuid, result);
		return result;
	}
	if (formUuid !== undefined && doc.forms[formUuid] !== undefined)
		ensure(formUuid);

	/* An open or close condition has no evaluation context on a form type
	 * that does not create or close its own case, so its text cannot be read
	 * there. Say what the commit gate says of the stored condition
	 * (`OPEN_CONDITION_WRONG_TYPE`, `CLOSE_CONDITION_WRONG_TYPE`) rather than
	 * a reading failure no expression could fix. */
	function refuseOwnCaseConditionOffType(slot: FormSlot): void {
		if (
			slot.entity !== "form" ||
			(slot.slot !== "form_open_condition" &&
				slot.slot !== "form_close_condition")
		)
			return;
		const form = doc.forms[slot.uuid];
		const allowed: readonly FormType[] | undefined = FORM_REFERENCE_SLOTS.find(
			(entry) => entry.slot === slot.slot,
		)?.formTypes;
		if (
			form === undefined ||
			allowed === undefined ||
			allowed.includes(form.type)
		)
			return;
		const typeName = formTypeLabels[form.type].toLowerCase();
		throw new AuthoringInputError(
			slot.slot === "form_open_condition"
				? `Only a registration form creates its case on a condition, and “${form.name}” is a ${typeName} form. You can leave open_condition out, or make it a registration form.`
				: `Only registration and close forms close their own case, and “${form.name}” is a ${typeName} form. You can leave close_condition out, or make it a close form.`,
		);
	}

	function slotAt(path: AuthoringPath): FormSlot | undefined {
		if (
			toolName === "editFormEntry" &&
			path[0] === "edit" &&
			path.at(-1) === "value"
		)
			return incomingSlot;
		if (
			toolName === "addFields" &&
			path[0] === "fields" &&
			typeof path[1] === "number"
		)
			return fieldSlot(
				uuidSchema.parse(objects.parse(input.fields)[path[1]].fieldUuid),
				path.slice(2),
				objects.parse(input.fields)[path[1]],
			);
		if (toolName === "editField" && path[0] === "updates")
			return fieldSlot(
				uuidSchema.parse(input.fieldUuid),
				path.slice(1),
				object.parse(input.updates),
			);
		if (toolName === "updateForm" && path[0] === "recordName")
			return recordName?.slot;
		if (
			toolName === "updateForm" &&
			path[0] === "close_condition" &&
			formUuid !== undefined
		)
			return { entity: "form", uuid: formUuid, slot: "form_close_condition" };
		if (
			toolName === "updateForm" &&
			path[0] === "open_condition" &&
			formUuid !== undefined
		)
			return { entity: "form", uuid: formUuid, slot: "form_open_condition" };
		const owner = formUuid;
		if (owner === undefined) return undefined;
		let local = path;
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
		} else if (toolName === "setFormOtherwise" && path[0] === "otherwise") {
			// The otherwise link has no condition slot, only carried values.
			if (path[1] !== "datums") return undefined;
			linkUuid = uuidSchema.parse(object.parse(input.otherwise).linkUuid);
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
			refuseOwnCaseConditionOffType(slot);
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
