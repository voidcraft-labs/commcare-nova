import { z } from "zod";
import type { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import { printXPathInDoc } from "@/lib/doc/expressionText";
import type { FieldWithChildren } from "@/lib/doc/fieldWalk";
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
	formSchema,
	languageTag,
	localizedValueSchema,
	moduleIconRefSchema,
	moduleUuidOfForm,
	proseTemplateSchema,
	translationEntrySchema,
	translationUnitsById,
	type Uuid,
	uuidSchema,
	xpathExpressionSchema,
} from "@/lib/domain";
import { automationMessageTemplateSchema } from "@/lib/domain/automations";
import {
	predicateSchema,
	relationPathSchema,
	termSchema,
	valueExpressionSchema,
} from "@/lib/domain/predicate";
import { log } from "@/lib/logger";
import { type AuthoringScopeOptions, authoringValueScope } from "./bindings";
import { ReadProjectionError } from "./errors";
import {
	authoringFingerprint,
	translationReviewRevision,
} from "./fingerprints";
import { printAuthoringIcon } from "./icons";
import { printAuthoringMessage } from "./messages";
import { queryPrinter } from "./printQueryExpression";
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
		["getField", "getForm", "getModule", "getCaseOperations"].includes(
			toolName,
		) && extractLookupReferenceTargets(ctx.snapshot.doc).tableIds.length > 0
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
	return {
		text: (value) =>
			printAuthoringText(proseTemplateSchema.parse(value), options.doc),
		xpath: (value) =>
			printXPathInDoc(options.doc, xpathExpressionSchema.parse(value)),
		condition: (value, path) =>
			printer(path).predicate(predicateSchema.parse(value)),
		value: (value, path) =>
			printer(path).value(valueExpressionSchema.parse(value)),
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
	scope(formUuid?: Uuid, moduleUuid?: Uuid): AuthoringScopeOptions;
	project<Schema extends z.ZodType>(
		schema: Schema,
		value: Canonical<Schema>,
		options: AuthoringScopeOptions,
	): unknown;
	field(value: FieldWithChildren): unknown;
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
	getEntryPoints: passthrough,
	listMediaAssets: passthrough,
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
	searchBlueprint(data, { doc }) {
		const payload = record.parse(data);
		return {
			...payload,
			results: records.parse(payload.results).map((item) => {
				if (item.type !== "field") return item;
				const source = doc.fields[uuidSchema.parse(item.fieldUuid)];
				if (!source)
					throw new Error("The searched field is no longer in this app.");
				if (
					["label", "hint", "help", "validate_msg"].includes(String(item.field))
				) {
					const value = record.parse(source)[String(item.field)];
					return {
						...item,
						value: printAuthoringText(proseTemplateSchema.parse(value), doc),
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
	getForm(data, { project, scope, field }) {
		const { fields, ...form } = data.form;
		return {
			...data,
			...(data.recordName !== undefined && {
				recordName: project(
					xpathExpressionSchema,
					data.recordName,
					scope(form.uuid),
				),
			}),
			form: {
				...record.parse(project(formSchema, form, scope(form.uuid))),
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
				predicateSchema.nullable(),
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
			forms: data.forms.map((form) => ({
				...form,
				icon: project(formIconRefSchema.nullable(), form.icon, options),
			})),
		};
	},
	getCaseOperations: (data, { project, scope }) => ({
		...data,
		operations: project(
			z.array(caseOperationSchema),
			data.operations,
			scope(data.formUuid),
		),
	}),
	getTranslatableContent(data, { doc, scope }) {
		const payload = record.parse(data);
		const units = translationUnitsById(doc);
		return {
			...payload,
			items: records.parse(payload.items).map((item) => {
				const unit = [...units.values()].find((unit) => unit.id === item.id);
				if (!unit)
					throw new Error("The translation source changed during this read.");
				const owner = unit.owner;
				const encoders = authoringEncoders(
					scope(
						"formUuid" in owner ? owner.formUuid : undefined,
						"moduleUuid" in owner ? owner.moduleUuid : undefined,
					),
				);
				const explicit =
					item.explicit == null ? item.explicit : record.parse(item.explicit);
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
					source: encoders.localized(item.source, []),
					effective: encoders.localized(item.effective, []),
					explicit: explicit && {
						origin: explicit.origin,
						review: explicit.review,
						translatedFrom: explicit.translatedFrom,
						value: encoders.localized(explicit.value, []),
					},
					protectedParts:
						unit.valueKind === "prose"
							? proseTemplateSchema
									.parse(unit.source)
									.parts.filter((part) => part.kind !== "text")
									.map((part) => printAuthoringText({ parts: [part] }, doc))
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
		}
		if (result.optionsSource !== undefined) {
			const options = record.parse(result.optionsSource);
			if (options.kind === "inline") {
				const rows = records.parse(options.options);
				options.options = rows.map(({ uuid, value, label }) => ({
					optionUuid: uuid,
					value,
					label,
				}));
				const media = rows
					.filter((option) => option.media !== undefined)
					.map((option) => ({ optionUuid: option.uuid, media: option.media }));
				if (media.length) result.optionMedia = media;
				result.optionsSource = options;
			}
		}
		return {
			...result,
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
	return projector(data, { doc, scope, project, field });
}
