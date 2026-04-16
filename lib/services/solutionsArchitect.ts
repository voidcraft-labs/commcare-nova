/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * Tools are split into two groups: **generation** (schema, scaffold, columns) and
 * **shared** (conversation, read, mutation, validation). In edit mode (existing app),
 * generation tools are excluded — the SA only gets shared tools and an editing prompt
 * with a blueprint summary. In build mode (new app), all tools are available.
 */
import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { isStepCount, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { log } from "@/lib/log";
import { completeApp } from "../db/apps";
import { SA_MODEL, SA_REASONING } from "../models";
import { buildSolutionsArchitectPrompt } from "../prompts/solutionsArchitectPrompt";
import {
	type AppBlueprint,
	type ConnectConfig,
	caseTypesOutputSchema,
	FORM_TYPES,
	moduleContentSchema,
	type Question,
	scaffoldModulesSchema,
} from "../schemas/blueprint";
import {
	applyDefaults,
	buildQuestionTree,
	type FlatQuestion,
	flattenToFlat,
	stripEmpty,
} from "../schemas/contentProcessing";
import {
	addQuestionQuestionSchema,
	addQuestionsQuestionSchema,
	editQuestionUpdatesSchema,
} from "../schemas/toolSchemas";
import {
	addForm as bpAddForm,
	addModule as bpAddModule,
	addQuestion as bpAddQuestion,
	removeForm as bpRemoveForm,
	removeModule as bpRemoveModule,
	removeQuestion as bpRemoveQuestion,
	renameCaseProperty as bpRenameCaseProperty,
	renameQuestion as bpRenameQuestion,
	replaceForm as bpReplaceForm,
	setCaseTypes as bpSetCaseTypes,
	setScaffold as bpSetScaffold,
	updateForm as bpUpdateForm,
	updateModule as bpUpdateModule,
	updateQuestion as bpUpdateQuestion,
	findByPath,
	type NewQuestion,
	resolveQuestionId,
	searchBlueprint,
} from "./blueprintHelpers";
import { errorToString } from "./commcare/validate/errors";
import { type GenerationContext, logWarnings } from "./generationContext";
import { validateAndFix } from "./validationLoop";

export { validateAndFix } from "./validationLoop";

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

// ── Helper: count questions recursively ───────────────────────────────

function countQuestionsRecursive(questions: Question[]): number {
	let count = 0;
	for (const q of questions) {
		count++;
		if (q.children) count += countQuestionsRecursive(q.children);
	}
	return count;
}

// ── askQuestions schema ──────────────────────────────────────────────

const askQuestionsSchema = z.object({
	header: z.string().describe("Short header for this group of questions"),
	questions: z.array(
		z.object({
			question: z.string(),
			options: z.array(
				z.object({
					label: z.string(),
					description: z.string().optional(),
				}),
			),
		}),
	),
});

// ── Solutions Architect Agent ────────────────────────────────────────

/**
 * Create the Solutions Architect agent.
 *
 * @param editing - True when the app already exists (appReady). The SA gets
 *   the editing preamble + blueprint summary in its prompt and only has access
 *   to read + mutation + validation tools. False during initial builds, where
 *   the SA gets the full tool set and build-mode prompt.
 */
export function createSolutionsArchitect(
	ctx: GenerationContext,
	bp: AppBlueprint,
	editing = false,
) {
	// ── Generation tools (build mode only) ────────────────────────────
	// These drive the initial build sequence: schema → scaffold → columns → questions.
	// Excluded in edit mode — the SA uses mutation tools instead.

	const generationTools = {
		generateSchema: tool({
			description:
				"Set the data model (case types and properties) for the app. Call this first before generateScaffold. Provide the structured case types directly.",
			inputSchema: z.object({
				appName: z.string().describe("Short app name (2-5 words)"),
				caseTypes: caseTypesOutputSchema.shape.case_types,
			}),
			strict: true,
			onInputStart: () => {
				ctx.emit("data-start-build", {});
				ctx.emit("data-phase", { phase: "data-model" });
			},
			execute: async ({ appName, caseTypes }) => {
				bpSetCaseTypes(bp, caseTypes);
				bp.app_name = appName;
				ctx.emit("data-schema", { caseTypes });

				return {
					appName,
					caseTypes: caseTypes.map((ct) => ({
						name: ct.name,
						propertyCount: ct.properties.length,
						properties: ct.properties.map((p) => p.name),
					})),
				};
			},
		}),

		generateScaffold: tool({
			description:
				"Set the module and form structure for the app. Call after generateSchema. Provide the complete scaffold directly.",
			inputSchema: scaffoldModulesSchema,
			strict: true,
			onInputStart: () => {
				ctx.emit("data-phase", { phase: "structure" });
			},
			execute: async (scaffold) => {
				bpSetScaffold(bp, scaffold);
				ctx.emit("data-scaffold", scaffold);

				return {
					appName: scaffold.app_name,
					modules: scaffold.modules.map((m, i) => ({
						index: i,
						name: m.name,
						case_type: m.case_type,
						formCount: m.forms.length,
						forms: m.forms.map((f, j) => ({
							index: j,
							name: f.name,
							type: f.type,
						})),
					})),
				};
			},
		}),

		addModule: tool({
			description:
				"Set case list columns for a module. Call after generateScaffold. Provide the columns directly. Survey-only modules (no case_type) should pass null for both.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				case_list_columns: moduleContentSchema.shape.case_list_columns,
				case_detail_columns: moduleContentSchema.shape.case_detail_columns,
			}),
			onInputStart: () => {
				ctx.emit("data-phase", { phase: "modules" });
			},
			execute: async ({
				moduleIndex,
				case_list_columns,
				case_detail_columns,
			}) => {
				const mod = bp.modules[moduleIndex];
				if (!mod) return { error: `Module ${moduleIndex} not found` };

				if (!mod.case_type || !case_list_columns) {
					ctx.emit("data-module-done", {
						moduleIndex,
						caseListColumns: null,
					});
					return { moduleIndex, name: mod.name, columns: null };
				}

				bpUpdateModule(bp, moduleIndex, {
					case_list_columns,
					...(case_detail_columns && { case_detail_columns }),
				});

				ctx.emit("data-module-done", {
					moduleIndex,
					caseListColumns: case_list_columns,
				});

				return {
					moduleIndex,
					name: mod.name,
					case_list_columns,
					case_detail_columns: case_detail_columns ?? null,
				};
			},
		}),
	};

	// ── Shared tools (all modes) ─────────────────────────────────────
	// Conversation, batch add, read, mutation, and validation tools.

	const sharedTools = {
		askQuestions: {
			description:
				"Ask the user clarifying questions about their app requirements. Up to 5 questions per call — call as many times as needed. Most requests need several rounds. Don't rush to generate; an app built on assumptions is worse than one that took extra questions to get right.",
			inputSchema: askQuestionsSchema,
			// No execute → client-side tool, agent stops for user input
		},

		addQuestions: tool({
			description:
				"Add a batch of questions to an existing form. Appends to existing questions (does not replace). Groups added in one batch can be referenced as parentId in later batches.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				questions: z.array(addQuestionsQuestionSchema),
			}),
			execute: async ({ moduleIndex, formIndex, questions }) => {
				try {
					const blueprint = bp;
					const mod = blueprint.modules[moduleIndex];
					if (!mod) return { error: `Module ${moduleIndex} not found` };
					const form = mod.forms[formIndex];
					if (!form)
						return {
							error: `Form ${formIndex} not found in module ${moduleIndex}`,
						};

					// Process new questions: strip sentinels → apply case property defaults → assign UUID
					const processed = questions.map((q) => ({
						...applyDefaults(
							stripEmpty(q as unknown as FlatQuestion),
							blueprint.case_types,
							form.type,
							mod.case_type,
						),
						uuid: crypto.randomUUID(),
					}));

					// Merge with existing: flatten existing tree, append new, rebuild.
					// Existing questions carry their UUIDs through flattenToFlat's spread.
					const existingFlat = flattenToFlat(form.questions);
					const allFlat = [...existingFlat, ...processed];
					const newTree = buildQuestionTree(allFlat);

					bpReplaceForm(bp, moduleIndex, formIndex, {
						...form,
						questions: newTree,
					});
					ctx.emit("data-phase", { phase: "forms" });
					ctx.emit("data-form-updated", {
						moduleIndex,
						formIndex,
						form: { ...form, questions: newTree },
					});

					const totalCount = countQuestionsRecursive(newTree);
					const addedIds = processed.map((q) => q.id).join(", ");
					return `Successfully added ${questions.length} question${questions.length === 1 ? "" : "s"} to "${form.name}": ${addedIds}. Form now has ${totalCount} total question${totalCount === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		// ── Read ────────────────────────────────────────────────────────

		searchBlueprint: tool({
			description:
				"Search the blueprint for questions, forms, modules, or case properties matching a query.",
			inputSchema: z.object({
				query: z
					.string()
					.describe(
						"Search term: case property name, question id, label text, case type, XPath fragment, or module/form name",
					),
			}),
			execute: async ({ query }) => {
				const results = searchBlueprint(bp, query);
				return { query, results };
			},
		}),

		getModule: tool({
			description:
				"Get a module by index. Returns module metadata, case list columns, and a summary of its forms.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
			}),
			execute: async ({ moduleIndex }) => {
				const mod = bp.modules[moduleIndex];
				if (!mod) return { error: `Module ${moduleIndex} not found` };
				return {
					moduleIndex,
					name: mod.name,
					case_type: mod.case_type ?? null,
					case_list_columns: mod.case_list_columns ?? null,
					forms: mod.forms.map((f, i) => ({
						formIndex: i,
						name: f.name,
						type: f.type,
						questionCount: countQuestionsRecursive(f.questions),
					})),
				};
			},
		}),

		getForm: tool({
			description:
				"Get a form by module and form index. Returns the full form including all questions.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
			}),
			execute: async ({ moduleIndex, formIndex }) => {
				const form = bp.modules[moduleIndex]?.forms[formIndex];
				if (!form)
					return { error: `Form m${moduleIndex}-f${formIndex} not found` };
				return { moduleIndex, formIndex, form };
			},
		}),

		getQuestion: tool({
			description: "Get a single question by ID within a form.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				questionId: z.string().describe("Question id"),
			}),
			execute: async ({ moduleIndex, formIndex, questionId }) => {
				const questionPath = resolveQuestionId(
					bp,
					moduleIndex,
					formIndex,
					questionId,
				);
				if (!questionPath)
					return {
						error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
					};
				const form_ = bp.modules[moduleIndex]?.forms[formIndex];
				const question = form_
					? findByPath(form_.questions, questionPath)?.question
					: undefined;
				if (!question)
					return {
						error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
					};
				return {
					moduleIndex,
					formIndex,
					questionId,
					path: questionPath as string,
					question,
				};
			},
		}),

		// ── Question mutations ────────────────────────────────────────

		editQuestion: tool({
			description:
				"Update fields on an existing question. Only include fields you want to change. Use null to clear a field. Renaming the id automatically propagates XPath and column references — for case properties, propagates across all forms in the module.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				questionId: z.string().describe("Question id to update"),
				updates: editQuestionUpdatesSchema,
			}),
			execute: async ({ moduleIndex, formIndex, questionId, updates }) => {
				try {
					let currentPath = resolveQuestionId(
						bp,
						moduleIndex,
						formIndex,
						questionId,
					);
					if (!currentPath)
						return {
							error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
						};

					// Handle ID rename with automatic propagation
					const { id: newId, ...fieldUpdates } = updates;
					if (newId && newId !== questionId) {
						const editForm = bp.modules[moduleIndex]?.forms[formIndex];
						const question = editForm
							? findByPath(editForm.questions, currentPath)?.question
							: undefined;
						if (question?.case_property_on) {
							// Cross-form rename: all forms in module + columns + #case/ refs
							const mod = bp.modules[moduleIndex];
							if (mod?.case_type) {
								bpRenameCaseProperty(bp, mod.case_type, questionId, newId);
							}
						} else {
							// Single-form rename: XPath path refs within this form
							bpRenameQuestion(bp, moduleIndex, formIndex, currentPath, newId);
						}
						// Re-resolve path after rename
						const resolved = resolveQuestionId(
							bp,
							moduleIndex,
							formIndex,
							newId,
						);
						if (!resolved)
							return { error: `Question "${newId}" not found after rename` };
						currentPath = resolved;
					}

					// Apply remaining field updates
					if (Object.keys(fieldUpdates).length > 0) {
						bpUpdateQuestion(
							bp,
							moduleIndex,
							formIndex,
							currentPath,
							fieldUpdates,
						);
					}

					// Emit update for all affected forms
					if (newId && newId !== questionId) {
						ctx.emit("data-blueprint-updated", {
							blueprint: bp,
						});
					} else {
						const form = bp.modules[moduleIndex]?.forms[formIndex];
						if (form)
							ctx.emit("data-form-updated", { moduleIndex, formIndex, form });
					}
					const finalId = newId ?? questionId;
					const form = bp.modules[moduleIndex]?.forms[formIndex];
					const resolvedPath = resolveQuestionId(
						bp,
						moduleIndex,
						formIndex,
						finalId,
					);
					const updatedQ =
						form && resolvedPath
							? findByPath(form.questions, resolvedPath)?.question
							: undefined;
					const changedFields = Object.keys(updates).join(", ");
					const renameNote =
						newId && newId !== questionId
							? ` (renamed from "${questionId}")`
							: "";
					return `Successfully updated "${finalId}"${renameNote} in "${form?.name ?? `m${moduleIndex}-f${formIndex}`}". Changed: ${changedFields}.${updatedQ ? ` Current label: "${updatedQ.label}", type: ${updatedQ.type}.` : ""}`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		addQuestion: tool({
			description:
				"Add a new question to an existing form. Use beforeQuestionId or afterQuestionId to control position; omit both to append at end.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				question: addQuestionQuestionSchema,
				afterQuestionId: z
					.string()
					.optional()
					.describe("Insert after this question ID. Omit to append at end."),
				beforeQuestionId: z
					.string()
					.optional()
					.describe(
						"Insert before this question ID. Takes precedence over afterQuestionId.",
					),
				parentId: z
					.string()
					.optional()
					.describe("ID of a group/repeat to nest inside"),
			}),
			execute: async ({
				moduleIndex,
				formIndex,
				question,
				afterQuestionId,
				beforeQuestionId,
				parentId,
			}) => {
				try {
					const afterPath = afterQuestionId
						? resolveQuestionId(bp, moduleIndex, formIndex, afterQuestionId)
						: undefined;
					const beforePath = beforeQuestionId
						? resolveQuestionId(bp, moduleIndex, formIndex, beforeQuestionId)
						: undefined;
					const parentPath = parentId
						? resolveQuestionId(bp, moduleIndex, formIndex, parentId)
						: undefined;
					bpAddQuestion(bp, moduleIndex, formIndex, question as NewQuestion, {
						afterPath,
						beforePath,
						parentPath,
					});
					const form = bp.modules[moduleIndex]?.forms[formIndex];
					if (!form)
						return {
							error: `Form m${moduleIndex}-f${formIndex} not found after add`,
						};
					ctx.emit("data-form-updated", { moduleIndex, formIndex, form });
					const totalQ = countQuestionsRecursive(form.questions);
					const posDesc = beforeQuestionId
						? `before "${beforeQuestionId}"`
						: afterQuestionId
							? `after "${afterQuestionId}"`
							: "at end";
					const parentDesc = parentId ? ` inside group "${parentId}"` : "";
					return `Successfully added question "${question.id}" (${question.label}) to "${form.name}" ${posDesc}${parentDesc}. Form now has ${totalQ} question${totalQ === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		removeQuestion: tool({
			description: "Remove a question from a form.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				questionId: z.string().describe("Question id to remove"),
			}),
			execute: async ({ moduleIndex, formIndex, questionId }) => {
				try {
					const questionPath = resolveQuestionId(
						bp,
						moduleIndex,
						formIndex,
						questionId,
					);
					if (!questionPath)
						return {
							error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
						};
					const beforeCount = countQuestionsRecursive(
						bp.modules[moduleIndex]?.forms[formIndex]?.questions ?? [],
					);
					bpRemoveQuestion(bp, moduleIndex, formIndex, questionPath);
					const form = bp.modules[moduleIndex]?.forms[formIndex];
					if (!form)
						return {
							error: `Form m${moduleIndex}-f${formIndex} not found after remove`,
						};
					ctx.emit("data-form-updated", { moduleIndex, formIndex, form });
					const afterCount = countQuestionsRecursive(form.questions);
					return `Successfully removed question "${questionId}" from "${form.name}". Questions: ${beforeCount} → ${afterCount}.`;
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
					bpUpdateModule(bp, moduleIndex, {
						...(name !== undefined && { name }),
						...(case_list_columns !== undefined && { case_list_columns }),
						...(case_detail_columns !== undefined && { case_detail_columns }),
					});
					ctx.emit("data-blueprint-updated", {
						blueprint: bp,
					});
					const mod = bp.modules[moduleIndex];
					if (!mod)
						return { error: `Module ${moduleIndex} not found after update` };
					const changes: string[] = [];
					if (name !== undefined) changes.push(`name → "${mod.name}"`);
					if (case_list_columns !== undefined)
						changes.push(
							`case list columns (${mod.case_list_columns?.length ?? 0})`,
						);
					if (case_detail_columns !== undefined)
						changes.push(
							case_detail_columns === null
								? "case detail columns removed"
								: `case detail columns (${mod.case_detail_columns?.length ?? 0})`,
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
						question: z.string().describe("Question id to check"),
						answer: z.string().describe("Value that triggers closure"),
						operator: z
							.enum(["=", "selected"])
							.optional()
							.describe(
								'"=" for exact match (default). "selected" for multi-select questions.',
							),
					})
					.nullable()
					.optional()
					.describe(
						'Close forms only. Set conditional close. Use operator "selected" for multi-select questions. null to make unconditional (default). Omit to leave unchanged.',
					),
				post_submit: z
					.enum(["app_home", "module", "previous"])
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
					bpUpdateForm(bp, moduleIndex, formIndex, {
						...(name !== undefined && { name }),
						...(close_condition !== undefined && { close_condition }),
						...(post_submit !== undefined && { post_submit }),
						...(connect !== undefined && {
							connect: buildConnectConfig(
								connect,
								bp.modules[moduleIndex]?.forms[formIndex]?.connect,
							),
						}),
					});
					const form = bp.modules[moduleIndex]?.forms[formIndex];
					if (!form)
						return {
							error: `Form m${moduleIndex}-f${formIndex} not found after update`,
						};
					ctx.emit("data-form-updated", { moduleIndex, formIndex, form });
					const formChanges: string[] = [];
					if (name !== undefined) formChanges.push(`name → "${form.name}"`);
					if (close_condition !== undefined)
						formChanges.push(
							close_condition === null
								? "close_condition removed (unconditional close)"
								: "close_condition updated",
						);
					if (post_submit !== undefined)
						formChanges.push(
							`post_submit → "${form.post_submit ?? "form-type default"}"`,
						);
					if (connect !== undefined)
						formChanges.push(
							connect === null ? "connect removed" : "connect updated",
						);
					return `Successfully updated form "${form.name}" (${form.type}, m${moduleIndex}-f${formIndex}). Changed: ${formChanges.join(", ")}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		createForm: tool({
			description:
				"Add a new empty form to a module. Use addQuestions to populate it.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				name: z.string().describe("Form display name"),
				type: z
					.enum(FORM_TYPES)
					.describe(
						'"registration" creates a new case. "followup" updates an existing case. "close" loads and closes an existing case. "survey" is standalone.',
					),
				post_submit: z
					.enum(["app_home", "module", "previous"])
					.optional()
					.describe(
						'Where the user goes after submitting. Defaults to "previous" for followup/close, "app_home" for registration/survey. Only set to override.',
					),
			}),
			execute: async ({ moduleIndex, name, type, post_submit }) => {
				try {
					/* `bpAddForm` mints the uuid at the wire-format boundary
					 * (Phase 3 producer-side stamping). We pass the without-uuid
					 * literal here. */
					const form = {
						name,
						type,
						questions: [],
						...(post_submit && { post_submit }),
					};
					bpAddForm(bp, moduleIndex, form);
					ctx.emit("data-blueprint-updated", {
						blueprint: bp,
					});
					const mod = bp.modules[moduleIndex];
					if (!mod)
						return { error: `Module ${moduleIndex} not found after addForm` };
					const newFormIndex = mod.forms.length - 1;
					return `Successfully created form "${name}" (${type}) in module "${mod.name}" at index m${moduleIndex}-f${newFormIndex}. Module now has ${mod.forms.length} form${mod.forms.length === 1 ? "" : "s"}.`;
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
					const form = bp.modules[moduleIndex]?.forms[formIndex];
					const removedName = form?.name ?? `form ${formIndex}`;
					bpRemoveForm(bp, moduleIndex, formIndex);
					ctx.emit("data-blueprint-updated", {
						blueprint: bp,
					});
					const mod = bp.modules[moduleIndex];
					return `Successfully removed form "${removedName}" from module "${mod?.name ?? `module ${moduleIndex}`}". Module now has ${mod?.forms.length ?? 0} form${mod?.forms.length === 1 ? "" : "s"}.`;
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
					bpAddModule(bp, {
						name,
						...(case_type && { case_type }),
						...(case_list_only && { case_list_only }),
						forms: [],
						...(case_list_columns && { case_list_columns }),
					});
					ctx.emit("data-blueprint-updated", {
						blueprint: bp,
					});
					const newModIndex = bp.modules.length - 1;
					return `Successfully created module "${name}" at index ${newModIndex}${case_type ? ` (case type: ${case_type})` : ""}. App now has ${bp.modules.length} module${bp.modules.length === 1 ? "" : "s"}.`;
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
					const mod = bp.modules[moduleIndex];
					const name = mod?.name ?? null;
					bpRemoveModule(bp, moduleIndex);
					ctx.emit("data-blueprint-updated", {
						blueprint: bp,
					});
					return `Successfully removed module "${name ?? `module ${moduleIndex}`}". App now has ${bp.modules.length} module${bp.modules.length === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		// ── Validation ────────────────────────────────────────────────

		validateApp: tool({
			description:
				"Validate the app against CommCare platform rules and fix any issues. Call this when you are done building or editing. If validation fails with remaining errors, use your mutation tools (removeQuestion, editQuestion, etc.) to fix them, then call validateApp again.",
			inputSchema: z.object({}),
			onInputStart: () => {
				ctx.emit("data-phase", { phase: "validate" });
			},
			execute: async () => {
				const blueprint = bp;
				const result = await validateAndFix(ctx, blueprint);
				if (result.success) {
					ctx.emit("data-done", {
						blueprint: result.blueprint,
						hqJson: result.hqJson ?? {},
						success: true,
					});

					/* Update the app with the final validated blueprint (fire-and-forget).
					 * The app document was created at the start of the request by the route handler. */
					if (ctx.appId) {
						completeApp(ctx.appId, result.blueprint, ctx.logger.runId).catch(
							(err) => log.error("[validateApp] app update failed", err),
						);
					}

					return { success: true as const };
				}
				// Surface remaining errors as strings so the SA can read and fix them
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
		instructions: buildSolutionsArchitectPrompt(editing ? bp : undefined),
		stopWhen: isStepCount(80),
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
		onStepFinish: ({
			usage,
			text,
			reasoningText,
			toolCalls,
			toolResults,
			warnings,
		}) => {
			logWarnings("Solutions Architect", warnings);
			if (usage) {
				ctx.logger.logStep({
					text: text || undefined,
					reasoning: reasoningText || undefined,
					tool_calls: toolCalls?.map((tc) => ({
						name: tc.toolName,
						args: tc.input,
						toolCallId: tc.toolCallId,
					})),
					tool_results: (
						toolResults as Array<{ toolCallId: string; output: unknown }>
					)?.map((tr) => ({
						toolCallId: tr.toolCallId,
						output: tr.output,
					})),
					usage: {
						model: SA_MODEL,
						input_tokens: usage.inputTokens ?? 0,
						output_tokens: usage.outputTokens ?? 0,
						cache_read_tokens:
							usage.inputTokenDetails?.cacheReadTokens ?? undefined,
						cache_write_tokens:
							usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
					},
				});
			}
		},
		tools,
	});

	return agent;
}
