/**
 * Granular executor-only staging tools — private structure creation without
 * canonical completeness.
 *
 * The canonical `createModule`/`createForm` tools deliberately require
 * complete nested entities so one call reaches a valid state. In a PRIVATE
 * change set that completeness is unnecessary — no canonical write occurs —
 * so these tools expose the granular canonical mutation builders instead:
 * a bare module, a form without fields. The private candidate may then carry
 * `EMPTY_FORM`/`NO_FORMS_OR_CASE_LIST` findings as diagnostics until later
 * steps resolve them.
 *
 * Only INCOMPLETENESS earns a staging tool. Reordering a module is complete
 * either way, so it stays the shared canonical `moveModule` — a change set
 * dispatches that one like any other stageable shared tool.
 *
 * They still enforce exact identity, valid parent topology for entities
 * that exist, canonical field/entity schemas, and deterministic mutation
 * order — the admission/reducer rules are never forked. The existing shared
 * granular edit tools (`addFields`, case-list config, …) operate on the
 * overlay once these targets exist.
 *
 * These modules register ONLY in the change-set registry
 * (`registry.ts`); no canonical surface can reach them, and the model-facing
 * executor wrappers land with the executor unit.
 */

import { z } from "zod";
import type {
	MutatingToolResult,
	ReadToolResult,
} from "@/lib/agent/tools/common";
import { guardedMutate } from "@/lib/agent/tools/common";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import { declareCaseTypeMutations } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { Form, Module } from "@/lib/domain";
import { FORM_TYPES } from "@/lib/domain/forms";
import { uniqueSlug } from "@/lib/domain/idSlug";
import { asUuid, uuidSchema } from "@/lib/domain/uuid";
import { asHandleRef, type StagedHandleDeclaration } from "./handles";
import type { StagedEntityKind } from "./schemas";

/** One executor-only staging tool: a shared-tool-shaped module plus the
 *  declaration metadata the workspace mints handles from. */
export interface ChangeSetStageToolModule {
	readonly description: string;
	readonly inputSchema: z.ZodObject<z.ZodRawShape>;
	execute(
		input: unknown,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<unknown> | ReadToolResult<unknown>>;
	/** Which RAW input slots declare new handles, read before resolution. */
	declaredHandles(input: unknown): readonly StagedHandleDeclaration[];
}

function declarationAt(
	input: unknown,
	key: string,
	entityKind: StagedEntityKind,
): readonly StagedHandleDeclaration[] {
	if (typeof input !== "object" || input === null) return [];
	const handle = asHandleRef((input as Record<string, unknown>)[key]);
	return handle === null ? [] : [{ handle, entityKind }];
}

function existingModuleIds(doc: {
	modules: Record<string, { id: string }>;
}): Set<string> {
	return new Set(Object.values(doc.modules).map((module) => module.id));
}

function existingFormIds(doc: {
	forms: Record<string, { id: string }>;
}): Set<string> {
	return new Set(Object.values(doc.forms).map((form) => form.id));
}

// ── stageModule ────────────────────────────────────────────────────

const stageModuleInputSchema = z
	.object({
		moduleUuid: uuidSchema
			.optional()
			.describe(
				"Identity for the new module. Pass the handle you want bound (as { handle }) or omit to mint one.",
			),
		name: z.string().min(1),
		case_type: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Case type this module manages. Declared into the catalog when new; the case list may stay incomplete privately.",
			),
		after: uuidSchema.nullable().optional(),
	})
	.strict();

export const stageModuleTool: ChangeSetStageToolModule = {
	description:
		"Stage one module privately, without requiring its forms or case-list completeness yet. Later staged steps complete it before commit.",
	inputSchema: stageModuleInputSchema,
	declaredHandles: (input) => declarationAt(input, "moduleUuid", "module"),
	async execute(input, ctx) {
		const parsed = stageModuleInputSchema.parse(input);
		const doc = ctx.snapshot.doc;
		const uuid = parsed.moduleUuid ?? asUuid(crypto.randomUUID());
		const module: Module = {
			uuid,
			id: uniqueSlug(parsed.name, "module", existingModuleIds(doc)),
			name: parsed.name,
			...(parsed.case_type !== undefined && { caseType: parsed.case_type }),
		};
		const mutations: Mutation[] = [
			...(parsed.case_type === undefined
				? []
				: declareCaseTypeMutations(doc, parsed.case_type)),
			{
				kind: "addModule",
				module,
				...(parsed.after !== undefined && { after: parsed.after }),
			},
		];
		const commit = await guardedMutate(ctx, mutations);
		if (!commit.ok)
			return { kind: "mutate", mutations, result: { error: commit.error } };
		return {
			kind: "mutate",
			mutations,
			result: {
				message: `Staged module "${parsed.name}" (${uuid}). It stays private to this change set until commit.`,
				moduleUuid: uuid,
				...(commit.staged !== undefined && { receipt: commit.staged }),
			},
		};
	},
};

// ── stageForm ──────────────────────────────────────────────────────

const stageFormInputSchema = z
	.object({
		formUuid: uuidSchema.optional(),
		moduleUuid: uuidSchema,
		name: z.string().min(1),
		type: z.enum(FORM_TYPES),
		after: uuidSchema.nullable().optional(),
	})
	.strict();

export const stageFormTool: ChangeSetStageToolModule = {
	description:
		"Stage one form privately inside a staged or existing module, without requiring fields yet.",
	inputSchema: stageFormInputSchema,
	declaredHandles: (input) => declarationAt(input, "formUuid", "form"),
	async execute(input, ctx) {
		const parsed = stageFormInputSchema.parse(input);
		const doc = ctx.snapshot.doc;
		if (doc.modules[parsed.moduleUuid] === undefined) {
			return {
				kind: "mutate",
				mutations: [],
				result: {
					error: `No module with identity ${parsed.moduleUuid} exists in this change set's candidate. Stage the module first, or use its handle.`,
				},
			};
		}
		const uuid = parsed.formUuid ?? asUuid(crypto.randomUUID());
		const form: Form = {
			uuid,
			id: uniqueSlug(parsed.name, "form", existingFormIds(doc)),
			name: parsed.name,
			type: parsed.type,
		};
		const mutations: Mutation[] = [
			{
				kind: "addForm",
				moduleUuid: parsed.moduleUuid,
				form,
				...(parsed.after !== undefined && { after: parsed.after }),
			},
		];
		const commit = await guardedMutate(ctx, mutations);
		if (!commit.ok)
			return { kind: "mutate", mutations, result: { error: commit.error } };
		return {
			kind: "mutate",
			mutations,
			result: {
				message: `Staged ${parsed.type} form "${parsed.name}" (${uuid}) in module ${parsed.moduleUuid}.`,
				formUuid: uuid,
				...(commit.staged !== undefined && { receipt: commit.staged }),
			},
		};
	},
};

export const CHANGE_SET_STAGE_TOOLS = [
	{ name: "stageModule", tool: stageModuleTool },
	{ name: "stageForm", tool: stageFormTool },
] as const;
