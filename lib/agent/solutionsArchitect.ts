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
import { produce } from "immer";
import { z } from "zod";
import { errorToString } from "@/lib/commcare/validator/errors";
import { completeApp } from "@/lib/db/apps";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	buildFieldTree,
	countFieldsUnder,
	type FieldWithChildren,
} from "@/lib/doc/fieldWalk";
import { applyMutations } from "@/lib/doc/mutations";
import { searchBlueprint } from "@/lib/doc/searchBlueprint";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	ConnectConfig,
	Field,
	Form,
	FormType,
	PostSubmitDestination,
	Uuid,
} from "@/lib/domain";
import {
	asUuid,
	FORM_TYPES,
	fieldRegistry,
	fieldSchema,
	isContainer,
	USER_FACING_DESTINATIONS,
} from "@/lib/domain";
import { log } from "@/lib/logger";
import { SA_MODEL, SA_REASONING } from "@/lib/models";
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
import { applyDefaults, type FlatField, stripEmpty } from "./contentProcessing";
import type { GenerationContext } from "./generationContext";
import { buildSolutionsArchitectPrompt } from "./prompts";
import {
	caseTypesOutputSchema,
	moduleContentSchema,
	scaffoldModulesSchema,
} from "./scaffoldSchemas";
import {
	addFieldSchema,
	addFieldsItemSchema,
	editFieldUpdatesSchema,
} from "./toolSchemas";
import { validateAndFix } from "./validationLoop";

export { validateAndFix } from "./validationLoop";

/**
 * Names of SA tools exposed only in build mode. Kept here next to the
 * `generationTools` definition so the two don't drift. The chat route
 * uses this list to strip build-only tool-use parts from message history
 * on edit-mode requests — Anthropic rejects any tool reference whose
 * name isn't in the current tools array, and a mid-session edit right
 * after a build would otherwise carry these references in its history.
 */
export const BUILD_ONLY_TOOL_NAMES = [
	"generateSchema",
	"generateScaffold",
	"addModule",
] as const;

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

// ── Flat → Field translation ─────────────────────────────────────────

/**
 * Build a validated domain `Field` from the SA's flat batch-item payload.
 *
 * The SA can in principle emit any combination of optional keys for any
 * `kind` — there's no per-kind Zod validation on the tool input because
 * the flat schema is a union across all kinds. Per-kind validity is
 * enforced HERE: the assembled candidate is run through `fieldSchema`
 * (the discriminated union) so Zod strips keys the target kind doesn't
 * declare (e.g. `label` on `hidden`, `case_property` on media kinds)
 * and rejects invalid values. Returns `undefined` when the shape can't
 * be salvaged into a valid `Field`; callers skip and log.
 *
 * `label`, `hint`, etc. are included only when they carry a non-empty
 * value. The batch schema's sentinel-required `label`/`required` fields
 * are already stripped to absent by `stripEmpty` before this runs, but
 * the extra guard here is cheap and keeps the helper standalone.
 */
function flatFieldToField(
	q: Partial<FlatField>,
	uuid: Uuid,
): Field | undefined {
	const candidate: Record<string, unknown> = {
		kind: q.kind,
		uuid,
		id: q.id,
		...(typeof q.label === "string" &&
			q.label.length > 0 && {
				label: q.label,
			}),
		...(typeof q.hint === "string" && q.hint.length > 0 && { hint: q.hint }),
		...(typeof q.required === "string" &&
			q.required.length > 0 && {
				required: q.required,
			}),
		...(typeof q.relevant === "string" &&
			q.relevant.length > 0 && {
				relevant: q.relevant,
			}),
		...(typeof q.validate === "string" &&
			q.validate.length > 0 && {
				validate: q.validate,
			}),
		...(typeof q.validate_msg === "string" &&
			q.validate_msg.length > 0 && {
				validate_msg: q.validate_msg,
			}),
		...(typeof q.calculate === "string" &&
			q.calculate.length > 0 && {
				calculate: q.calculate,
			}),
		...(typeof q.default_value === "string" &&
			q.default_value.length > 0 && {
				default_value: q.default_value,
			}),
		...(Array.isArray(q.options) &&
			q.options.length > 0 && {
				options: q.options,
			}),
		...(typeof q.case_property === "string" &&
			q.case_property.length > 0 && {
				case_property: q.case_property,
			}),
	};
	const result = fieldSchema.safeParse(candidate);
	if (!result.success) {
		log.warn(
			`[addFields] dropped invalid field candidate id=${q.id} kind=${q.kind}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		);
		return undefined;
	}
	return result.data;
}

/**
 * Coerce the scalar-patch portion of an `editField` call into the
 * reducer's field-patch shape. `id` and `kind` changes are handled
 * by the editField tool via separate mutations (`renameField` and
 * `convertField`) before this runs, so neither key appears on the
 * input here.
 *
 * Every clearable key in the edit schema is `.nullable().optional()`:
 *   - absent   → leave current value alone (key not in output patch)
 *   - `null`   → clear the property (key in output patch with
 *                `undefined`; Immer's Object.assign drops it)
 *   - a value  → set the property (key in output patch with the value)
 *
 * Uniform `?? undefined` coercion covers all three cases. Unlike the
 * add-path where empty string is a required-sentinel that means absent,
 * the edit path reserves `null` for "clear" so the SA has an
 * unambiguous way to remove a property the user explicitly asked to
 * unset.
 */
function editPatchToFieldPatch(
	updates: Omit<z.infer<typeof editFieldUpdatesSchema>, "id" | "kind">,
): Partial<Omit<Field, "uuid">> {
	const patch: Record<string, unknown> = {};
	const scalarKeys = [
		"label",
		"hint",
		"required",
		"validate",
		"validate_msg",
		"relevant",
		"calculate",
		"default_value",
		"case_property",
	] as const;
	for (const key of scalarKeys) {
		const value = updates[key];
		if (value === undefined) continue;
		patch[key] = value ?? undefined;
	}
	if (updates.options !== undefined) {
		patch.options = updates.options ?? undefined;
	}
	return patch as Partial<Omit<Field, "uuid">>;
}

// ── Domain-native tree snapshots for SA read tools ────────────────────

/**
 * Shape returned by `getForm` — the form entity augmented with its
 * ordered, nested field tree. Uses the domain `Form` type verbatim
 * (domain names like `closeCondition`, `postSubmit`, `formLinks`).
 */
export type FormSnapshot = Form & { fields: FieldWithChildren[] };

function formSnapshot(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormSnapshot | undefined {
	const form = doc.forms[formUuid];
	if (!form) return undefined;
	return { ...form, fields: buildFieldTree(doc, formUuid) };
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
				// `emit` computes the post-mutation doc, ships it on SSE +
				// persists it, then advances the SA's working doc — atomic
				// per call site. Later tool calls in the same turn (scaffold,
				// addModule) read the advanced `doc` for index → uuid
				// resolution.
				const muts: Mutation[] = [
					{ kind: "setAppName", name: appName },
					...setCaseTypesMutations(doc, caseTypes),
				];
				emit(muts, "schema");

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
				emit(muts, "scaffold");

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
				// apply. Return a silent success — the client reads the module
				// entity directly, so no stream event is needed here.
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
				emit(muts, `module:${moduleIndex}`);

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

		addFields: tool({
			description:
				"Add a batch of fields to an existing form. Appends to existing fields (does not replace). Groups added in one batch can be referenced as parentId in later batches.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				fields: z.array(addFieldsItemSchema),
			}),
			execute: async ({ moduleIndex, formIndex, fields }) => {
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

					// Process incoming flat SA-format fields: strip sentinels, apply
					// case-property defaults from the data model, then mint a uuid
					// and assemble the domain `Field` shape. The SA emits flat items
					// with semantic `parentId` — resolve each to a uuid by id lookup
					// within the form's existing + newly-added fields. If the SA
					// refers to a parent added earlier in this same batch, we find
					// it in `mintedByBareId` before falling back to the doc-wide
					// lookup.
					const mintedByBareId = new Map<string, Uuid>();
					const muts: Mutation[] = [];
					const skippedIds: string[] = [];

					for (const raw of fields) {
						const processed = applyDefaults(
							stripEmpty(raw as unknown as FlatField),
							doc.caseTypes,
							form.type,
							mod.caseType,
						) as Partial<FlatField> & { parentId?: string | null };

						// Resolve parentUuid: empty/undefined → form; otherwise find
						// the uuid of a newly-added parent or an existing field.
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
						const field = flatFieldToField(processed, fieldUuid);
						if (!field) {
							// The flat payload didn't assemble into a valid Field for its
							// declared kind — e.g. a text field without label, or a
							// multi_select without options. `flatFieldToField` logged the
							// specific schema issues; surface a generic failure to the SA
							// so it can diagnose via `validateApp` or retry.
							skippedIds.push(processed.id ?? "<unknown>");
							continue;
						}
						mintedByBareId.set(field.id, fieldUuid);
						muts.push({ kind: "addField", parentUuid, field });
					}

					// Emit + advance in one atomic step. The client applies via
					// `applyMany` — no wire snapshot needed; the mutations ARE
					// the update. The `form:M-F` stage tag drives lifecycle
					// derivation on the client (forms phase).
					emit(muts, `form:${moduleIndex}-${formIndex}`);

					const totalCount = countFieldsUnder(doc, formUuid);
					const addedIds = muts
						.filter(
							(m): m is Extract<Mutation, { kind: "addField" }> =>
								m.kind === "addField",
						)
						.map((m) => m.field.id)
						.join(", ");
					const skippedNote =
						skippedIds.length > 0
							? ` Skipped ${skippedIds.length} invalid field(s): ${skippedIds.join(", ")}.`
							: "";
					return `Successfully added ${muts.length} field${muts.length === 1 ? "" : "s"} to "${form.name}": ${addedIds}. Form now has ${totalCount} total field${totalCount === 1 ? "" : "s"}.${skippedNote}`;
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
							fieldCount: countFieldsUnder(doc, fUuid),
						};
					}),
				};
			},
		}),

		getForm: tool({
			description:
				"Get a form by module and form index. Returns the full form including all fields (nested by group/repeat containers).",
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
				const snapshot = formSnapshot(doc, formUuid);
				if (!snapshot)
					return { error: `Form m${moduleIndex}-f${formIndex} not found` };
				return { moduleIndex, formIndex, form: snapshot };
			},
		}),

		getField: tool({
			description: "Get a single field by ID within a form.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				fieldId: z.string().describe("Field id"),
			}),
			execute: async ({ moduleIndex, formIndex, fieldId }) => {
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
				// If the resolved field is a container, include its children so
				// the SA sees the subtree in one call. Leaf fields return a plain
				// `Field` with no `children` key.
				const field = isContainer(resolved.field)
					? {
							...resolved.field,
							children: buildFieldTree(doc, resolved.field.uuid),
						}
					: resolved.field;
				return {
					moduleIndex,
					formIndex,
					fieldId,
					path: resolved.path,
					field,
				};
			},
		}),

		// ── Field mutations ────────────────────────────────────────

		editField: tool({
			description:
				"Update properties on an existing field. Only include properties you want to change. Use null to clear a property. Renaming the id automatically propagates XPath and column references — for case properties, propagates across all forms in the module.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				fieldId: z.string().describe("Field id to update"),
				updates: editFieldUpdatesSchema,
			}),
			execute: async ({ moduleIndex, formIndex, fieldId, updates }) => {
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

					const { id: newId, kind: newKind, ...fieldUpdates } = updates;

					// Kind change → convertField mutation (not updateField).
					// The updateField reducer parses the merged patch against
					// `fieldSchema` and silently no-ops when a kind change
					// introduces required keys the target kind demands (e.g.
					// `options` on single_select). Routing through convertField
					// makes the intent explicit + surfaces a clear error when
					// the conversion isn't allowed by the kind's convertTargets
					// list.
					if (newKind && newKind !== resolved.field.kind) {
						const fromKind = resolved.field.kind;
						const allowed = fieldRegistry[fromKind].convertTargets;
						if (!allowed.includes(newKind)) {
							return {
								error: `Cannot convert ${fromKind} to ${newKind}. Valid targets: ${allowed.length > 0 ? allowed.join(", ") : "(none)"}.`,
							};
						}
						const convertMuts: Mutation[] = [
							{
								kind: "convertField",
								uuid: resolved.field.uuid,
								toKind: newKind,
							},
						];
						emit(convertMuts, `convert:${moduleIndex}-${formIndex}`);

						// The `convertField` reducer applies `reconcileFieldForKind`,
						// which runs `fieldSchema.safeParse` on the reconciled shape.
						// If the target kind demands a key the source doesn't carry
						// (edge cases beyond what `convertTargets` alone can catch),
						// the reducer logs and no-ops, leaving the original kind in
						// place. Verify the conversion actually landed so we don't
						// tell the SA "kind: multi_select" when the field is still
						// `single_select`.
						const postConvertField = doc.fields[resolved.field.uuid];
						if (!postConvertField || postConvertField.kind !== newKind) {
							return {
								error: `convertField ${fromKind} → ${newKind} for "${fieldId}" rejected by the reducer: the target kind's schema requires a key the source doesn't carry. Add the missing key first (e.g. \`options\` for select kinds), then retry.`,
							};
						}
					}

					// Handle id rename next as its own emitted batch. The
					// `renameField` reducer handles the full cascade on its own —
					// form-local path / hashtag rewrites, cross-form `#case/`
					// hashtag rewrites scoped to modules with matching caseType,
					// peer-field renames, and case list / detail column renames.
					// The client runs the SAME reducer against `applyMany`, so the
					// cascade reproduces on the client without needing a full
					// blueprint snapshot.
					if (newId && newId !== fieldId) {
						const renameMuts = renameFieldMutations(
							doc,
							resolved.field.uuid,
							newId,
						);
						emit(renameMuts, `rename:${moduleIndex}-${formIndex}`);
					}

					// Re-resolve the field uuid after rename (the uuid is stable,
					// but we want the most recent `field` snapshot for egress).
					const finalId = newId ?? fieldId;
					const afterRename = resolveFieldByIndex(
						doc,
						moduleIndex,
						formIndex,
						finalId,
					);
					if (!afterRename)
						return { error: `Field "${finalId}" not found after rename` };

					// Apply remaining property updates as a final emitted batch.
					// Convert + rename already landed in their own batches; this
					// one covers the leftover scalar-patch keys. The reducer still
					// gates against shape violations via `fieldSchema.safeParse`,
					// so anything slipping through here that doesn't fit the
					// (possibly just-converted) kind is logged and no-ops safely.
					if (Object.keys(fieldUpdates).length > 0) {
						const patch = editPatchToFieldPatch(fieldUpdates);
						if (Object.keys(patch).length > 0) {
							const updateMuts = updateFieldMutations(
								doc,
								afterRename.field.uuid,
								patch,
							);
							emit(updateMuts, `edit:${moduleIndex}-${formIndex}`);
						}
					}

					const postField = doc.fields[afterRename.field.uuid];
					const changedFields = Object.keys(updates).join(", ");
					const renameNote =
						newId && newId !== fieldId ? ` (renamed from "${fieldId}")` : "";
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
					return `Successfully updated "${finalId}"${renameNote} in "${formName}". Changed: ${changedFields}. Current label: "${label}", kind: ${kind}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		}),

		addField: tool({
			description:
				"Add a new field to an existing form. Use beforeFieldId or afterFieldId to control position; omit both to append at end.",
			inputSchema: z.object({
				moduleIndex: z.number().describe("0-based module index"),
				formIndex: z.number().describe("0-based form index"),
				field: addFieldSchema,
				afterFieldId: z
					.string()
					.optional()
					.describe("Insert after this field ID. Omit to append at end."),
				beforeFieldId: z
					.string()
					.optional()
					.describe(
						"Insert before this field ID. Takes precedence over afterFieldId.",
					),
				parentId: z
					.string()
					.optional()
					.describe("ID of a group/repeat to nest inside"),
			}),
			execute: async ({
				moduleIndex,
				formIndex,
				field: fieldInput,
				afterFieldId,
				beforeFieldId,
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
					if (beforeFieldId) {
						const target = order.findIndex(
							(u) => doc.fields[u]?.id === beforeFieldId,
						);
						if (target !== -1) insertIndex = target;
					} else if (afterFieldId) {
						const target = order.findIndex(
							(u) => doc.fields[u]?.id === afterFieldId,
						);
						if (target !== -1) insertIndex = target + 1;
					}

					const uuid = asUuid(crypto.randomUUID());
					const field = flatFieldToField(fieldInput, uuid);
					if (!field) {
						return {
							error: `Field "${fieldInput.id}" (kind=${fieldInput.kind}) failed schema validation — likely a missing required property for the kind (e.g. options on a select, or a non-empty label on a visible kind).`,
						};
					}
					const muts = addFieldMutations(doc, {
						parentUuid,
						field,
						index: insertIndex,
					});
					emit(muts, `form:${moduleIndex}-${formIndex}`);

					const formName = doc.forms[formUuid]?.name ?? "";
					const totalCount = countFieldsUnder(doc, formUuid);
					const posDesc = beforeFieldId
						? `before "${beforeFieldId}"`
						: afterFieldId
							? `after "${afterFieldId}"`
							: "at end";
					const parentDesc = parentId ? ` inside group "${parentId}"` : "";
					return `Successfully added field "${fieldInput.id}" (${fieldInput.label ?? ""}) to "${formName}" ${posDesc}${parentDesc}. Form now has ${totalCount} field${totalCount === 1 ? "" : "s"}.`;
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
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
					// Compute the helper mutations once so both the emit +
					// working-doc advance use the same batch. `emit` computes
					// the post-mutation doc once and threads it through to the
					// context (for Firestore) while reassigning the SA's
					// working doc in the same step.
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
