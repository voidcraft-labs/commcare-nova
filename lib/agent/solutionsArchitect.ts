/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * Tools are split into two groups: **generation** (schema, scaffold, columns) and
 * **shared** (conversation, read, mutation, validation). In edit mode (existing app),
 * generation tools are excluded — the SA only gets shared tools and an editing prompt
 * with a blueprint summary. In build mode (new app), all tools are available.
 *
 * Vocabulary is domain-native: tool arguments, return shapes, and the
 * system prompt all use `field` / `kind` / `validate` / `validate_msg` /
 * `case_property`. Tool args flow straight into the reducer helpers in
 * `blueprintHelpers.ts`. `validateAndFix` (in `validationLoop.ts`) reads
 * the normalized doc directly, runs XForm validation via
 * `lib/commcare/`, and returns a normalized doc with any auto-fixes
 * applied.
 *
 * Stream-event payloads carry fine-grained `data-mutations` events
 * emitted via `ctx.emitMutations` for every tool-level change; the
 * final `data-done` from `validateApp` carries a normalized doc snapshot.
 */
import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { errorToString } from "@/lib/commcare/validator/errors";
import { completeApp } from "@/lib/db/apps";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	ConnectConfig,
	FormType,
	PostSubmitDestination,
} from "@/lib/domain";
import { FORM_TYPES, USER_FACING_DESTINATIONS } from "@/lib/domain";
import { log } from "@/lib/logger";
import { SA_MODEL, SA_REASONING } from "@/lib/models";
import {
	addFormMutations,
	addModuleMutations,
	removeFieldMutations,
	removeFormMutations,
	removeModuleMutations,
	resolveFieldByIndex,
	resolveFormUuid,
	updateFormMutations,
	updateModuleMutations,
} from "./blueprintHelpers";
import type { GenerationContext } from "./generationContext";
import { buildSolutionsArchitectPrompt } from "./prompts";
import { addFieldTool } from "./tools/addField";
import { addFieldsTool } from "./tools/addFields";
import { addModuleTool } from "./tools/addModule";
import { askQuestionsTool } from "./tools/askQuestions";
import { applyToDoc } from "./tools/common";
import { editFieldTool } from "./tools/editField";
import { generateScaffoldTool } from "./tools/generateScaffold";
import { generateSchemaTool } from "./tools/generateSchema";
import { getFieldTool } from "./tools/getField";
import { getFormTool } from "./tools/getForm";
import { getModuleTool } from "./tools/getModule";
import { searchBlueprintTool } from "./tools/searchBlueprint";
import { validateAndFix } from "./validationLoop";

export { validateAndFix } from "./validationLoop";

/**
 * Names of SA tools exposed only in build mode. Sourced from the tool
 * modules themselves (each exports a literal-typed `name`) so a rename
 * at the tool module is the only edit needed to keep this list in sync.
 *
 * The chat route uses this list to strip build-only tool-use parts from
 * message history on edit-mode requests — Anthropic rejects any tool
 * reference whose name isn't in the current tools array, and a
 * mid-session edit right after a build would otherwise carry these
 * references in its history.
 */
export const BUILD_ONLY_TOOL_NAMES = [
	generateSchemaTool.name,
	generateScaffoldTool.name,
	addModuleTool.name,
] as const;

// ── Doc helpers ───────────────────────────────────────────────────────

/**
 * `FormSnapshot` is the domain-vocab form-plus-fields shape the SA's
 * `getForm` tool returns. The type and its builder live in
 * `blueprintHelpers.ts` alongside other positional `BlueprintDoc`
 * readers; re-exporting here lets agent-layer consumers import the
 * type from the same surface they import the SA factory.
 */
export type { FormSnapshot } from "./blueprintHelpers";

// ── Helper: build a full ConnectConfig from SA's partial input ────────

/**
 * Converts the SA's partial connect input into a proper ConnectConfig.
 * The SA only sets fields it should know about (learn_module, assessment,
 * deliver_unit.name, task). System-derived fields (entity_id, entity_name)
 * are preserved from the existing config or left empty for auto-derivation.
 */
function buildConnectConfig(
	input: {
		learn_module?: {
			id?: string;
			name: string;
			description: string;
			time_estimate: number;
		};
		assessment?: { id?: string; user_score: string };
		deliver_unit?: { name: string };
		task?: { name: string; description: string };
	} | null,
	existing?: ConnectConfig,
): ConnectConfig | null {
	if (input === null) return null;
	return {
		learn_module: input.learn_module
			? { ...existing?.learn_module, ...input.learn_module }
			: input.learn_module,
		assessment: input.assessment
			? { ...existing?.assessment, ...input.assessment }
			: input.assessment,
		deliver_unit: input.deliver_unit
			? {
					...existing?.deliver_unit,
					...input.deliver_unit,
					entity_id: existing?.deliver_unit?.entity_id ?? "",
					entity_name: existing?.deliver_unit?.entity_name ?? "",
				}
			: input.deliver_unit,
		task: input.task ? { ...existing?.task, ...input.task } : input.task,
	};
}

// ── Solutions Architect Agent ────────────────────────────────────────

/**
 * Create the Solutions Architect agent.
 *
 * @param initialDoc - The SA's starting `BlueprintDoc`. On initial builds
 *   this is the empty doc created by `createApp`; during edits it's the
 *   app's current state loaded from Firestore. The SA owns this doc for
 *   the lifetime of the agent — every tool call mutates it in place.
 * @param editing - True when the app already exists (appReady). The SA gets
 *   the editing preamble + blueprint summary in its prompt and only has access
 *   to read + mutation + validation tools. False during initial builds, where
 *   the SA gets the full tool set and build-mode prompt.
 */
export function createSolutionsArchitect(
	ctx: GenerationContext,
	initialDoc: BlueprintDoc,
	editing = false,
) {
	// Internal doc state — the SA reads + mutates this on every tool call.
	// It's the single source of truth; wire-format snapshots are generated
	// on demand for LLM-facing outputs and for the CommCare validator.
	let doc: BlueprintDoc = initialDoc;

	/**
	 * Apply a mutation batch to the SA's working doc AND emit it on the
	 * context in one step. Every tool handler routes mutations through
	 * this helper so both steps stay atomic at the call site:
	 *
	 *   1. Compute the post-mutation doc via `applyToDoc` (Immer).
	 *   2. Emit the batch through `ctx.emitMutations(muts, newDoc, stage)`
	 *      — the SSE write + log enqueue + fire-and-forget Firestore save
	 *      all run against the SAME snapshot we're about to adopt.
	 *   3. Reassign `doc` so the next tool call reads the new state.
	 *
	 * Ordering matters: emit BEFORE reassign so no race exists between
	 * the SSE payload the client applies and the working doc we advance
	 * to. Empty batches short-circuit before any emission happens, so
	 * callers can invoke this unconditionally after a helper that may
	 * return `[]`.
	 *
	 * `stage` is required at this layer — every SA call site explicitly
	 * tags its batch. The underlying `ctx.emitMutations` leaves stage
	 * optional for callers outside the SA that don't have a meaningful
	 * tag.
	 */
	const emit = (muts: Mutation[], stage: string): void => {
		if (muts.length === 0) return;
		const newDoc = applyToDoc(doc, muts);
		ctx.emitMutations(muts, newDoc, stage);
		doc = newDoc;
	};

	// ── Generation tools (build mode only) ────────────────────────────
	// These drive the initial build sequence: schema → scaffold → columns → fields.
	// Excluded in edit mode — the SA uses mutation tools instead.
	//
	// Every mutating-tool wrapper below delegates to a shared module in
	// `./tools/`. The shared module computes mutations, emits them on SSE
	// + log, and persists via `ctx.recordMutations`. Each wrapper advances
	// the SA's working doc closure when the batch is non-empty so the next
	// tool call in the same request sees updated state for index → uuid
	// resolution.

	const generationTools = {
		generateSchema: tool({
			description: generateSchemaTool.description,
			inputSchema: generateSchemaTool.inputSchema,
			strict: generateSchemaTool.strict,
			execute: async (input) => {
				const { mutations, newDoc, result } = await generateSchemaTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		generateScaffold: tool({
			description: generateScaffoldTool.description,
			inputSchema: generateScaffoldTool.inputSchema,
			strict: generateScaffoldTool.strict,
			execute: async (input) => {
				const { mutations, newDoc, result } =
					await generateScaffoldTool.execute(input, ctx, doc);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		addModule: tool({
			description: addModuleTool.description,
			inputSchema: addModuleTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await addModuleTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),
	};

	// ── Shared tools (all modes) ─────────────────────────────────────
	// Conversation, batch add, read, mutation, and validation tools.

	const sharedTools = {
		askQuestions: {
			description: askQuestionsTool.description,
			inputSchema: askQuestionsTool.inputSchema,
			// No execute → client-side tool, agent stops for user input
		},

		addFields: tool({
			description: addFieldsTool.description,
			inputSchema: addFieldsTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await addFieldsTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		// ── Read ────────────────────────────────────────────────────────

		searchBlueprint: tool({
			description: searchBlueprintTool.description,
			inputSchema: searchBlueprintTool.inputSchema,
			execute: async (input) => searchBlueprintTool.execute(input, ctx, doc),
		}),

		getModule: tool({
			description: getModuleTool.description,
			inputSchema: getModuleTool.inputSchema,
			execute: async (input) => getModuleTool.execute(input, ctx, doc),
		}),

		getForm: tool({
			description: getFormTool.description,
			inputSchema: getFormTool.inputSchema,
			execute: async (input) => getFormTool.execute(input, ctx, doc),
		}),

		getField: tool({
			description: getFieldTool.description,
			inputSchema: getFieldTool.inputSchema,
			execute: async (input) => getFieldTool.execute(input, ctx, doc),
		}),

		// ── Field mutations ────────────────────────────────────────

		editField: tool({
			description: editFieldTool.description,
			inputSchema: editFieldTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await editFieldTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		addField: tool({
			description: addFieldTool.description,
			inputSchema: addFieldTool.inputSchema,
			execute: async (input) => {
				const { mutations, newDoc, result } = await addFieldTool.execute(
					input,
					ctx,
					doc,
				);
				if (mutations.length > 0) doc = newDoc;
				return result;
			},
		}),

		removeField: tool({
			description: "Remove a field from a form.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				fieldId: z.string().describe("Field id to remove"),
			}),
			execute: async ({ moduleIndex, formIndex, fieldId }) => {
				try {
					const resolved = resolveFieldByIndex(
						doc,
						moduleIndex,
						formIndex,
						fieldId,
					);
					if (!resolved)
						return {
							error: `Field "${fieldId}" not found in m${moduleIndex}-f${formIndex}`,
						};
					const formUuid = resolved.formUuid;
					const beforeCount = countFieldsUnder(doc, formUuid);
					const muts = removeFieldMutations(doc, resolved.field.uuid);
					emit(muts, `form:${moduleIndex}-${formIndex}`);
					const formName = doc.forms[formUuid]?.name ?? "";
					const afterCount = countFieldsUnder(doc, formUuid);
					return `Successfully removed field "${fieldId}" from "${formName}". Fields: ${beforeCount} → ${afterCount}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		// ── Structural mutations ──────────────────────────────────────

		updateModule: tool({
			description:
				"Update module metadata: name, case list columns, or case detail columns.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				name: z.string().optional().describe("New module name"),
				case_list_columns: z
					.array(
						z.object({
							field: z.string().describe("Case property name"),
							header: z.string().describe("Column header text"),
						}),
					)
					.optional()
					.describe("New case list columns"),
				case_detail_columns: z
					.array(
						z.object({
							field: z.string().describe("Case property name"),
							header: z
								.string()
								.describe("Display label for this detail field"),
						}),
					)
					.nullable()
					.optional()
					.describe("Columns for case detail view. null to remove."),
			}),
			execute: async ({
				moduleIndex,
				name,
				case_list_columns,
				case_detail_columns,
			}) => {
				try {
					const moduleUuid = doc.moduleOrder[moduleIndex];
					if (!moduleUuid) return { error: `Module ${moduleIndex} not found` };
					const patch: Parameters<typeof updateModuleMutations>[2] = {};
					if (name !== undefined) patch.name = name;
					if (case_list_columns !== undefined)
						patch.caseListColumns = case_list_columns;
					if (case_detail_columns !== undefined) {
						patch.caseDetailColumns =
							case_detail_columns === null ? null : case_detail_columns;
					}
					const muts = updateModuleMutations(doc, moduleUuid, patch);
					emit(muts, `module:${moduleIndex}`);
					const mod = doc.modules[moduleUuid];
					if (!mod)
						return { error: `Module ${moduleIndex} not found after update` };
					const changes: string[] = [];
					if (name !== undefined) changes.push(`name → "${mod.name}"`);
					if (case_list_columns !== undefined)
						changes.push(
							`case list columns (${mod.caseListColumns?.length ?? 0})`,
						);
					if (case_detail_columns !== undefined)
						changes.push(
							case_detail_columns === null
								? "case detail columns removed"
								: `case detail columns (${mod.caseDetailColumns?.length ?? 0})`,
						);
					return `Successfully updated module "${mod.name}" (index ${moduleIndex}). Changed: ${changes.join(", ")}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		updateForm: tool({
			description:
				"Update form metadata: name, close condition (close forms only), Connect integration, or post-submit navigation.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				name: z.string().optional().describe("New form name"),
				close_condition: z
					.object({
						field: z.string().describe("Field id to check"),
						answer: z.string().describe("Value that triggers closure"),
						operator: z
							.enum(["=", "selected"])
							.optional()
							.describe(
								'"=" for exact match (default). "selected" for multi-select fields.',
							),
					})
					.nullable()
					.optional()
					.describe(
						'Close forms only. Set conditional close. Use operator "selected" for multi-select fields. null to make unconditional (default). Omit to leave unchanged.',
					),
				post_submit: z
					.enum(USER_FACING_DESTINATIONS)
					.nullable()
					.optional()
					.describe(
						"Where the user goes after submitting this form. " +
							'"app_home" = main menu. ' +
							'"module" = this module\'s form list. ' +
							'"previous" = back to where the user was (e.g. case list). ' +
							'Defaults to "previous" for followup, "app_home" for registration/survey. ' +
							"null to reset to default. Omit to leave unchanged.",
					),
				connect: z
					.object({
						learn_module: z
							.object({
								id: z.string().optional(),
								name: z.string(),
								description: z.string(),
								time_estimate: z.number(),
							})
							.optional()
							.describe(
								"Set for forms with educational/training content. Omit for quiz-only forms.",
							),
						assessment: z
							.object({ id: z.string().optional(), user_score: z.string() })
							.optional()
							.describe(
								"Set for forms with a quiz/test. Omit for content-only forms.",
							),
						deliver_unit: z.object({ name: z.string() }).optional(),
						task: z
							.object({ name: z.string(), description: z.string() })
							.optional(),
					})
					.nullable()
					.optional()
					.describe(
						"Set Connect config on this form. null to remove. Learn apps: set learn_module and/or assessment independently. Deliver apps: set deliver_unit and/or task independently.",
					),
			}),
			execute: async ({
				moduleIndex,
				formIndex,
				name,
				close_condition,
				post_submit,
				connect,
			}) => {
				try {
					const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
					if (!formUuid)
						return { error: `Form m${moduleIndex}-f${formIndex} not found` };
					const existing = doc.forms[formUuid];
					if (!existing)
						return { error: `Form m${moduleIndex}-f${formIndex} not found` };

					// Build the helper's patch shape. The SA's tool arg uses
					// `field` directly — no translation needed since the SA
					// speaks domain vocabulary. `null` clears.
					const patch: Parameters<typeof updateFormMutations>[2] = {};
					if (name !== undefined) patch.name = name;
					if (close_condition !== undefined) {
						patch.closeCondition =
							close_condition === null
								? null
								: {
										field: close_condition.field,
										answer: close_condition.answer,
										...(close_condition.operator && {
											operator: close_condition.operator,
										}),
									};
					}
					if (post_submit !== undefined) {
						patch.postSubmit = post_submit as PostSubmitDestination | null;
					}
					if (connect !== undefined) {
						patch.connect = buildConnectConfig(
							connect,
							existing.connect ?? undefined,
						);
					}
					// Stream the form-metadata mutations the helper produced and
					// advance the SA's doc atomically. Clients apply the same
					// granular mutations via `applyMany` to stay in lockstep.
					const muts = updateFormMutations(doc, formUuid, patch);
					emit(muts, `form:${moduleIndex}-${formIndex}`);

					const formAfter = doc.forms[formUuid];
					if (!formAfter)
						return {
							error: `Form m${moduleIndex}-f${formIndex} not found after update`,
						};
					const formChanges: string[] = [];
					if (name !== undefined)
						formChanges.push(`name → "${formAfter.name}"`);
					if (close_condition !== undefined)
						formChanges.push(
							close_condition === null
								? "close_condition removed (unconditional close)"
								: "close_condition updated",
						);
					if (post_submit !== undefined)
						formChanges.push(
							`post_submit → "${formAfter.postSubmit ?? "form-type default"}"`,
						);
					if (connect !== undefined)
						formChanges.push(
							connect === null ? "connect removed" : "connect updated",
						);
					return `Successfully updated form "${formAfter.name}" (${formAfter.type}, m${moduleIndex}-f${formIndex}). Changed: ${formChanges.join(", ")}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		createForm: tool({
			description:
				"Add a new empty form to a module. Use addFields to populate it.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				name: z.string().describe("Form display name"),
				type: z
					.enum(FORM_TYPES)
					.describe(
						'"registration" creates a new case. "followup" updates an existing case. "close" loads and closes an existing case. "survey" is standalone.',
					),
				post_submit: z
					.enum(USER_FACING_DESTINATIONS)
					.optional()
					.describe(
						'Where the user goes after submitting. Defaults to "previous" for followup/close, "app_home" for registration/survey. Only set to override.',
					),
			}),
			execute: async ({ moduleIndex, name, type, post_submit }) => {
				try {
					const moduleUuid = doc.moduleOrder[moduleIndex];
					if (!moduleUuid) return { error: `Module ${moduleIndex} not found` };
					// Tag under the parent module so the event log groups this
					// creation event with the rest of that module's activity.
					const muts = addFormMutations(doc, moduleUuid, {
						name,
						type: type as FormType,
						...(post_submit && {
							postSubmit: post_submit as PostSubmitDestination,
						}),
					});
					emit(muts, `module:${moduleIndex}`);
					const mod = doc.modules[moduleUuid];
					const forms = doc.formOrder[moduleUuid] ?? [];
					const newFormIndex = forms.length - 1;
					return `Successfully created form "${name}" (${type}) in module "${mod?.name ?? moduleIndex}" at index m${moduleIndex}-f${newFormIndex}. Module now has ${forms.length} form${forms.length === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		removeForm: tool({
			description: "Remove a form from a module.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
			}),
			execute: async ({ moduleIndex, formIndex }) => {
				try {
					const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
					const removedName = formUuid
						? (doc.forms[formUuid]?.name ?? `form ${formIndex}`)
						: `form ${formIndex}`;
					// Only emit + apply when the form actually exists; a missing
					// form resolves to `undefined` and we fall through with an
					// informational success message instead of crashing.
					if (formUuid) {
						const muts = removeFormMutations(doc, formUuid);
						emit(muts, `form:${moduleIndex}-${formIndex}`);
					}
					const moduleUuid = doc.moduleOrder[moduleIndex];
					const mod = moduleUuid ? doc.modules[moduleUuid] : undefined;
					const remainingForms =
						(moduleUuid && doc.formOrder[moduleUuid]) ?? [];
					return `Successfully removed form "${removedName}" from module "${mod?.name ?? `module ${moduleIndex}`}". Module now has ${remainingForms.length} form${remainingForms.length === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		createModule: tool({
			description: "Add a new module to the app.",
			inputSchema: z.object({
				name: z.string().describe("Module display name"),
				case_type: z
					.string()
					.optional()
					.describe(
						"Case type (required if module will have registration/followup forms)",
					),
				case_list_only: z
					.boolean()
					.optional()
					.describe(
						"True for case-list-only modules with no forms. Use for child case types that need to be viewable but have no follow-up workflow.",
					),
				case_list_columns: z
					.array(
						z.object({
							field: z.string().describe("Case property name"),
							header: z.string().describe("Column header text"),
						}),
					)
					.optional()
					.describe("Case list columns"),
			}),
			execute: async ({
				name,
				case_type,
				case_list_only,
				case_list_columns,
			}) => {
				try {
					// `module:create` stage tag — no index yet because the new
					// module's index only exists after the mutations apply.
					const muts = addModuleMutations(doc, {
						name,
						...(case_type && { caseType: case_type }),
						...(case_list_only && { caseListOnly: case_list_only }),
						...(case_list_columns && {
							caseListColumns: case_list_columns,
						}),
					});
					emit(muts, "module:create");
					const newModIndex = doc.moduleOrder.length - 1;
					return `Successfully created module "${name}" at index ${newModIndex}${case_type ? ` (case type: ${case_type})` : ""}. App now has ${doc.moduleOrder.length} module${doc.moduleOrder.length === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		removeModule: tool({
			description: "Remove a module from the app.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
			}),
			execute: async ({ moduleIndex }) => {
				try {
					const moduleUuid = doc.moduleOrder[moduleIndex];
					const name = moduleUuid
						? (doc.modules[moduleUuid]?.name ?? null)
						: null;
					// Only emit + apply when the module actually exists; mirror
					// the removeForm guard for consistency.
					if (moduleUuid) {
						const muts = removeModuleMutations(doc, moduleUuid);
						emit(muts, `module:remove:${moduleIndex}`);
					}
					return `Successfully removed module "${name ?? `module ${moduleIndex}`}". App now has ${doc.moduleOrder.length} module${doc.moduleOrder.length === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		// ── Validation ────────────────────────────────────────────────

		validateApp: tool({
			description:
				"Validate the app against CommCare platform rules and fix any issues. Call this when you are done building or editing. If validation fails with remaining errors, use your mutation tools (removeField, editField, etc.) to fix them, then call validateApp again.",
			inputSchema: z.object({}),
			execute: async () => {
				// `validateAndFix` owns the XForm-compiler boundary: it takes
				// our doc, runs CommCare-flavored validation + auto-fixes on a
				// blueprint snapshot, and hands back a doc with any fix-registry
				// mutations folded in. We replace our working doc with that
				// result so subsequent tool calls see the patched state.
				const result = await validateAndFix(ctx, doc);
				if (result.success) {
					doc = result.doc;

					const persistable = toPersistableDoc(doc);

					ctx.emit("data-done", {
						doc: persistable,
						hqJson: result.hqJson ?? {},
						success: true,
					});

					/* Update the app with the final validated doc (fire-and-forget).
					 * The app document was created at the start of the request by
					 * the route handler — `ctx.appId` is always present by
					 * construction. We persist the normalized doc shape directly;
					 * `completeApp` accepts `PersistableDoc`. The runId is the
					 * same value the event log uses; `UsageAccumulator` is the
					 * single source of truth. */
					completeApp(ctx.appId, persistable, ctx.usage.runId).catch((err) =>
						log.error("[validateApp] app update failed", err),
					);

					return { success: true as const };
				}
				// Keep the SA's doc aligned with the fix loop's output even on
				// failure — later tool calls should see any partial fixes the
				// registry managed to apply before giving up.
				doc = result.doc;
				// Surface remaining errors as strings so the SA can read and fix them.
				return {
					success: false as const,
					errors: (result.errors ?? []).map(errorToString),
				};
			},
		}),
	};

	// ── Compose tools and build agent ────────────────────────────────
	// Edit mode: only shared tools (read + mutation + validate).
	// Build mode: shared tools + generation tools (schema → scaffold → columns).

	const tools = editing ? sharedTools : { ...sharedTools, ...generationTools };

	const agent = new ToolLoopAgent({
		model: ctx.model(SA_MODEL),
		// The prompt summary is rendered from the current normalized doc
		// when the app already exists. `buildSolutionsArchitectPrompt`
		// walks the normalized doc directly and produces a domain-vocab
		// summary.
		instructions: buildSolutionsArchitectPrompt(editing ? doc : undefined),
		stopWhen: stepCountIs(80),
		prepareStep: ({ steps: _steps }) => {
			// Adaptive thinking with `display: 'summarized'` is required on Opus 4.7
			// for human-readable thinking summaries to stream back. `effort` is a
			// top-level provider option (sibling of `thinking`), not nested inside
			// it — Zod silently strips nested unknown fields.
			const anthropic: AnthropicProviderOptions = {
				cacheControl: { type: "ephemeral" },
				thinking: { type: "adaptive", display: "summarized" },
				effort: SA_REASONING.effort,
			};
			return { providerOptions: { anthropic } };
		},
		onStepFinish: (step) => {
			/* Delegate step-level fan-out (usage + conversation events +
			 * tool-call counting) to the shared handler on GenerationContext.
			 * We map the AI SDK's step-finish argument into the normalized
			 * AgentStep shape here so the handler stays SDK-version stable.
			 * `toolResults` is loosely typed by the SDK — narrow at the
			 * boundary rather than inside the shared helper. */
			ctx.handleAgentStep(
				{
					usage: step.usage,
					text: step.text,
					reasoningText: step.reasoningText,
					toolCalls: step.toolCalls?.map((tc) => ({
						toolCallId: tc.toolCallId,
						toolName: tc.toolName,
						input: tc.input,
					})),
					toolResults:
						(step.toolResults as Array<{
							toolCallId: string;
							output: unknown;
						}>) ?? undefined,
					warnings: step.warnings,
				},
				"Solutions Architect",
			);
		},
		tools,
	});

	return agent;
}
