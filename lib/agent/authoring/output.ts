import { z } from "zod";
import type { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import {
	entryDatumIdResolver,
	formLinkProjectionContext,
	formLinkTargetDatumIds,
} from "@/lib/commcare/formLinkProjection";
import { projectFormExpression } from "@/lib/doc/expressionText";
import type { FieldWithChildren } from "@/lib/doc/fieldWalk";
import { prepareFormRecordName } from "@/lib/doc/formRecordName";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import {
	appLanguageIdentitySchema,
	automationSchema,
	type BlueprintDoc,
	caseListConfigSchema,
	caseOperationSchema,
	casePropertySchema,
	caseSearchConfigSchema,
	fieldSchema,
	formIconRefSchema,
	formLinkEntries,
	formSchema,
	languageTag,
	localizedValueSchema,
	moduleIconRefSchema,
	moduleUuidOfForm,
	proseTemplateSchema,
	resolveFormLinkTarget,
	translationEntrySchema,
	translationUnitProseSlot,
	translationUnitsById,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { automationMessageTemplateSchema } from "@/lib/domain/automations";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import { printFormExpression } from "@/lib/domain/expression/print";
import {
	conditionSchema,
	type Expression,
	type ExpressionSlotRef,
	formLinkDatumNameSchema,
	formLogicSchema,
	type ProseSlotRef,
	relationPathSchema,
	termSchema,
	valueSchema,
} from "@/lib/domain/expression/types";
import { referenceNames } from "@/lib/domain/referenceNames";
import { log } from "@/lib/logger";
import { type AuthoringScopeOptions, authoringValueScope } from "./bindings";
import { ReadProjectionError } from "./errors";
import { effectiveFieldBehavior } from "./fieldBehavior";
import {
	authoringFingerprint,
	translationReviewRevision,
} from "./fingerprints";
import { formRecordContext } from "./formRecordContext";
import { printAuthoringIcon } from "./icons";
import { printAuthoringMessage } from "./messages";
import { queryPrinter } from "./printQueryExpression";
import { proseValuePrinter } from "./proseSlots";
import { type AuthoringValueDecoders, encodeAuthoringValues } from "./schema";
import { printAuthoringText } from "./text";

const record = z.record(z.string(), z.unknown());
const records = z.array(record);

/** The one boundary between a read tool's canonical result and the authored
 * form every client sees. Stored content is already admitted, so anything
 * thrown while printing it is Nova's defect, never the caller's input: it is
 * recorded once and leaves as `ReadProjectionError`, which no surface treats as
 * a bad request. Loading the Project's data tables is a live read that can
 * fail or race for its own reasons, so it stays outside that claim and keeps
 * its own error. */
export async function projectAuthoringReadInContext(
	toolName: string,
	data: unknown,
	ctx: ToolInvocationContext,
) {
	const tables =
		[
			"getField",
			"getForm",
			"getModule",
			"getCaseOperations",
			"searchBlueprint",
			"getTranslatableContent",
		].includes(toolName) &&
		extractLookupReferenceTargets(ctx.snapshot.doc).tableIds.length > 0
			? (await ctx.lookupCatalog?.())?.definitions
			: undefined;
	try {
		return projectAuthoringRead({
			toolName,
			data,
			doc: ctx.snapshot.doc,
			tables,
		});
	} catch (error) {
		log.error("[authoring] read projection failed", error, {
			toolName,
			appId: ctx.appId,
			projectId: ctx.projectId,
			workId: ctx.ordinaryAuthoring?.sessionId,
			authoringSessionId: ctx.authoringSessionId,
			workspaceRevision: ctx.snapshot.revision,
		});
		throw new ReadProjectionError(toolName, error);
	}
}

export function authoringEncoders(
	options: AuthoringScopeOptions,
	source?: unknown,
	searchValidation = false,
): AuthoringValueDecoders {
	const printer = (path: readonly (string | number)[]) =>
		queryPrinter(authoringValueScope(options, source, path, searchValidation));
	function slotAt(path: readonly (string | number)[]): ExpressionSlotRef {
		const content = record.parse(source);
		const uuid = uuidSchema.safeParse(content.uuid);
		if (uuid.success && options.doc.fields[uuid.data] !== undefined) {
			const slot =
				path.length === 1
					? path[0]
					: path[0] === "data_source" && path[1] === "ids_query"
						? "ids_query"
						: undefined;
			if (
				slot === "relevant" ||
				slot === "validate" ||
				slot === "calculate" ||
				slot === "default_value" ||
				slot === "required" ||
				slot === "repeat_count" ||
				slot === "ids_query"
			)
				return { entity: "field", uuid: uuid.data, slot };
		}
		if (options.formUuid !== undefined) {
			const uuid = options.formUuid;
			if (path[0] === "connect") {
				if (path[1] === "assessment" && path[2] === "user_score")
					return { entity: "form", uuid, slot: "assessment_user_score" };
				if (path[1] === "deliver_unit" && path[2] === "entity_id")
					return { entity: "form", uuid, slot: "deliver_entity_id" };
				if (path[1] === "deliver_unit" && path[2] === "entity_name")
					return { entity: "form", uuid, slot: "deliver_entity_name" };
			}
			const otherwise = options.doc.forms[uuid]?.otherwise;
			if (
				path[0] === "otherwise" &&
				otherwise?.kind === "link" &&
				path[1] === "datums" &&
				typeof path[2] === "number"
			) {
				const datum = records.parse(record.parse(content.otherwise).datums)[
					path[2]
				];
				if (datum !== undefined)
					return {
						entity: "form",
						uuid,
						slot: "form_link_datum_xpath",
						member: {
							linkUuid: otherwise.uuid,
							datum: formLinkDatumNameSchema.parse(datum.name),
						},
					};
			}
			if (path[0] === "formLinks" && typeof path[1] === "number") {
				const projected = records.parse(content.formLinks)[path[1]];
				const linkUuid = uuidSchema.parse(projected?.uuid);
				const link = options.doc.forms[uuid]?.formLinks?.find(
					(candidate) => candidate.uuid === linkUuid,
				);
				if (link !== undefined) {
					if (path[2] === "condition")
						return {
							entity: "form",
							uuid,
							slot: "form_link_condition",
							member: { linkUuid: link.uuid },
						};
					const datum =
						path[2] === "datums" && typeof path[3] === "number"
							? records.parse(projected.datums)[path[3]]
							: undefined;
					if (datum !== undefined)
						return {
							entity: "form",
							uuid,
							slot: "form_link_datum_xpath",
							member: {
								linkUuid: link.uuid,
								datum: formLinkDatumNameSchema.parse(datum.name),
							},
						};
				}
			}
		}
		throw new Error(
			`The stored expression at ${path.join(".")} has no evaluating slot.`,
		);
	}
	/* The prose slot of a field's text at `path` in the field's canonical
	 * content, where a calculated value in it prints. A text that is no
	 * field's (a case property's label) has none, and holds no value. */
	function proseSlotAt(
		path: readonly (string | number)[],
	): ProseSlotRef | undefined {
		const content = record.safeParse(source);
		if (!content.success) return undefined;
		const uuid = uuidSchema.safeParse(content.data.uuid);
		if (!uuid.success || options.doc.fields[uuid.data] === undefined)
			return undefined;
		const [slot] = path;
		if (
			path.length === 1 &&
			(slot === "label" ||
				slot === "hint" ||
				slot === "help" ||
				slot === "validate_msg")
		)
			return { entity: "field", uuid: uuid.data, slot };
		if (
			path.length === 4 &&
			path[0] === "optionsSource" &&
			path[1] === "options" &&
			typeof path[2] === "number" &&
			path[3] === "label"
		) {
			const option = records.safeParse(
				record.safeParse(content.data.optionsSource).data?.options,
			).data?.[path[2]];
			const optionUuid = uuidSchema.safeParse(option?.uuid);
			return optionUuid.success
				? {
						entity: "field",
						uuid: uuid.data,
						slot: "option_label",
						member: { optionUuid: optionUuid.data },
					}
				: undefined;
		}
		return undefined;
	}
	const lookup = new Map(
		(options.tables ?? []).map((table) => [table.id, table]),
	);
	return {
		text: (value, path) =>
			printAuthoringText(
				proseTemplateSchema.parse(value),
				options.doc,
				proseValuePrinter(options.doc, proseSlotAt(path), lookup, options.form),
			),
		xpath(value, path) {
			const projection = projectFormExpression(
				options.doc,
				slotAt(path),
				formLogicSchema.parse(value),
				new Map((options.tables ?? []).map((table) => [table.id, table])),
				{ form: options.form },
			);
			if (projection.unresolved.length)
				throw new Error(
					`The stored expression at ${path.join(".")} contains an unresolved identity.`,
				);
			return projection.text;
		},
		datum(value, path) {
			const ref = slotAt(path);
			if (ref.entity !== "form" || ref.slot !== "form_link_datum_xpath")
				throw new Error("This form-link datum has no target.");
			const form = options.doc.forms[ref.uuid];
			const link =
				form === undefined
					? undefined
					: formLinkEntries(form).find(
							(entry) => entry.link.uuid === ref.member.linkUuid,
						)?.link;
			if (link === undefined)
				throw new Error("The form link is no longer in this app.");
			const target = resolveFormLinkTarget(options.doc, ref.uuid, link.target);
			if (target === undefined)
				throw new Error("The form link's form is in no menu.");
			const id = entryDatumIdResolver(
				formLinkTargetDatumIds(
					options.doc,
					formLinkProjectionContext(options.doc, { entryMetadataOnly: true }),
					target,
				),
			)(formLinkDatumNameSchema.parse(value));
			if (id === undefined)
				throw new Error("The form link's target no longer reads this datum.");
			return id;
		},
		condition: (value, path) =>
			printer(path).predicate(conditionSchema.parse(value)),
		value: (value, path) => printer(path).value(valueSchema.parse(value)),
		reference: (value, path) => printer(path).term(termSchema.parse(value)),
		relationship: (value, path) =>
			printer(path).relationship(relationPathSchema.parse(value)),
		message: (value) =>
			printAuthoringMessage(automationMessageTemplateSchema.parse(value)),
		localized(value) {
			const content = localizedValueSchema.parse(value);
			return typeof content === "string"
				? content
				: printAuthoringText(content, options.doc);
		},
		moduleIcon: printAuthoringIcon,
		formIcon: printAuthoringIcon,
	};
}

type ReadEntry = Extract<
	(typeof SHARED_TOOL_REGISTRY)[number],
	{ policy: { effect: "read-blueprint" } }
>;
/** Every shared tool the registry declares as a read. */
export type ReadToolName = ReadEntry["saName"];
type ReadOutcome<Name extends ReadToolName> = Extract<
	Awaited<ReturnType<Extract<ReadEntry, { saName: Name }>["tool"]["execute"]>>,
	{ kind: "read" }
>["data"];
/** What a read tool returns when it succeeds, exactly as its body types it. */
export type ReadToolData<Name extends ReadToolName> = Exclude<
	ReadOutcome<Name>,
	{ error: string }
>;

/** The canonical value a schema walk accepts. A read may hand over part of an
 * entity, but every slot it does hand over must hold the STORED value: a slot
 * that was already turned into authored form fails here at compile time rather
 * than when someone reads an app that uses it. */
type Canonical<Schema extends z.ZodType> =
	z.output<Schema> extends infer Value
		? Value extends readonly (infer Item)[]
			? readonly Slots<Item>[]
			: Value extends object
				? Slots<Value>
				: Value
		: never;
/* A union of variants is compared slot by slot, because the domain declares
 * some entities as one flattened object type rather than the schema's union. */
type KeysOf<Value> = Value extends unknown ? keyof Value : never;
type SlotOf<Value, Key> = Value extends unknown
	? Key extends keyof Value
		? Value[Key]
		: never
	: never;
type Slots<Value> = { [Key in KeysOf<Value>]?: SlotOf<Value, Key> };

interface ReadProjection {
	readonly doc: BlueprintDoc;
	/** The Project's data table definitions the read loaded, by id. */
	readonly lookup: LookupDefinitionIndex;
	scope(formUuid?: Uuid, moduleUuid?: Uuid): AuthoringScopeOptions;
	project<Schema extends z.ZodType>(
		schema: Schema,
		value: Canonical<Schema>,
		options: AuthoringScopeOptions,
	): unknown;
	field(value: FieldWithChildren): unknown;
	recordName(formUuid: Uuid, value: Expression): string;
	/** A form's open or close condition as the form logic `updateForm`
	 *  accepts. */
	formCondition(
		formUuid: Uuid,
		slot: "form_open_condition" | "form_close_condition",
		value: Expression,
	): string;
}

/** A projected form's after-submit as getForm reads it: its links as
 * `destinations`, in the order they run, and an otherwise link addressed by
 * `linkUuid` as a destination is. */
function afterSubmitRead(form: Record<string, unknown>) {
	const { formLinks, otherwise, ...rest } = form;
	const read = otherwise === undefined ? undefined : record.parse(otherwise);
	const { uuid, ...link } = read ?? {};
	return {
		...rest,
		...(formLinks !== undefined && { destinations: formLinks }),
		...(read !== undefined && {
			otherwise:
				read.kind === "link" ? { kind: "link", linkUuid: uuid, ...link } : read,
		}),
	};
}

/** The tool's result already is its authored reading form. */
const passthrough = (data: unknown) => data;

/** One entry per registered read tool, so a new read must state how its result
 * becomes authored content. Tool bodies return canonical values and this table
 * is the only place they are projected. */
const readProjectors: {
	readonly [Name in ReadToolName]: (
		data: ReadToolData<Name>,
		read: ReadProjection,
	) => unknown;
} = {
	getAuthoringGuide: passthrough,
	getLanguages: passthrough,
	getLookupTables: passthrough,
	getLookupTableRows: passthrough,
	evaluateForm: passthrough,
	readAppTest: passthrough,
	getEntryPoints: passthrough,
	listMediaAssets: passthrough,
	readSource: passthrough,
	getUsers: passthrough,
	getOrganization: passthrough,
	getAutomations: (data, { project, scope }) =>
		data.map((item) => ({
			...item,
			automation: project(automationSchema, item.automation, scope()),
		})),
	getCaseProperty: (data, { project, scope }) => ({
		...data,
		property: project(casePropertySchema, data.property, {
			...scope(),
			currentCaseType: data.caseType,
		}),
	}),
	searchBlueprint(data, { doc, lookup }) {
		const payload = record.parse(data);
		return {
			...payload,
			results: records.parse(payload.results).map((item) => {
				if (item.type !== "field") return item;
				const source = doc.fields[uuidSchema.parse(item.fieldUuid)];
				if (!source)
					throw new Error("The searched field is no longer in this app.");
				const slot = item.field;
				if (
					slot === "label" ||
					slot === "hint" ||
					slot === "help" ||
					slot === "validate_msg"
				) {
					const value = record.parse(source)[slot];
					return {
						...item,
						value: printAuthoringText(
							proseTemplateSchema.parse(value),
							doc,
							proseValuePrinter(
								doc,
								{ entity: "field", uuid: source.uuid, slot },
								lookup,
							),
						),
					};
				}
				if (item.field === "option") {
					const { value, ...match } = item;
					return { ...match, summary: value };
				}
				return item;
			}),
		};
	},
	getField: (data, { field }) => ({ ...data, field: field(data.field) }),
	getForm(data, { project, scope, field, doc, recordName, formCondition }) {
		const {
			fields,
			openCondition,
			closeCondition,
			ownClosePlacement: _heldClose,
			plainText,
			...form
		} = data.form;
		// A held placement is an identity no author chooses: no edit accepts
		// it, so the read leaves it out, and getCaseOperations states where
		// each change is kept.
		const operations = form.caseOperations?.map(
			({ placement: _held, ...operation }) => operation,
		);
		return {
			...data,
			recordContext: formRecordContext(doc, form.uuid),
			...(data.recordName !== undefined && {
				recordName: recordName(form.uuid, data.recordName),
			}),
			form: {
				...afterSubmitRead(
					record.parse(
						project(
							formSchema,
							{
								...form,
								...(operations !== undefined && { caseOperations: operations }),
							},
							scope(form.uuid),
						),
					),
				),
				...(openCondition !== undefined && {
					openCondition: formCondition(
						form.uuid,
						"form_open_condition",
						openCondition,
					),
				}),
				// Read under the name an edit takes, so a read sent back
				// through `updateForm` keeps it.
				...(plainText === true && { plain_text: true }),
				...(closeCondition !== undefined && {
					closeCondition: formCondition(
						form.uuid,
						"form_close_condition",
						closeCondition,
					),
				}),
				fields: fields.map(field),
			},
		};
	},
	getModule(data, { project, scope }) {
		const options = scope(undefined, data.uuid);
		return {
			...data,
			icon: project(moduleIconRefSchema.nullable(), data.icon, options),
			display_condition: project(
				conditionSchema.nullable(),
				data.display_condition,
				options,
			),
			case_list_config: project(
				caseListConfigSchema.nullable(),
				data.case_list_config,
				options,
			),
			case_search_config: project(
				caseSearchConfigSchema.nullable(),
				data.case_search_config,
				options,
			),
			caseListMenuItem:
				data.caseListMenuItem === null
					? null
					: {
							...data.caseListMenuItem,
							icon: project(
								moduleIconRefSchema.nullable(),
								data.caseListMenuItem.icon,
								options,
							),
						},
			caseListRegistrationForm:
				data.caseListRegistrationForm?.kind === "always"
					? {
							...data.caseListRegistrationForm,
							icon: project(
								formIconRefSchema.nullable(),
								data.caseListRegistrationForm.icon,
								options,
							),
						}
					: data.caseListRegistrationForm,
			forms: data.forms.map((form) => ({
				...form,
				icon: project(formIconRefSchema.nullable(), form.icon, options),
			})),
		};
	},
	getCaseOperations: ({ placements, ...data }, { project, scope }) => ({
		...data,
		operations: records
			.parse(
				project(
					z.array(caseOperationSchema),
					data.operations,
					scope(data.formUuid),
				),
			)
			.map((operation, index) => {
				const uuid = data.operations[index]?.uuid;
				const placement = uuid === undefined ? undefined : placements[uuid];
				return placement === undefined
					? operation
					: { ...operation, ...placement };
			}),
	}),
	getTranslatableContent(data, { doc, lookup }) {
		const payload = record.parse(data);
		const units = translationUnitsById(doc);
		return {
			...payload,
			items: records.parse(payload.items).map((item) => {
				const unit = [...units.values()].find((unit) => unit.id === item.id);
				if (!unit)
					throw new Error("The translation source changed during this read.");
				const explicit =
					item.explicit == null ? item.explicit : record.parse(item.explicit);
				/* A field's text prints its calculated values in the slot the
				 * unit translates; every other unit holds none. */
				const printValue = proseValuePrinter(
					doc,
					translationUnitProseSlot(unit),
					lookup,
				);
				const localized = (value: unknown) => {
					const content = localizedValueSchema.parse(value);
					return typeof content === "string"
						? content
						: printAuthoringText(content, doc, printValue);
				};
				return {
					...item,
					...(explicit
						? {
								revision: translationReviewRevision(
									languageTag(
										appLanguageIdentitySchema.parse(payload.language),
									),
									unit,
									translationEntrySchema.parse(explicit),
								),
							}
						: {}),
					sourceFingerprint: authoringFingerprint(
						z.string().parse(item.sourceFingerprint),
					),
					source: localized(item.source),
					effective: localized(item.effective),
					explicit: explicit && {
						origin: explicit.origin,
						review: explicit.review,
						translatedFrom: explicit.translatedFrom,
						value: localized(explicit.value),
					},
					protectedParts:
						unit.valueKind === "prose"
							? proseTemplateSchema
									.parse(unit.source)
									.parts.filter((part) => part.kind !== "text")
									.map((part) =>
										printAuthoringText({ parts: [part] }, doc, printValue),
									)
							: [],
				};
			}),
		};
	},
};

function isReadToolName(name: string): name is ReadToolName {
	return Object.hasOwn(readProjectors, name);
}

/** Reads retain their useful structure and identities. Only declared content
 * families become authored values; ordinary objects are never shape-guessed. */
export function projectAuthoringRead(args: {
	toolName: string;
	data: unknown;
	doc: BlueprintDoc;
	tables?: AuthoringScopeOptions["tables"];
}): unknown {
	const { toolName, data, doc, tables } = args;
	if (data === null || typeof data !== "object") return data;
	if ("error" in data) return data;
	if (!isReadToolName(toolName)) return data;
	function scope(formUuid?: Uuid, moduleUuid?: Uuid): AuthoringScopeOptions {
		const module =
			moduleUuid ?? (formUuid ? moduleUuidOfForm(doc, formUuid) : undefined);
		return {
			doc,
			tables,
			formUuid,
			moduleUuid: module,
			currentCaseType: module ? doc.modules[module]?.caseType : undefined,
			operations: formUuid
				? (doc.forms[formUuid]?.caseOperations ?? []).map((operation) => ({
						uuid: operation.uuid,
						name: operation.id,
					}))
				: undefined,
		};
	}
	const project: ReadProjection["project"] = (schema, value, options) =>
		encodeAuthoringValues(
			schema,
			value,
			authoringEncoders(options, value, toolName === "getModule"),
		);
	function field(value: FieldWithChildren): unknown {
		const { children, ...content } = value;
		const result = record.parse(
			project(
				fieldSchema,
				content,
				scope(findContainingForm(doc, content.uuid)),
			),
		);
		if (result.validate !== undefined) {
			result.validate = {
				expr: result.validate,
				...(result.validate_msg !== undefined && { msg: result.validate_msg }),
			};
			delete result.validate_msg;
		}
		if (result.kind === "repeat") {
			result.repeat = {
				mode: result.repeat_mode,
				...(result.repeat_mode === "count_bound" && {
					count: result.repeat_count,
				}),
				...(result.repeat_mode === "query_bound" && {
					ids_query: record.parse(result.data_source).ids_query,
				}),
			};
			delete result.repeat_mode;
			delete result.repeat_count;
			delete result.data_source;
			// A held placement is an identity no author chooses: the read
			// states it as `rows`, with `rowsKept` where it is held, from
			// `effectiveFieldBehavior`.
			delete result.placement;
		}
		if (result.optionsSource !== undefined) {
			const options = record.parse(result.optionsSource);
			if (options.kind === "inline") {
				const rows = records.parse(options.options);
				// A choice reads in the shape an edit takes, so a choice shown as
				// typed reads `plain_label: true` and a replacement that sends it
				// back keeps it.
				options.options = rows.map(({ uuid, value, label, plainLabel }) => ({
					optionUuid: uuid,
					value,
					label,
					...(plainLabel === true && { plain_label: true }),
				}));
				const media = rows
					.filter((option) => option.media !== undefined)
					.map((option) => ({ optionUuid: option.uuid, media: option.media }));
				if (media.length) result.optionMedia = media;
				result.optionsSource = options;
			}
		}
		// The display flags read under the names an edit takes, so a read
		// sent back through `editField` or `addFields` keeps them.
		if (result.fieldList !== undefined) {
			result.field_list = result.fieldList;
			delete result.fieldList;
		}
		if (result.plainLabel !== undefined) {
			result.plain_label = result.plainLabel;
			delete result.plainLabel;
		}
		if (result.plainHelp !== undefined) {
			result.plain_help = result.plainHelp;
			delete result.plainHelp;
		}
		return {
			...result,
			...effectiveFieldBehavior(doc, content),
			...(children !== undefined && {
				children: children.map(field),
			}),
		};
	}
	// The table pairs each name with its own tool's result type; the registry
	// dispatches by a runtime name, so the pairing is restated here once.
	const projector = readProjectors[toolName] as (
		data: unknown,
		read: ReadProjection,
	) => unknown;
	// The record name is the own case's name slot, printed where an edit of
	// it is parsed (`prepareFormRecordName`).
	function recordName(formUuid: Uuid, value: Expression): string {
		const prepared = prepareFormRecordName(doc, formUuid);
		const projection =
			prepared === undefined
				? printFormExpression(value, referenceNames(doc))
				: projectFormExpression(
						doc,
						prepared.slot,
						value,
						new Map((tables ?? []).map((table) => [table.id, table])),
					);
		if (projection.unresolved.length)
			throw new Error("The record naming rule has an unresolved identity.");
		return projection.text;
	}
	function formCondition(
		formUuid: Uuid,
		slot: "form_open_condition" | "form_close_condition",
		value: Expression,
	): string {
		const projection = projectFormExpression(
			doc,
			{ entity: "form", uuid: formUuid, slot },
			value,
			new Map((tables ?? []).map((table) => [table.id, table])),
		);
		if (projection.unresolved.length)
			throw new Error(
				"The form's open or close condition has an unresolved identity.",
			);
		return projection.text;
	}
	return projector(data, {
		doc,
		lookup: new Map((tables ?? []).map((table) => [table.id, table])),
		scope,
		project,
		field,
		recordName,
		formCondition,
	});
}
