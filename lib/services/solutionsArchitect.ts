/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * The SA converses with users, incrementally generates apps through focused tool
 * calls, and edits them — all within one conversation context and prompt-caching window.
 */
import { type JSONValue, stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { log } from "@/lib/log";
import { completeApp } from "../db/apps";
import { SA_MODEL, SA_REASONING } from "../models";
import { buildSolutionsArchitectPrompt } from "../prompts/solutionsArchitectPrompt";
import {
	type BlueprintForm,
	type ConnectConfig,
	caseTypesOutputSchema,
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
import { errorToString } from "./commcare/validate/errors";
import { type GenerationContext, logWarnings } from "./generationContext";
import type { MutableBlueprint, NewQuestion } from "./mutableBlueprint";
import { ensureUuids } from "./questionPath";
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

function collectCaseProperties(questions: Question[]): string[] {
	const props: string[] = [];
	for (const q of questions) {
		if (q.case_property_on) props.push(`${q.id}→${q.case_property_on}`);
		if (q.children) props.push(...collectCaseProperties(q.children));
	}
	return props;
}

interface QuestionSummary {
	id: string;
	type: string;
	case_property_on?: string;
	children?: QuestionSummary[];
}

/** Compact question tree summary so the SA can see IDs, types, and nesting at a glance. */
function _summarizeQuestions(questions: Question[]): QuestionSummary[] {
	return questions.map((q) => {
		const entry: QuestionSummary = { id: q.id, type: q.type };
		if (q.case_property_on) entry.case_property_on = q.case_property_on;
		if (q.children?.length) entry.children = _summarizeQuestions(q.children);
		return entry;
	});
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

export function createSolutionsArchitect(
	ctx: GenerationContext,
	mutableBp: MutableBlueprint,
) {
	const agent = new ToolLoopAgent({
		model: ctx.model(SA_MODEL),
		instructions: buildSolutionsArchitectPrompt(),
		stopWhen: stepCountIs(80),
		prepareStep: ({ steps: _steps }) => {
			const anthropic: Record<string, JSONValue | undefined> = {
				cacheControl: { type: "ephemeral" },
			};

			anthropic.thinking = {
				type: "adaptive" as const,
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
		tools: {
			// ── Conversation ──────────────────────────────────────────────

			askQuestions: {
				description:
					"Ask the user clarifying questions about their app requirements. Up to 5 questions per call — call as many times as needed. Most requests need several rounds. Don't rush to generate; an app built on assumptions is worse than one that took extra questions to get right.",
				inputSchema: askQuestionsSchema,
				// No execute → client-side tool, agent stops for user input
			},

			// ── Generation ────────────────────────────────────────────────

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
				},
				execute: async ({ appName, caseTypes }) => {
					mutableBp.setCaseTypes(caseTypes);
					const bp = mutableBp.getBlueprint();
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
					mutableBp.setScaffold(scaffold);
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
					const mod = mutableBp.getModule(moduleIndex);
					if (!mod) return { error: `Module ${moduleIndex} not found` };

					if (!mod.case_type || !case_list_columns) {
						ctx.emit("data-module-done", {
							moduleIndex,
							caseListColumns: null,
						});
						return { moduleIndex, name: mod.name, columns: null };
					}

					mutableBp.updateModule(moduleIndex, {
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

			addQuestions: tool({
				description:
					"Add a batch of questions to an existing form. Appends to existing questions (does not replace). Groups added in one batch can be referenced as parentId in later batches.",
				inputSchema: z.object({
					moduleIndex: z.number().describe("0-based module index"),
					formIndex: z.number().describe("0-based form index"),
					questions: z.array(addQuestionsQuestionSchema),
				}),
				execute: async ({ moduleIndex, formIndex, questions }) => {
					const blueprint = mutableBp.getBlueprint();
					const mod = blueprint.modules[moduleIndex];
					if (!mod) return { error: `Module ${moduleIndex} not found` };
					const form = mod.forms[formIndex];
					if (!form)
						return {
							error: `Form ${formIndex} not found in module ${moduleIndex}`,
						};

					// Process new questions: strip sentinels → apply case property defaults
					const processed = questions.map((q) =>
						applyDefaults(
							stripEmpty(q as unknown as FlatQuestion),
							blueprint.case_types,
							form.type,
							mod.case_type,
						),
					);

					// Merge with existing: flatten existing tree, append new, rebuild
					const existingFlat = flattenToFlat(form.questions);
					const allFlat = [...existingFlat, ...processed];
					const newTree = buildQuestionTree(allFlat);

					/* Preserve existing UUIDs (carried through flattenToFlat's spread)
					 * and assign fresh UUIDs to newly added questions. */
					ensureUuids(newTree);

					mutableBp.replaceForm(moduleIndex, formIndex, {
						...form,
						questions: newTree,
					});
					ctx.emit("data-phase", { phase: "forms" });
					ctx.emit("data-form-updated", {
						moduleIndex,
						formIndex,
						form: { ...form, questions: newTree },
					});

					return {
						addedCount: questions.length,
						totalCount: countQuestionsRecursive(newTree),
						caseProperties: collectCaseProperties(newTree),
					};
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
					const results = mutableBp.search(query);
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
					const mod = mutableBp.getModule(moduleIndex);
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
							questionCount: f.questions?.length ?? 0,
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
					const form = mutableBp.getForm(moduleIndex, formIndex);
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
					const questionPath = mutableBp.resolveQuestionId(
						moduleIndex,
						formIndex,
						questionId,
					);
					if (!questionPath)
						return {
							error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
						};
					const question = mutableBp.getQuestion(
						moduleIndex,
						formIndex,
						questionPath,
					);
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
						let currentPath = mutableBp.resolveQuestionId(
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
							const question = mutableBp.getQuestion(
								moduleIndex,
								formIndex,
								currentPath,
							);
							if (question?.case_property_on) {
								// Cross-form rename: all forms in module + columns + #case/ refs
								const mod = mutableBp.getModule(moduleIndex);
								if (mod?.case_type) {
									mutableBp.renameCaseProperty(
										mod.case_type,
										questionId,
										newId,
									);
								}
							} else {
								// Single-form rename: XPath path refs within this form
								mutableBp.renameQuestion(
									moduleIndex,
									formIndex,
									currentPath,
									newId,
								);
							}
							// Re-resolve path after rename
							const resolved = mutableBp.resolveQuestionId(
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
							mutableBp.updateQuestion(
								moduleIndex,
								formIndex,
								currentPath,
								fieldUpdates,
							);
						}

						// Emit update for all affected forms
						if (newId && newId !== questionId) {
							ctx.emit("data-blueprint-updated", {
								blueprint: mutableBp.getBlueprint(),
							});
						} else {
							const form = mutableBp.getForm(moduleIndex, formIndex);
							if (form)
								ctx.emit("data-form-updated", { moduleIndex, formIndex, form });
						}
						return {
							moduleIndex,
							formIndex,
							questionId: newId ?? questionId,
							updatedFields: Object.keys(updates),
						};
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
							? mutableBp.resolveQuestionId(
									moduleIndex,
									formIndex,
									afterQuestionId,
								)
							: undefined;
						const beforePath = beforeQuestionId
							? mutableBp.resolveQuestionId(
									moduleIndex,
									formIndex,
									beforeQuestionId,
								)
							: undefined;
						const parentPath = parentId
							? mutableBp.resolveQuestionId(moduleIndex, formIndex, parentId)
							: undefined;
						mutableBp.addQuestion(
							moduleIndex,
							formIndex,
							question as NewQuestion,
							{ afterPath, beforePath, parentPath },
						);
						const form = mutableBp.getForm(moduleIndex, formIndex);
						if (!form)
							return {
								error: `Form m${moduleIndex}-f${formIndex} not found after add`,
							};
						ctx.emit("data-form-updated", { moduleIndex, formIndex, form });
						return {
							moduleIndex,
							formIndex,
							addedQuestionId: question.id,
							parentId: parentId ?? null,
							afterQuestionId: afterQuestionId ?? null,
							beforeQuestionId: beforeQuestionId ?? null,
						};
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
						const questionPath = mutableBp.resolveQuestionId(
							moduleIndex,
							formIndex,
							questionId,
						);
						if (!questionPath)
							return {
								error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
							};
						const beforeCount = countQuestionsRecursive(
							mutableBp.getForm(moduleIndex, formIndex)?.questions ?? [],
						);
						mutableBp.removeQuestion(moduleIndex, formIndex, questionPath);
						const form = mutableBp.getForm(moduleIndex, formIndex);
						if (!form)
							return {
								error: `Form m${moduleIndex}-f${formIndex} not found after remove`,
							};
						ctx.emit("data-form-updated", { moduleIndex, formIndex, form });
						const afterCount = countQuestionsRecursive(form.questions);
						return {
							moduleIndex,
							formIndex,
							removedQuestionId: questionId,
							questionCountBefore: beforeCount,
							questionCountAfter: afterCount,
						};
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
						mutableBp.updateModule(moduleIndex, {
							...(name !== undefined && { name }),
							...(case_list_columns !== undefined && { case_list_columns }),
							...(case_detail_columns !== undefined && { case_detail_columns }),
						});
						ctx.emit("data-blueprint-updated", {
							blueprint: mutableBp.getBlueprint(),
						});
						const mod = mutableBp.getModule(moduleIndex);
						if (!mod)
							return { error: `Module ${moduleIndex} not found after update` };
						return {
							moduleIndex,
							name: mod.name,
							case_list_columns: mod.case_list_columns ?? null,
							case_detail_columns: mod.case_detail_columns ?? null,
						};
					} catch (err) {
						return { error: err instanceof Error ? err.message : String(err) };
					}
				},
			}),

			updateForm: tool({
				description:
					"Update form metadata: name, close_case config, Connect integration, or post-submit navigation.",
				inputSchema: z.object({
					moduleIndex: z.number().describe("0-based module index"),
					formIndex: z.number().describe("0-based form index"),
					name: z.string().optional().describe("New form name"),
					close_case: z
						.object({
							question: z.string().optional(),
							answer: z.string().optional(),
						})
						.nullable()
						.optional()
						.describe(
							"Set close_case config. null to remove. {} for unconditional.",
						),
					post_submit: z
						.enum(["default", "module", "previous"])
						.nullable()
						.optional()
						.describe(
							"Where the user goes after submitting this form. " +
								'"default" = app home screen. ' +
								'"module" = back to this module\'s form list. ' +
								'"previous" = back to where the user was before this form (e.g. case list for followup forms). ' +
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
					close_case,
					post_submit,
					connect,
				}) => {
					try {
						mutableBp.updateForm(moduleIndex, formIndex, {
							...(name !== undefined && { name }),
							...(close_case !== undefined && { close_case }),
							...(post_submit !== undefined && { post_submit }),
							...(connect !== undefined && {
								connect: buildConnectConfig(
									connect,
									mutableBp.getForm(moduleIndex, formIndex)?.connect,
								),
							}),
						});
						const form = mutableBp.getForm(moduleIndex, formIndex);
						if (!form)
							return {
								error: `Form m${moduleIndex}-f${formIndex} not found after update`,
							};
						ctx.emit("data-form-updated", { moduleIndex, formIndex, form });
						return {
							moduleIndex,
							formIndex,
							name: form.name,
							type: form.type,
							post_submit: form.post_submit ?? "default",
							close_case: form.close_case ?? null,
							connect: form.connect ?? null,
						};
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
						.enum(["registration", "followup", "survey"])
						.describe("Form type"),
					post_submit: z
						.enum(["default", "module", "previous"])
						.optional()
						.describe(
							"Where the user goes after submitting this form. Omit for default (app home).",
						),
				}),
				execute: async ({ moduleIndex, name, type, post_submit }) => {
					try {
						const form: BlueprintForm = {
							name,
							type,
							questions: [],
							...(post_submit && post_submit !== "default" && { post_submit }),
						};
						mutableBp.addForm(moduleIndex, form);
						ctx.emit("data-blueprint-updated", {
							blueprint: mutableBp.getBlueprint(),
						});
						const mod = mutableBp.getModule(moduleIndex);
						if (!mod)
							return { error: `Module ${moduleIndex} not found after addForm` };
						return {
							moduleIndex,
							formIndex: mod.forms.length - 1,
							name,
							type,
							post_submit: post_submit ?? "default",
						};
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
						const form = mutableBp.getForm(moduleIndex, formIndex);
						const name = form?.name ?? null;
						mutableBp.removeForm(moduleIndex, formIndex);
						ctx.emit("data-blueprint-updated", {
							blueprint: mutableBp.getBlueprint(),
						});
						return {
							moduleIndex,
							removedFormIndex: formIndex,
							removedFormName: name,
						};
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
						mutableBp.addModule({
							name,
							...(case_type && { case_type }),
							...(case_list_only && { case_list_only }),
							forms: [],
							...(case_list_columns && { case_list_columns }),
						});
						ctx.emit("data-blueprint-updated", {
							blueprint: mutableBp.getBlueprint(),
						});
						const bp = mutableBp.getBlueprint();
						return {
							moduleIndex: bp.modules.length - 1,
							name,
							case_type: case_type ?? null,
						};
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
						const mod = mutableBp.getModule(moduleIndex);
						const name = mod?.name ?? null;
						mutableBp.removeModule(moduleIndex);
						ctx.emit("data-blueprint-updated", {
							blueprint: mutableBp.getBlueprint(),
						});
						return { removedModuleIndex: moduleIndex, removedModuleName: name };
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
					const blueprint = mutableBp.getBlueprint();
					const result = await validateAndFix(ctx, blueprint);
					if (result.success) {
						ctx.emit("data-done", {
							blueprint: result.blueprint,
							hqJson: result.hqJson ?? {},
							success: true,
						});

						/* Update the app with the final validated blueprint (fire-and-forget).
						 * The app document was created at the start of the request by the route handler. */
						if (ctx.session && ctx.appId) {
							completeApp(
								ctx.session.user.email,
								ctx.appId,
								result.blueprint,
								ctx.logger.runId,
							).catch((err) =>
								log.error("[validateApp] app update failed", err),
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
		},
	});

	return agent;
}
