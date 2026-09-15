import { jsonSchema, type ToolSet } from "ai";
import { z } from "zod";
import { formSnapshot } from "@/lib/agent/blueprintHelpers";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { getModuleTool } from "@/lib/agent/tools/getModule";
import type { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import { printXPathInDoc } from "@/lib/doc/expressionText";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import {
	asUuid,
	type BlueprintDoc,
	proseTemplateSchema,
	xpathExpressionSchema,
} from "@/lib/domain";
import { normalizePilotInput } from "./normalize";
import {
	PILOT_DESCRIPTIONS,
	type PilotOperation,
	pilotSchemas,
} from "./schemas";
import { expressionSchema, printAuthoringText, textSchema } from "./values";

const toolNames: Record<Exclude<PilotOperation, "inspect">, string> = {
	declareRecords: "generateSchema",
	createModule: "createModule",
	createForm: "createForm",
	addFields: "addFields",
	editField: "editField",
	updateForm: "updateForm",
	addSearchInputs: "addSearchInputs",
};

function formAddress(ctx: ToolInvocationContext, formUuid: string) {
	const uuid = asUuid(formUuid);
	const moduleUuid = Object.entries(ctx.snapshot.doc.formOrder).find(
		([, forms]) => forms.includes(uuid),
	)?.[0];
	if (!moduleUuid || !ctx.snapshot.doc.forms[uuid])
		throw new Error(`Form ${formUuid} is not in this app.`);
	return { formUuid, moduleUuid };
}

async function inspect(
	ctx: ToolInvocationContext,
	input: z.infer<typeof pilotSchemas.inspect>,
): Promise<unknown> {
	const doc = ctx.snapshot.doc;
	if (!input.uuid) {
		return {
			name: doc.appName,
			caseTypes: doc.caseTypes,
			modules: doc.moduleOrder.map((uuid) => ({
				uuid,
				name: doc.modules[uuid]?.name,
				forms: (doc.formOrder[uuid] ?? []).map((formUuid) => ({
					uuid: formUuid,
					name: doc.forms[formUuid]?.name,
					type: doc.forms[formUuid]?.type,
				})),
			})),
		};
	}
	const uuid = asUuid(input.uuid);
	if (doc.modules[uuid])
		return (await getModuleTool.execute({ moduleUuid: uuid }, ctx)).data;
	if (doc.forms[uuid])
		return { ...formAddress(ctx, uuid), form: formSnapshot(doc, uuid) };
	if (doc.fields[uuid])
		return {
			fieldUuid: uuid,
			formUuid: findContainingForm(doc, uuid),
			field: doc.fields[uuid],
		};
	return { error: `No module, form, or field has UUID ${uuid}.` };
}

/** Read wording and logic in the same language accepted by writes. */
function readable(value: unknown, doc: BlueprintDoc, slot?: string): unknown {
	if (Array.isArray(value))
		return value.map((child) => readable(child, doc, slot));
	if (value === null || typeof value !== "object") return value;
	if (["label", "hint", "help", "msg"].includes(slot ?? "")) {
		const prose = proseTemplateSchema.safeParse(value);
		if (prose.success) return printAuthoringText(prose.data, doc);
	}
	if (
		[
			"required",
			"relevant",
			"calculate",
			"default_value",
			"validation",
			"expr",
		].includes(slot ?? "")
	) {
		const expression = xpathExpressionSchema.safeParse(value);
		if (expression.success) return printXPathInDoc(doc, expression.data);
	}
	const record = value as Record<string, unknown>;
	const validation = xpathExpressionSchema.safeParse(record.validate);
	const isField =
		typeof record.uuid === "string" &&
		doc.fields[asUuid(record.uuid)] !== undefined;
	const isForm =
		typeof record.uuid === "string" &&
		doc.forms[asUuid(record.uuid)] !== undefined;
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key]) =>
					!(validation.success && key === "validate_msg") &&
					!(slot === "options" && key === "uuid") &&
					!(
						isField &&
						record.repeat_mode &&
						["repeat_count", "data_source"].includes(key)
					),
			)
			.map(([key, child]) => {
				if (isForm && key === "postSubmit") return ["post_submit", child];
				if (isForm && key === "closeCondition") {
					const condition = child as {
						field: string;
						answer: string;
						operator?: string;
					};
					return [
						"close_condition",
						{
							...condition,
							field:
								computeFieldPath(doc, asUuid(condition.field)) ??
								condition.field,
						},
					];
				}
				if (isField && key === "repeat_mode")
					return [
						"repeat",
						{
							mode: child,
							...(record.repeat_count
								? { count: readable(record.repeat_count, doc, "expr") }
								: {}),
							...(record.data_source ?? {}),
						},
					];
				return [
					key,
					key === "validate" && validation.success
						? {
								expr: printXPathInDoc(doc, validation.data),
								...(record.validate_msg
									? { msg: readable(record.validate_msg, doc, "msg") }
									: {}),
							}
						: readable(child, doc, key),
				];
			}),
	);
}

export async function executePilotOperation(
	workspace: CanonicalMutationWorkspace,
	operation: PilotOperation,
	raw: unknown,
	requestId?: string,
): Promise<unknown> {
	return workspace.invoke({
		toolName: operation === "inspect" ? "inspect" : toolNames[operation],
		requestId,
		execute: async (ctx) => {
			const prepare = () => {
				try {
					const parsed = pilotSchemas[operation].parse(raw);
					if (operation === "inspect")
						throw new Error("Inspection is handled before preparation.");
					const toolName = toolNames[operation];
					const entry = SHARED_TOOL_REGISTRY.find(
						(entry) => entry.saName === toolName,
					);
					if (!entry) throw new Error(`Missing canonical tool ${toolName}.`);
					const input = normalizePilotInput(toolName, parsed, ctx.snapshot.doc);
					if (operation === "addFields" || operation === "updateForm")
						Object.assign(
							input,
							formAddress(ctx, z.string().parse(input.formUuid)),
						);
					if (operation === "editField") {
						const fieldUuid = asUuid(z.string().parse(input.fieldUuid));
						const field = ctx.snapshot.doc.fields[fieldUuid];
						const formUuid = findContainingForm(ctx.snapshot.doc, fieldUuid);
						if (!field || !formUuid)
							throw new Error(`Field ${fieldUuid} is not in this app.`);
						Object.assign(input, formAddress(ctx, formUuid));
						const updates = z
							.record(z.string(), z.unknown())
							.parse(input.updates);
						input.updates = { ...updates, kind: updates.kind ?? field.kind };
					}
					const canonical = entry.tool.inputSchema.parse(input);
					return { entry, canonical };
				} catch (error) {
					return {
						error:
							error instanceof z.ZodError
								? error.issues
										.map(
											(issue) =>
												`${issue.path.join(".") || "input"}: ${issue.message}`,
										)
										.join("\n")
								: error instanceof Error
									? error.message
									: String(error),
					};
				}
			};
			if (operation === "inspect")
				return readable(
					await inspect(ctx, pilotSchemas.inspect.parse(raw)),
					ctx.snapshot.doc,
				);
			const prepared = prepare();
			if ("error" in prepared)
				return { status: "rejected", error: prepared.error };
			const { entry, canonical } = prepared;
			const outcome = await entry.tool.execute(canonical as never, ctx);
			if (outcome.kind === "read")
				return readable(outcome.data, ctx.snapshot.doc);
			const result = outcome.result as Record<string, unknown>;
			if ("error" in result) return { status: "rejected", ...result };
			if ("needsConfirmation" in result)
				return { status: "needs_consent", ...result };
			const { summary: _summary, ...facts } = result;
			return {
				status: outcome.mutations.length ? "committed" : "unchanged",
				...facts,
			};
		},
	});
}

function conciseSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(conciseSchema);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key, value]) =>
					key !== "$schema" &&
					(key !== "description" ||
						value === textSchema.description ||
						value === expressionSchema.description),
			)
			.map(([key, child]) => [key, conciseSchema(child)]),
	);
}

export function nativePilotTools(workspace: CanonicalMutationWorkspace) {
	return Object.fromEntries(
		(Object.keys(pilotSchemas) as PilotOperation[]).map((name) => {
			const schema = pilotSchemas[name];
			return [
				name,
				{
					description: PILOT_DESCRIPTIONS[name],
					strict: false,
					inputSchema: jsonSchema<Record<string, unknown>>(
						conciseSchema(
							z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
						) as Parameters<typeof jsonSchema>[0],
						// Invocation validates once inside the workspace and returns
						// repairable issues without the SDK echoing the entire input.
					),
					execute: (
						input: Record<string, unknown>,
						options: { toolCallId: string },
					) =>
						executePilotOperation(workspace, name, input, options.toolCallId),
				},
			] as const;
		}),
	) satisfies ToolSet;
}

export const PILOT_GUIDANCE = `You are the Solutions Architect in CommCare Nova. You help people build CommCare apps for data collection and case management.

Understand the work the app will support. Design a coherent workflow, use clear language, and make important decisions with the user. A case is a record that persists between visits; use separate related records when each visit needs its own history.

Build complete workflows, with useful questions, appropriate checks, and sensible navigation. Read the current app before editing, preserve unrelated work, and resolve problems you encounter. Tell the user what works and what still needs their attention.`;
