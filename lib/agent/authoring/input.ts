import { z } from "zod";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import { parseAuthoredXPath } from "@/lib/doc/expressionText";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import {
	type BlueprintDoc,
	fieldKinds,
	moduleUuidOfForm,
	orderedCaseOperations,
	SEARCH_INPUT_RUNTIME_VALUE_TYPES,
	searchInputRuntimeValueType,
	type TranslationUnit,
	translationUnitsById,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { SearchInputDecl } from "@/lib/domain/predicate";
import { readOrganization } from "@/lib/organization/service";
import { bindToolAddress } from "./addresses";
import {
	type AuthoringScopeOptions,
	authoringValueScope,
	enclosingAuthoringTable,
} from "./bindings";
import { allocateCreationIdentities, prepareFormNames } from "./creations";
import { AuthoringInputError } from "./errors";
import {
	type AuthoredExpression,
	parseAuthoringExpression,
} from "./expressionSyntax";
import { authoringFingerprint } from "./fingerprints";
import { parseAuthoringMessage } from "./messages";
import {
	parseQueryPredicate,
	parseQueryReference,
	parseQueryRelationship,
	parseQueryValue,
} from "./queryExpressions";
import {
	type AuthoringPath,
	type AuthoringValueDecoders,
	decodeAuthoringValues,
} from "./schema";
import { normalizeExpression, normalizeText } from "./text";

type Input = Record<string, unknown>;
const record = z.record(z.string(), z.unknown());
const records = z.array(record);
const expression = z.union([z.string(), z.boolean()]);
const valueExpression = z.union([z.string(), z.number(), z.boolean()]);

function authoringXPath(...args: Parameters<typeof parseAuthoredXPath>) {
	try {
		return parseAuthoredXPath(...args);
	} catch (error) {
		if (error instanceof Error) throw new AuthoringInputError(error.message);
		throw error;
	}
}

function optionalId(value: unknown): Uuid | undefined {
	return value == null ? undefined : uuidSchema.parse(value);
}

function searchType(input: Input) {
	if (input.kind === "hidden") return "text" as const;
	const found = Object.entries(SEARCH_INPUT_RUNTIME_VALUE_TYPES).find(
		([type]) => type === input.type,
	);
	if (!found)
		throw new AuthoringInputError(
			`Unknown Search answer type: ${String(input.type)}.`,
		);
	return found[1];
}

function readsCatalog(
	node: AuthoredExpression,
	catalog: "locations" | "tables",
): boolean {
	switch (node.kind) {
		case "call":
			return (
				(catalog === "locations"
					? node.name === "location"
					: ["lookup", "table-column"].includes(node.name)) ||
				node.args.some((arg) => readsCatalog(arg, catalog))
			);
		case "binary":
			return (
				readsCatalog(node.left, catalog) || readsCatalog(node.right, catalog)
			);
		case "negative":
			return readsCatalog(node.value, catalog);
		case "reference":
			return catalog === "tables" && node.namespace === "row";
		default:
			return false;
	}
}

function formScope(doc: BlueprintDoc, formUuid: Uuid): AuthoringScopeOptions {
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const form = doc.forms[formUuid];
	return {
		doc,
		formUuid,
		moduleUuid,
		currentCaseType:
			(form?.type === "followup" || form?.type === "close") && moduleUuid
				? doc.modules[moduleUuid]?.caseType
				: undefined,
		operations: (form ? orderedCaseOperations(form) : []).map((operation) => ({
			uuid: operation.uuid,
			name: operation.id,
		})),
	};
}

interface ScopedInput {
	path: AuthoringPath;
	options: AuthoringScopeOptions;
}

/** The prepared request is bound once inside the workspace invocation. It owns
 * no persistence and never retries a canonical write or rebinds a receipt. */
export async function prepareAuthoringInput<S extends z.ZodType>(args: {
	toolName: string;
	schema: S;
	input: unknown;
	ctx: ToolInvocationContext;
}): Promise<z.output<S>> {
	try {
		return await prepareInput(args);
	} catch (error) {
		if (error instanceof z.ZodError)
			throw new AuthoringInputError(
				error.issues
					.map(
						(issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
					)
					.join("; "),
			);
		throw error;
	}
}

async function prepareInput<S extends z.ZodType>(args: {
	toolName: string;
	schema: S;
	input: unknown;
	ctx: ToolInvocationContext;
}): Promise<z.output<S>> {
	const { toolName, schema, ctx } = args;
	const input = record.parse(structuredClone(args.input));
	const doc = ctx.snapshot.doc;
	bindToolAddress(toolName, input, doc);
	const fieldUuid = optionalId(input.fieldUuid);
	const formUuid =
		optionalId(input.formUuid) ??
		(fieldUuid ? findContainingForm(doc, fieldUuid) : undefined);
	const moduleUuid =
		optionalId(input.moduleUuid) ??
		(formUuid ? moduleUuidOfForm(doc, formUuid) : undefined);
	const root: AuthoringScopeOptions = {
		doc,
		...(formUuid
			? { ...formScope(doc, formUuid), moduleUuid }
			: { moduleUuid }),
		...(!formUuid &&
			moduleUuid && {
				currentCaseType: doc.modules[moduleUuid]?.caseType,
			}),
	};
	const scopes: ScopedInput[] = [{ path: [], options: root }];
	if (toolName === "updateModule" && input.case_type !== undefined)
		root.currentCaseType =
			z.string().nullable().parse(input.case_type) ?? undefined;
	const existingField = fieldUuid ? doc.fields[fieldUuid] : undefined;
	const existingOptions =
		existingField &&
		"optionsSource" in existingField &&
		existingField.optionsSource.kind === "inline"
			? existingField.optionsSource.options
			: [];
	allocateCreationIdentities(toolName, input, (spec, item) => {
		if (spec.entityKind !== "option" || typeof item.value !== "string")
			return undefined;
		const matches = existingOptions.filter(
			(option) => option.value === item.value,
		);
		return matches.length === 1 ? matches[0].uuid : undefined;
	});

	function prepareForm(
		form: Input,
		path: AuthoringPath,
		caseType: string | undefined,
	) {
		const uuid = uuidSchema.parse(form.formUuid);
		const prepared = prepareFormNames({
			doc,
			formUuid: uuid,
			fields: z.array(z.unknown()).parse(form.fields),
		});
		form.fields = prepared.fields;
		scopes.push({
			path,
			options: {
				...root,
				formUuid: uuid,
				fields: prepared.names,
				currentCaseType:
					form.type === "followup" || form.type === "close"
						? caseType
						: undefined,
			},
		});
	}
	if (toolName === "createModule") {
		const caseType = z.string().nullish().parse(input.case_type) ?? undefined;
		root.currentCaseType = caseType;
		if (input.forms != null) {
			const forms = records.parse(input.forms);
			for (const [index, form] of forms.entries())
				prepareForm(form, ["forms", index], caseType);
			input.forms = forms;
		}
	} else if (toolName === "createForm") {
		prepareForm(
			input,
			[],
			moduleUuid ? doc.modules[moduleUuid]?.caseType : undefined,
		);
	} else if (toolName === "addFields") {
		if (!formUuid)
			throw new AuthoringInputError(
				"Choose the form that will receive these fields.",
			);
		const prepared = prepareFormNames({
			doc,
			formUuid,
			fields: z.array(z.unknown()).parse(input.fields),
			parent: z.string().optional().parse(input.parentUuid),
		});
		root.fields = prepared.names;
		input.fields = prepared.fields;
	} else if (toolName === "editField") {
		if (!fieldUuid || !formUuid || !existingField)
			throw new AuthoringInputError("The field is no longer in this app.");
		const updates = record.parse(input.updates);
		updates.kind ??= existingField.kind;
		root.fields = prepareFormNames({
			doc,
			formUuid,
			edit: {
				uuid: fieldUuid,
				id: z.string().optional().parse(updates.id),
				kind: z.enum(fieldKinds).parse(updates.kind),
			},
		}).names;
		input.updates = updates;
	}

	if (toolName === "configureCaseList" || toolName === "addSearchInputs") {
		const additions = records.parse(input.searchInputs ?? []);
		const inputs: SearchInputDecl[] = additions.map((item) => ({
			uuid: uuidSchema.parse(item.searchInputUuid),
			name: z.string().parse(item.name),
			data_type: searchType(item),
		}));
		root.inputs = [
			...(moduleUuid
				? (doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? []).map(
						(item) => ({
							uuid: item.uuid,
							name: item.name,
							data_type: searchInputRuntimeValueType(item),
						}),
					)
				: []),
			...inputs,
		];
	}
	if (toolName === "updateSearchInput" && moduleUuid) {
		const replacement = record.parse(input.searchInput);
		const uuid = uuidSchema.parse(input.searchInputUuid);
		const current = doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
		root.inputs = [
			...current.map((item) => ({
				uuid: item.uuid,
				name: item.name,
				data_type:
					item.uuid === uuid
						? searchType(replacement)
						: searchInputRuntimeValueType(item),
			})),
			{
				uuid,
				name: z.string().parse(replacement.name),
				data_type: searchType(replacement),
			},
		];
	}
	if (toolName === "addCaseOperations") {
		root.operations = [
			...(root.operations ?? []),
			...records.parse(input.operations).map((operation) => ({
				uuid: uuidSchema.parse(operation.operationUuid),
				name: z.string().parse(record.parse(operation.operation).id),
			})),
		];
	}
	if (toolName === "configureConnect" && input.participants !== undefined) {
		const participants = records.parse(input.participants);
		for (const [index, participant] of participants.entries()) {
			const address = { formUuid: participant.formUuid };
			bindToolAddress("getForm", address, doc);
			participant.formUuid = address.formUuid;
			scopes.push({
				path: ["participants", index],
				options: formScope(doc, uuidSchema.parse(participant.formUuid)),
			});
		}
		input.participants = participants;
	}
	if (toolName === "addAutomations") {
		for (const [index, automation] of records
			.parse(input.automations)
			.entries())
			scopes.push({
				path: ["automations", index],
				options: {
					...root,
					currentCaseType: z.string().parse(automation.caseType),
				},
			});
	} else if (toolName === "updateAutomation") {
		root.currentCaseType = z
			.string()
			.parse(record.parse(input.automation).caseType);
	}

	const units =
		toolName === "updateTranslations" ? translationUnitsById(doc) : undefined;
	const translated = new Map<number, TranslationUnit>();
	if (units) {
		const updates = records.parse(input.updates);
		input.updates = updates;
		for (const [index, update] of updates.entries()) {
			const unit = [...units.values()].find(
				(unit) => unit.id === update.unitId,
			);
			if (!unit)
				throw new AuthoringInputError(
					`Translation ${String(update.unitId)} is no longer in this app.`,
				);
			translated.set(index, unit);
			for (const key of [
				"expectedSourceFingerprint",
				"expectedCurrentSourceFingerprint",
			]) {
				if (update[key] === undefined) continue;
				if (update[key] !== authoringFingerprint(unit.sourceFingerprint))
					throw new AuthoringInputError(
						"The source text changed. Read its current translation entry before editing it.",
					);
				update[key] = unit.sourceFingerprint;
			}
			const owner = unit.owner;
			scopes.push({
				path: ["updates", index],
				options: {
					doc,
					...("formUuid" in owner
						? formScope(doc, owner.formUuid)
						: "moduleUuid" in owner
							? {
									moduleUuid: owner.moduleUuid,
									currentCaseType: doc.modules[owner.moduleUuid]?.caseType,
								}
							: {}),
				},
			});
		}
	}

	// Read the authorized catalog only if expressions are actually encountered.
	// This prepares no DB rows and adds no context to the model's request.
	let tables: AuthoringScopeOptions["tables"];
	let locations: AuthoringScopeOptions["locations"];
	let needsLocations = false;
	let needsTables = false;
	const scanFamily =
		(family: string) => (value: unknown, path: AuthoringPath) => {
			if (["condition", "value", "reference"].includes(family)) {
				const expression = parseAuthoringExpression(
					valueExpression.parse(value),
				);
				needsLocations ||= readsCatalog(expression, "locations");
				needsTables ||=
					enclosingAuthoringTable(input, path) !== undefined ||
					readsCatalog(expression, "tables");
			}
			return value;
		};
	const scan: AuthoringValueDecoders = {
		text: scanFamily("text"),
		message: scanFamily("message"),
		localized: scanFamily("localized"),
		xpath: scanFamily("xpath"),
		condition: scanFamily("condition"),
		value: scanFamily("value"),
		reference: scanFamily("reference"),
		relationship: scanFamily("relationship"),
	};
	decodeAuthoringValues(schema, input, scan);
	if (needsTables) tables = (await ctx.lookupCatalog?.())?.definitions;
	if (needsLocations) {
		locations =
			ctx.appId === null
				? []
				: (
						await readOrganization({
							appId: ctx.appId,
							projectId: ctx.projectId,
							actorUserId: ctx.userId,
							role: "tool",
							changeSource: {
								kind: ctx.chatRunHolder === undefined ? "mcp" : "chat",
								runId: ctx.runId,
							},
							...(ctx.chatRunHolder && { chatRunHolder: ctx.chatRunHolder }),
						})
					).locations.map((location) => ({
						uuid: location.id,
						name: location.name,
					}));
	}

	function scopeAt(path: AuthoringPath) {
		const selected = scopes
			.filter((scope) =>
				scope.path.every((part, index) => path[index] === part),
			)
			.at(-1);
		if (!selected)
			throw new AuthoringInputError("This content has no authoring scope.");
		const searchValidation = [
			"configureCaseList",
			"addSearchInputs",
			"updateSearchInput",
		].includes(toolName);
		return authoringValueScope(
			{
				...selected.options,
				tables,
				locations,
			},
			input,
			path,
			searchValidation,
		);
	}
	function textAt(value: unknown, path: AuthoringPath) {
		const scope = scopeAt(path);
		return normalizeText(z.string().parse(value), (source) =>
			authoringXPath(
				doc,
				scope.formUuid,
				scope.resolveField,
				source,
				scope.typeContext.currentCaseType,
				scope.resolveSearchInput,
			),
		);
	}
	const decoders: AuthoringValueDecoders = {
		text: textAt,
		xpath(value, path) {
			const scope = scopeAt(path);
			return normalizeExpression(expression.parse(value), (source) =>
				authoringXPath(
					doc,
					scope.formUuid,
					scope.resolveField,
					source,
					scope.typeContext.currentCaseType,
					scope.resolveSearchInput,
					path.includes("connect"),
				),
			);
		},
		condition: (value, path) =>
			parseQueryPredicate(expression.parse(value), scopeAt(path)),
		value: (value, path) =>
			parseQueryValue(valueExpression.parse(value), scopeAt(path)),
		reference: (value, path) =>
			parseQueryReference(valueExpression.parse(value), scopeAt(path)),
		relationship: (value) => parseQueryRelationship(z.string().parse(value)),
		message(value, path) {
			const scope = scopeAt(path);
			return parseAuthoringMessage(
				z.string().parse(value),
				scope.typeContext.currentCaseType ?? "",
				scope.typeContext.caseTypes,
			);
		},
		localized(value, path) {
			const index = path[1];
			const unit =
				typeof index === "number" ? translated.get(index) : undefined;
			if (!unit)
				throw new AuthoringInputError(
					"Choose the source text before translating it.",
				);
			return unit.valueKind === "text"
				? z.string().parse(value)
				: textAt(value, path);
		},
	};
	return schema.parse(decodeAuthoringValues(schema, input, decoders));
}
