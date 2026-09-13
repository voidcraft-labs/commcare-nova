import { z } from "zod";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import { printXPathInDoc } from "@/lib/doc/expressionText";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import {
	automationSchema,
	type BlueprintDoc,
	caseListConfigSchema,
	caseOperationSchema,
	caseSearchConfigSchema,
	fieldSchema,
	formSchema,
	localizedValueSchema,
	moduleUuidOfForm,
	proseTemplateSchema,
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
import { type AuthoringScopeOptions, authoringValueScope } from "./bindings";
import { authoringFingerprint } from "./fingerprints";
import { printAuthoringMessage } from "./messages";
import { queryPrinter } from "./printQueryExpression";
import { type AuthoringValueDecoders, encodeAuthoringValues } from "./schema";
import { printAuthoringText } from "./text";

const record = z.record(z.string(), z.unknown());
const records = z.array(record);

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
	return projectAuthoringRead({
		toolName,
		data,
		doc: ctx.snapshot.doc,
		tables,
	});
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
	};
}

/** Reads retain their useful structure and identities. Only declared content
 * families become authored strings; ordinary objects are never shape-guessed. */
export function projectAuthoringRead(args: {
	toolName: string;
	data: unknown;
	doc: BlueprintDoc;
	tables?: AuthoringScopeOptions["tables"];
}): unknown {
	const { toolName, data, doc, tables } = args;
	if (data === null || typeof data !== "object") return data;
	if ("error" in data) return data;
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
	function project(
		schema: z.ZodType,
		value: unknown,
		options: AuthoringScopeOptions,
	) {
		return encodeAuthoringValues(
			schema,
			value,
			authoringEncoders(options, value, toolName === "getModule"),
		);
	}
	function field(value: unknown): unknown {
		const { children, ...content } = record.parse(value);
		const uuid = uuidSchema.parse(content.uuid);
		const result = record.parse(
			project(fieldSchema, content, scope(findContainingForm(doc, uuid))),
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
				children: z.array(z.unknown()).parse(children).map(field),
			}),
		};
	}
	if (toolName === "getAutomations")
		return records.parse(data).map((item) => ({
			...item,
			automation: project(automationSchema, item.automation, { doc, tables }),
		}));
	const payload = record.parse(data);
	switch (toolName) {
		case "searchBlueprint":
			return {
				...payload,
				results: records.parse(payload.results).map((item) => {
					if (item.type !== "field") return item;
					const source = doc.fields[uuidSchema.parse(item.fieldUuid)];
					if (!source)
						throw new Error("The searched field is no longer in this app.");
					if (
						["label", "hint", "help", "validate_msg"].includes(
							String(item.field),
						)
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
		case "getField":
			return { ...payload, field: field(payload.field) };
		case "getForm": {
			const { fields, ...form } = record.parse(payload.form);
			return {
				...payload,
				form: {
					...record.parse(
						project(formSchema, form, scope(uuidSchema.parse(form.uuid))),
					),
					fields: z.array(z.unknown()).parse(fields).map(field),
				},
			};
		}
		case "getModule": {
			const options = scope(undefined, uuidSchema.parse(payload.uuid));
			return {
				...payload,
				display_condition: project(
					predicateSchema.nullable(),
					payload.display_condition,
					options,
				),
				case_list_config: project(
					caseListConfigSchema.nullable(),
					payload.case_list_config,
					options,
				),
				case_search_config: project(
					caseSearchConfigSchema.nullable(),
					payload.case_search_config,
					options,
				),
			};
		}
		case "getCaseOperations":
			return {
				...payload,
				operations: project(
					z.array(caseOperationSchema),
					payload.operations,
					scope(uuidSchema.parse(payload.formUuid)),
				),
			};
		case "getTranslatableContent": {
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
						sourceFingerprint: authoringFingerprint(
							z.string().parse(item.sourceFingerprint),
						),
						source: encoders.localized(item.source, []),
						effective: encoders.localized(item.effective, []),
						explicit: explicit && {
							...explicit,
							sourceFingerprint: authoringFingerprint(
								z.string().parse(explicit.sourceFingerprint),
							),
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
		}
		default:
			return data;
	}
}
