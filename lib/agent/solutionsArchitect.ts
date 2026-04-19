/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * Tools are split into two groups: **generation** (schema, scaffold, columns) and
 * **shared** (conversation, read, mutation, validation). In edit mode (existing app),
 * generation tools are excluded — the SA only gets shared tools and an editing prompt
 * with a blueprint summary. In build mode (new app), all tools are available.
 *
 * ## Internal shape
 *
 * The SA works on `BlueprintDoc` end to end — the same normalized shape
 * the client store and Firestore both persist. Wire-format `AppBlueprint`
 * appears only at true external boundaries:
 *
 *   - **LLM prompt** — `buildSolutionsArchitectPrompt` renders the SA's
 *     editing preamble from a `toBlueprint(doc)` snapshot (the prompt is
 *     itself an external surface: it ships to Anthropic).
 *   - **LLM tool returns** — `getForm` / `getQuestion` hand back
 *     wire-format `BlueprintForm` / `Question` objects because the SA's
 *     tool surface uses CommCare vocabulary. Those are LLM-facing.
 *   - **CommCare validator/expander** — `validateAndFix` internally
 *     translates to `AppBlueprint`, runs the XForm compiler, and
 *     translates any fix-registry mutations back into a doc. Callers
 *     stay on the domain side.
 *
 * Stream-event payloads carry fine-grained `data-mutations` events emitted
 * via `ctx.emitMutations` for every tool-level change; the final
 * `data-done` from `validateApp` carries a normalized doc snapshot as the
 * one remaining full-doc emission. No wire-format blueprint crosses the
 * agent → client boundary any more.
 *
 * The SA's tool-argument "question" nomenclature is deliberately NOT
 * renamed to "field"; that's the SA's wire format to the LLM and shared
 * with the prompt. Internally everything is a `Field`.
 */
import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { stepCountIs, ToolLoopAgent, tool } from "ai";
import { produce } from "immer";
import { z } from "zod";
import { completeApp } from "@/lib/db/apps";
import { toBlueprint } from "@/lib/doc/legacyBridge";
import { applyMutations } from "@/lib/doc/mutations";
import { searchBlueprint } from "@/lib/doc/searchBlueprint";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	Field,
	FormType,
	PostSubmitDestination,
	Uuid,
} from "@/lib/domain";
import { asUuid, isContainer } from "@/lib/domain";
import { log } from "@/lib/logger";
import { SA_MODEL, SA_REASONING } from "@/lib/models";
import {
	type BlueprintForm,
	type ConnectConfig,
	caseTypesOutputSchema,
	FORM_TYPES,
	moduleContentSchema,
	type Question,
	scaffoldModulesSchema,
} from "@/lib/schemas/blueprint";
import { errorToString } from "@/lib/services/commcare/validate/errors";
import {
	addFieldMutations,
	addFormMutations,
	addModuleMutations,
	findFieldByBareId,
	removeFieldMutations,
	removeFormMutations,
	removeModuleMutations,
	renameFieldMutations,
	resolveFieldByIndex,
	setCaseTypesMutations,
	setScaffoldMutations,
	updateFieldMutations,
	updateFormMutations,
	updateModuleMutations,
} from "./blueprintHelpers";
import {
	applyDefaults,
	type FlatQuestion,
	stripEmpty,
} from "./contentProcessing";
import type { GenerationContext } from "./generationContext";
import { buildSolutionsArchitectPrompt } from "./prompts";
import {
	addQuestionQuestionSchema,
	addQuestionsQuestionSchema,
	editQuestionUpdatesSchema,
} from "./toolSchemas";
import { validateAndFix } from "./validationLoop";

export { validateAndFix } from "./validationLoop";

// ── Doc helpers ───────────────────────────────────────────────────────

/**
 * Apply a mutation batch to a `BlueprintDoc` via Immer `produce`.
 * Mutations run on an Immer draft so the reducer's mutable-style
 * updates are structurally shared; no Zustand store is involved on the
 * SA side.
 */
function applyToDoc(doc: BlueprintDoc, muts: Mutation[]): BlueprintDoc {
	if (muts.length === 0) return doc;
	return produce(doc, (draft) => {
		applyMutations(draft as unknown as BlueprintDoc, muts);
	});
}

/**
 * Map a (moduleIndex, formIndex) pair to the doc's form uuid. Returns
 * `undefined` when either index is out of range — callers surface this
 * as an error message to the SA.
 */
function resolveFormUuid(
	doc: BlueprintDoc,
	moduleIndex: number,
	formIndex: number,
): Uuid | undefined {
	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return undefined;
	const formUuids = doc.formOrder[moduleUuid] ?? [];
	return formUuids[formIndex];
}

// ── Helpers for wire-format field translation ─────────────────────────

/**
 * SA wire-format "question" as emitted by addQuestion / addQuestions.
 * This is the LLM-facing shape — we deliberately keep the CommCare
 * vocabulary (`type`, `case_property_on`) so the SA's tool schemas and
 * prompt stay stable. The helper below translates to the internal
 * `Field` shape at the boundary.
 */
interface SaQuestion {
	id: string;
	type: string;
	label?: string;
	hint?: string;
	required?: string;
	validation?: string;
	validation_msg?: string;
	relevant?: string;
	calculate?: string;
	default_value?: string;
	options?: Array<{ value: string; label: string }>;
	case_property_on?: string;
	children?: SaQuestion[];
}

/**
 * Translate a single SA wire-format question (without children) into a
 * domain `Field` with a freshly minted uuid. Wire-format field names
 * map onto the domain dialect here:
 *
 *   - `case_property_on` → `case_property`
 *   - `validation` / `validation_msg` → `validate` / `validate_msg`
 */
function saQuestionToField(q: SaQuestion, uuid: Uuid): Field {
	const base: Record<string, unknown> = {
		kind: q.type,
		uuid,
		id: q.id,
		label: q.label ?? "",
		...(q.hint != null && { hint: q.hint }),
		...(q.required != null && { required: q.required }),
		...(q.relevant != null && { relevant: q.relevant }),
		...(q.validation != null && { validate: q.validation }),
		...(q.validation_msg != null && { validate_msg: q.validation_msg }),
		...(q.calculate != null && { calculate: q.calculate }),
		...(q.default_value != null && { default_value: q.default_value }),
		...(q.options != null && { options: q.options }),
		...(q.case_property_on != null && { case_property: q.case_property_on }),
	};
	return base as Field;
}

// ── Partial patch for editQuestion ─────────────────────────────────────

/**
 * Translate a wire-format SA editQuestion patch to a domain `Field`
 * patch. Nullable fields on the SA side clear the value (we map `null`
 * → `undefined` so Immer's `Object.assign` in the reducer drops the
 * key). Unspecified keys leave the current value alone.
 */
function saEditPatchToFieldPatch(
	updates: z.infer<typeof editQuestionUpdatesSchema>,
): Partial<Omit<Field, "uuid">> {
	const patch: Record<string, unknown> = {};
	if (updates.type !== undefined) patch.kind = updates.type;
	if (updates.label !== undefined) patch.label = updates.label;
	if (updates.hint !== undefined) patch.hint = updates.hint;
	if (updates.required !== undefined) patch.required = updates.required;
	// Wire `validation` / `validation_msg` map to domain `validate` /
	// `validate_msg`. The reducer accepts `undefined` as "clear" via
	// Object.assign semantics.
	if (updates.validation !== undefined) patch.validate = updates.validation;
	if (updates.validation_msg !== undefined)
		patch.validate_msg = updates.validation_msg;
	if (updates.relevant !== undefined)
		patch.relevant = updates.relevant ?? undefined;
	if (updates.calculate !== undefined)
		patch.calculate = updates.calculate ?? undefined;
	if (updates.default_value !== undefined)
		patch.default_value = updates.default_value ?? undefined;
	if (updates.options !== undefined)
		patch.options = updates.options ?? undefined;
	if (updates.case_property_on !== undefined)
		patch.case_property = updates.case_property_on ?? undefined;
	return patch as Partial<Omit<Field, "uuid">>;
}

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

/** Count fields recursively under a form in the doc — used for the SA's
 *  human-readable "Form now has N fields" success messages. */
function countFieldsInForm(doc: BlueprintDoc, formUuid: Uuid): number {
	let total = 0;
	const stack: Uuid[] = [...(doc.fieldOrder[formUuid] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop() as Uuid;
		const field = doc.fields[uuid];
		if (!field) continue;
		total++;
		if (isContainer(field)) {
			const children = doc.fieldOrder[uuid] ?? [];
			for (const c of children) stack.push(c);
		}
	}
	return total;
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

	// Register with the context so intermediate `updated_at` saves pull the
	// latest snapshot. The context captures a getter so every `emit` call
	// reads through to the most recent `doc` reassignment.
	ctx.registerDocProvider(() => doc);

	/**
	 * Apply a mutation batch to the SA's doc. Every tool handler that
	 * mutates state routes through this so the timing of doc
	 * reassignment stays in one place.
	 */
	const dispatch = (muts: Mutation[]): void => {
		if (muts.length === 0) return;
		doc = applyToDoc(doc, muts);
	};

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
			execute: async ({ appName, caseTypes }) => {
				// Emit before dispatch so the client applies mutations in the same
				// order the SA's internal doc advances. `dispatch` still runs
				// because later tool calls in the same turn (scaffold, addModule)
				// read `doc` for index → uuid resolution.
				const muts: Mutation[] = [
					{ kind: "setAppName", name: appName },
					...setCaseTypesMutations(doc, caseTypes),
				];
				ctx.emitMutations(muts, "schema");
				dispatch(muts);

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
				"Set the module and form structure for the app. Call after generateScaffold. Provide the complete scaffold directly.",
			inputSchema: scaffoldModulesSchema,
			strict: true,
			execute: async (scaffold) => {
				const muts = setScaffoldMutations(doc, scaffold);
				ctx.emitMutations(muts, "scaffold");
				dispatch(muts);

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
			execute: async ({
				moduleIndex,
				case_list_columns,
				case_detail_columns,
			}) => {
				const moduleUuid = doc.moduleOrder[moduleIndex];
				if (!moduleUuid) return { error: `Module ${moduleIndex} not found` };
				const mod = doc.modules[moduleUuid];
				if (!mod) return { error: `Module ${moduleIndex} not found` };

				// Survey-only branch: the module already exists from scaffold
				// and has no case type, so there are no column mutations to
				// apply. The legacy `data-module-done` emission with null
				// columns was a phase marker the client never consumed (it
				// reads the module entity directly); dropping it removes
				// dead wire traffic.
				if (!mod.caseType || !case_list_columns) {
					return { moduleIndex, name: mod.name, columns: null };
				}

				const muts = updateModuleMutations(doc, moduleUuid, {
					caseListColumns: case_list_columns,
					...(case_detail_columns && {
						caseDetailColumns: case_detail_columns,
					}),
				});
				// Stage tag encodes which module these mutations belong to —
				// useful for replay attribution and server-side telemetry.
				ctx.emitMutations(muts, `module:${moduleIndex}`);
				dispatch(muts);

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
				"Add a batch of fields to an existing form. Appends to existing fields (does not replace). Groups added in one batch can be referenced as parentId in later batches.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				questions: z.array(addQuestionsQuestionSchema),
			}),
			execute: async ({ moduleIndex, formIndex, questions }) => {
				try {
					const moduleUuid = doc.moduleOrder[moduleIndex];
					if (!moduleUuid) return { error: `Module ${moduleIndex} not found` };
					const mod = doc.modules[moduleUuid];
					if (!mod) return { error: `Module ${moduleIndex} not found` };
					const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
					if (!formUuid)
						return {
							error: `Form ${formIndex} not found in module ${moduleIndex}`,
						};
					const form = doc.forms[formUuid];
					if (!form)
						return {
							error: `Form ${formIndex} not found in module ${moduleIndex}`,
						};

					// Process incoming flat SA-format questions: strip sentinels,
					// apply case-property defaults from the data model, then build
					// a bare-level SaQuestion shape. The SA emits flat questions
					// with parentId — we resolve each parentId to a uuid by id
					// lookup within the form's existing + newly-added fields.
					const mintedByBareId = new Map<string, Uuid>();
					const muts: Mutation[] = [];

					for (const raw of questions) {
						const processed = applyDefaults(
							stripEmpty(raw as unknown as FlatQuestion),
							doc.caseTypes,
							form.type,
							mod.caseType,
						) as FlatQuestion & { parentId?: string | null };

						// Resolve parentUuid: empty/undefined → form; otherwise find
						// the uuid of the newly-added parent or an existing field.
						let parentUuid: Uuid = formUuid;
						const parentId = processed.parentId;
						if (parentId && typeof parentId === "string") {
							const minted = mintedByBareId.get(parentId);
							if (minted) {
								parentUuid = minted;
							} else {
								const existing = findFieldByBareId(doc, formUuid, parentId);
								if (existing) parentUuid = existing.field.uuid;
								// If we can't resolve, fall through to form-level
								// insert — better to land somewhere than to fail.
							}
						}

						const fieldUuid = asUuid(crypto.randomUUID());
						const field = saQuestionToField(processed as SaQuestion, fieldUuid);
						mintedByBareId.set(field.id, fieldUuid);
						muts.push({ kind: "addField", parentUuid, field });
					}

					// Emit the mutation batch before dispatch so client application
					// order matches the SA's internal doc advancement. The client
					// applies the mutations via `applyMany` — no wire-form snapshot
					// needed; the mutations ARE the update. The `form:M-F` stage
					// tag on the envelopes drives lifecycle derivation (forms phase).
					ctx.emitMutations(muts, `form:${moduleIndex}-${formIndex}`);
					dispatch(muts);

					const totalCount = countFieldsInForm(doc, formUuid);
					const addedIds = questions.map((q) => q.id).join(", ");
					return `Successfully added ${questions.length} field${questions.length === 1 ? "" : "s"} to "${form.name}": ${addedIds}. Form now has ${totalCount} total field${totalCount === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		// ── Read ────────────────────────────────────────────────────────

		searchBlueprint: tool({
			description:
				"Search the blueprint for fields, forms, modules, or case properties matching a query.",
			inputSchema: z.object({
				query: z
					.string()
					.describe(
						"Search term: case property name, field id, label text, case type, XPath fragment, or module/form name",
					),
			}),
			execute: async ({ query }) => {
				const results = searchBlueprint(doc, query);
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
				const moduleUuid = doc.moduleOrder[moduleIndex];
				if (!moduleUuid) return { error: `Module ${moduleIndex} not found` };
				const mod = doc.modules[moduleUuid];
				if (!mod) return { error: `Module ${moduleIndex} not found` };
				const formUuids = doc.formOrder[moduleUuid] ?? [];
				return {
					moduleIndex,
					name: mod.name,
					case_type: mod.caseType ?? null,
					case_list_columns: mod.caseListColumns ?? null,
					forms: formUuids.map((fUuid, i) => {
						const f = doc.forms[fUuid];
						return {
							formIndex: i,
							name: f?.name ?? "",
							type: f?.type ?? "survey",
							questionCount: countFieldsInForm(doc, fUuid),
						};
					}),
				};
			},
		}),

		getForm: tool({
			description:
				"Get a form by module and form index. Returns the full form including all fields.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
			}),
			execute: async ({ moduleIndex, formIndex }) => {
				const moduleUuid = doc.moduleOrder[moduleIndex];
				if (!moduleUuid)
					return { error: `Form m${moduleIndex}-f${formIndex} not found` };
				const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
				if (!formUuid)
					return { error: `Form m${moduleIndex}-f${formIndex} not found` };
				const wireForm = wireFormSnapshot(doc, moduleUuid, formUuid);
				if (!wireForm)
					return { error: `Form m${moduleIndex}-f${formIndex} not found` };
				return { moduleIndex, formIndex, form: wireForm };
			},
		}),

		getQuestion: tool({
			description: "Get a single field by ID within a form.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				questionId: z.string().describe("Field id"),
			}),
			execute: async ({ moduleIndex, formIndex, questionId }) => {
				const resolved = resolveFieldByIndex(
					doc,
					moduleIndex,
					formIndex,
					questionId,
				);
				if (!resolved)
					return {
						error: `Field "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
					};
				return {
					moduleIndex,
					formIndex,
					questionId,
					path: resolved.path,
					question: fieldToWireQuestion(doc, resolved.field.uuid),
				};
			},
		}),

		// ── Field mutations ────────────────────────────────────────

		editQuestion: tool({
			description:
				"Update properties on an existing field. Only include properties you want to change. Use null to clear a property. Renaming the id automatically propagates XPath and column references — for case properties, propagates across all forms in the module.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				questionId: z.string().describe("Field id to update"),
				updates: editQuestionUpdatesSchema,
			}),
			execute: async ({ moduleIndex, formIndex, questionId, updates }) => {
				try {
					const resolved = resolveFieldByIndex(
						doc,
						moduleIndex,
						formIndex,
						questionId,
					);
					if (!resolved)
						return {
							error: `Field "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
						};

					const { id: newId, ...fieldUpdates } = updates;

					// Handle id rename first as its own emitted batch. The
					// `renameField` reducer handles the full cascade on its own —
					// form-local path / hashtag rewrites, cross-form `#case/`
					// hashtag rewrites scoped to modules with matching caseType,
					// peer-field renames, and case list / detail column renames.
					// The client runs the SAME reducer against `applyMany`, so the
					// cascade reproduces on the client without needing a full
					// blueprint snapshot. Emit THEN dispatch so client order
					// matches server order.
					if (newId && newId !== questionId) {
						const renameMuts = renameFieldMutations(
							doc,
							resolved.field.uuid,
							newId,
						);
						ctx.emitMutations(renameMuts, `rename:${moduleIndex}-${formIndex}`);
						dispatch(renameMuts);
					}

					// Re-resolve the field uuid after rename (the uuid is stable,
					// but we want the most recent `field` snapshot for egress).
					const finalId = newId ?? questionId;
					const afterRename = resolveFieldByIndex(
						doc,
						moduleIndex,
						formIndex,
						finalId,
					);
					if (!afterRename)
						return { error: `Field "${finalId}" not found after rename` };

					// Apply remaining property updates as a SECOND emitted batch.
					// Two emissions (rename + edit) instead of one wire-form/
					// blueprint snapshot — client applies each via `applyMany`,
					// so the visible effect is identical.
					if (Object.keys(fieldUpdates).length > 0) {
						const patch = saEditPatchToFieldPatch(
							fieldUpdates as z.infer<typeof editQuestionUpdatesSchema>,
						);
						if (Object.keys(patch).length > 0) {
							const updateMuts = updateFieldMutations(
								doc,
								afterRename.field.uuid,
								patch,
							);
							ctx.emitMutations(updateMuts, `edit:${moduleIndex}-${formIndex}`);
							dispatch(updateMuts);
						}
					}

					const postField = doc.fields[afterRename.field.uuid];
					const changedFields = Object.keys(updates).join(", ");
					const renameNote =
						newId && newId !== questionId
							? ` (renamed from "${questionId}")`
							: "";
					const formName =
						(() => {
							const moduleUuid = doc.moduleOrder[moduleIndex];
							const formUuid = moduleUuid
								? doc.formOrder[moduleUuid]?.[formIndex]
								: undefined;
							return formUuid ? doc.forms[formUuid]?.name : undefined;
						})() ?? `m${moduleIndex}-f${formIndex}`;
					const label =
						postField && "label" in postField
							? (postField as { label: string }).label
							: "";
					const kind = postField?.kind ?? "unknown";
					return `Successfully updated "${finalId}"${renameNote} in "${formName}". Changed: ${changedFields}. Current label: "${label}", type: ${kind}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		addQuestion: tool({
			description:
				"Add a new field to an existing form. Use beforeQuestionId or afterQuestionId to control position; omit both to append at end.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				question: addQuestionQuestionSchema,
				afterQuestionId: z
					.string()
					.optional()
					.describe("Insert after this field ID. Omit to append at end."),
				beforeQuestionId: z
					.string()
					.optional()
					.describe(
						"Insert before this field ID. Takes precedence over afterQuestionId.",
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
					const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
					if (!formUuid)
						return { error: `Form m${moduleIndex}-f${formIndex} not found` };

					// Resolve parent uuid (form or an existing container field).
					let parentUuid: Uuid = formUuid;
					if (parentId) {
						const resolvedParent = findFieldByBareId(doc, formUuid, parentId);
						if (resolvedParent?.field && isContainer(resolvedParent.field)) {
							parentUuid = resolvedParent.field.uuid;
						}
					}

					// Resolve sibling anchors for ordered insert. Helpers insert
					// at a numeric index — compute it from the sibling's current
					// position in the parent's order array.
					const order = doc.fieldOrder[parentUuid] ?? [];
					let insertIndex = order.length; // default: append
					if (beforeQuestionId) {
						const target = order.findIndex(
							(u) => doc.fields[u]?.id === beforeQuestionId,
						);
						if (target !== -1) insertIndex = target;
					} else if (afterQuestionId) {
						const target = order.findIndex(
							(u) => doc.fields[u]?.id === afterQuestionId,
						);
						if (target !== -1) insertIndex = target + 1;
					}

					const uuid = asUuid(crypto.randomUUID());
					const field = saQuestionToField(question as SaQuestion, uuid);
					const muts = addFieldMutations(doc, {
						parentUuid,
						field,
						index: insertIndex,
					});
					ctx.emitMutations(muts, `form:${moduleIndex}-${formIndex}`);
					dispatch(muts);

					const formName = doc.forms[formUuid]?.name ?? "";
					const totalCount = countFieldsInForm(doc, formUuid);
					const posDesc = beforeQuestionId
						? `before "${beforeQuestionId}"`
						: afterQuestionId
							? `after "${afterQuestionId}"`
							: "at end";
					const parentDesc = parentId ? ` inside group "${parentId}"` : "";
					return `Successfully added field "${question.id}" (${question.label ?? ""}) to "${formName}" ${posDesc}${parentDesc}. Form now has ${totalCount} field${totalCount === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		removeQuestion: tool({
			description: "Remove a field from a form.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				questionId: z.string().describe("Field id to remove"),
			}),
			execute: async ({ moduleIndex, formIndex, questionId }) => {
				try {
					const resolved = resolveFieldByIndex(
						doc,
						moduleIndex,
						formIndex,
						questionId,
					);
					if (!resolved)
						return {
							error: `Field "${questionId}" not found in m${moduleIndex}-f${formIndex}`,
						};
					const formUuid = resolved.formUuid;
					const beforeCount = countFieldsInForm(doc, formUuid);
					const muts = removeFieldMutations(doc, resolved.field.uuid);
					ctx.emitMutations(muts, `form:${moduleIndex}-${formIndex}`);
					dispatch(muts);
					const formName = doc.forms[formUuid]?.name ?? "";
					const afterCount = countFieldsInForm(doc, formUuid);
					return `Successfully removed field "${questionId}" from "${formName}". Fields: ${beforeCount} → ${afterCount}.`;
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
					// Compute the helper mutations once so we can both stream them
					// over the wire and advance the SA's internal doc in lockstep.
					// Emit before dispatch so the client's applied order matches
					// the SA's — dispatch() is what the next tool call reads from.
					const muts = updateModuleMutations(doc, moduleUuid, patch);
					ctx.emitMutations(muts, `module:${moduleIndex}`);
					dispatch(muts);
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
						question: z.string().describe("Field id to check"),
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
					const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
					if (!formUuid)
						return { error: `Form m${moduleIndex}-f${formIndex} not found` };
					const existing = doc.forms[formUuid];
					if (!existing)
						return { error: `Form m${moduleIndex}-f${formIndex} not found` };

					// Build the helper's patch shape. close_condition on the wire
					// uses `question`; domain uses `field`. null clears.
					const patch: Parameters<typeof updateFormMutations>[2] = {};
					if (name !== undefined) patch.name = name;
					if (close_condition !== undefined) {
						patch.closeCondition =
							close_condition === null
								? null
								: {
										field: close_condition.question,
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
					// Stream the form-metadata mutations the helper produced, then
					// advance the SA's doc. Replaces the prior `data-form-updated`
					// wire-snapshot emission — clients now apply the same granular
					// mutations the SA applies internally.
					const muts = updateFormMutations(doc, formUuid, patch);
					ctx.emitMutations(muts, `form:${moduleIndex}-${formIndex}`);
					dispatch(muts);

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
					ctx.emitMutations(muts, `module:${moduleIndex}`);
					dispatch(muts);
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
						ctx.emitMutations(muts, `form:${moduleIndex}-${formIndex}`);
						dispatch(muts);
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
					ctx.emitMutations(muts, "module:create");
					dispatch(muts);
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
						ctx.emitMutations(muts, `module:remove:${moduleIndex}`);
						dispatch(muts);
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
				"Validate the app against CommCare platform rules and fix any issues. Call this when you are done building or editing. If validation fails with remaining errors, use your mutation tools (removeQuestion, editQuestion, etc.) to fix them, then call validateApp again.",
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

					/* Strip the derived `fieldParent` reverse-index before emitting
					 * or persisting — it's rebuilt on the client from `fieldOrder`
					 * in `docStore.load()`, so sending it over SSE wastes bandwidth
					 * and duplicates data that the store regenerates anyway. */
					const { fieldParent: _fp, ...persistable } = doc;

					ctx.emit("data-done", {
						doc: persistable,
						hqJson: result.hqJson ?? {},
						success: true,
					});

					/* Update the app with the final validated doc (fire-and-forget).
					 * The app document was created at the start of the request by
					 * the route handler. We persist the normalized doc shape
					 * directly — `completeApp` accepts `PersistableDoc`. The runId
					 * is the same value the event log uses; `UsageAccumulator`
					 * is the single source of truth. */
					if (ctx.appId) {
						completeApp(ctx.appId, persistable, ctx.usage.runId).catch((err) =>
							log.error("[validateApp] app update failed", err),
						);
					}

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
		// The prompt summary is itself an external (LLM-facing) artifact —
		// the SA speaks CommCare vocabulary with the model. Render from a
		// fresh wire snapshot so the preamble reflects the doc we were just
		// handed.
		instructions: buildSolutionsArchitectPrompt(
			editing ? toBlueprint(doc) : undefined,
		),
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

// ── Small helpers for emitting wire-format slices ─────────────────────

/**
 * Extract a single form from the doc as a wire-format `BlueprintForm`.
 * Used by tool handlers emitting `data-form-updated` events.
 */
function wireFormSnapshot(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
): BlueprintForm | undefined {
	const bpSnapshot = toBlueprint(doc);
	const mIdx = doc.moduleOrder.indexOf(moduleUuid);
	if (mIdx === -1) return undefined;
	const fIdx = (doc.formOrder[moduleUuid] ?? []).indexOf(formUuid);
	if (fIdx === -1) return undefined;
	return bpSnapshot.modules[mIdx]?.forms[fIdx];
}

/**
 * Extract a single field from the doc as a wire-format `Question`.
 * Only used by the `getQuestion` SA read tool, which returns one field
 * to the LLM.
 */
function fieldToWireQuestion(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): Question | undefined {
	const bpSnapshot = toBlueprint(doc);
	for (const mod of bpSnapshot.modules) {
		for (const f of mod.forms) {
			const found = findQuestionByUuid(f.questions, fieldUuid);
			if (found) return found;
		}
	}
	return undefined;
}

function findQuestionByUuid(
	questions: Question[] | undefined,
	uuid: string,
): Question | undefined {
	if (!questions) return undefined;
	for (const q of questions) {
		if (q.uuid === uuid) return q;
		if (q.children) {
			const found = findQuestionByUuid(q.children, uuid);
			if (found) return found;
		}
	}
	return undefined;
}
