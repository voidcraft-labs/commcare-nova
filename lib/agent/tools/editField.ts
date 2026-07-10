/**
 * SA tool: `editField` — update properties on an existing field.
 *
 * The most complex of the field-edit tools: a single call can carry a
 * kind conversion, an id rename, AND a scalar-property patch. Each of
 * those three concerns produces its own mutation batch with its own
 * stage tag (`convert:M-F`, `rename:M-F`, `edit:M-F`) so the log UI and
 * replay derivations see each lifecycle step distinctly. Both the SA
 * chat factory and the MCP adapter call this through the shared
 * `ToolExecutionContext` interface.
 *
 * The stages are BUILT sequentially against local candidate docs (a
 * later batch reads the previous batch's result — e.g. a scalar patch
 * targets the just-converted kind's schema) but COMMIT as one edit:
 * `guardedMutateStages` runs the validity gate over the whole sequence
 * before anything persists, so a rejection — whichever stage's batch
 * would introduce the finding — leaves zero committed prefix. "A
 * rejected call saved nothing" holds for this tool exactly as for every
 * single-batch tool.
 *
 * Six exit branches:
 *
 *   1. Field not found at the given triple → `{ error }`, no mutations.
 *   2. Rename rejected by the shared identifier verdict (XML-illegal /
 *      reserved / over-long / sibling-conflicting new id, checked
 *      before ANY stage builds) → `{ error }`, nothing persisted.
 *   3. Illegal kind conversion (target not in the source kind's
 *      `convertTargets`) → `{ error }`, no mutations.
 *   4. Conversion rejected by the reducer (reconcile returned a shape
 *      the target kind's schema rejects) → `{ error }`, nothing
 *      persisted (the candidate apply runs before anything commits).
 *   5. Commit-gate rejection of the whole edit (`guardedMutateStages` —
 *      the combined batches would introduce a validator finding) →
 *      `{ error }` listing the findings, nothing persisted.
 *   6. Success → a human-readable `message` referencing the final id +
 *      changes, plus a UI `summary` for the chat transcript.
 */

import { z } from "zod";
import { parseXPathForField } from "@/lib/doc/expressionText";
import { renameFieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import { reconciledOptions } from "@/lib/doc/order/options";
import { declareCaseTypeMutations } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	FieldKind,
	FieldPatchFor,
	SelectOption,
	Uuid,
	XPathExpression,
} from "@/lib/domain";
import { fieldKindDeclaresKey, getConvertibleTypes } from "@/lib/domain";
import {
	renameFieldMutations,
	resolveFieldByIndex,
	updateFieldMutations,
} from "../blueprintHelpers";
import { unescapeXPath } from "../contentProcessing";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	editFieldUpdatesSchema,
	type wideEditUpdatesSchema,
} from "../toolSchemas";
import {
	applyToDoc,
	guardedMutateStages,
	type MutatingToolResult,
	type StagedMutationBatch,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

/**
 * The properties `clear` may name. Identity (`id`, `kind`) and `repeat`
 * (a repeat always has a mode) are not clearable; whether a listed slot
 * exists on the FIELD'S kind is checked in the body against
 * `fieldKindDeclaresKey`, with `validate` clearing `validate_msg` too.
 */
const CLEARABLE_SLOTS = [
	"label",
	"hint",
	"help",
	"required",
	"relevant",
	"calculate",
	"default_value",
	"validate",
	"options",
	"case_property_on",
] as const;

export const editFieldInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z.string().describe("Field id to update"),
		updates: editFieldUpdatesSchema,
		clear: z
			.array(z.enum(CLEARABLE_SLOTS))
			.nullable()
			.optional()
			.describe(
				"Properties to REMOVE from the field (e.g. drop its hint, unset its " +
					"validation). This is the only way to clear — a null in `updates` " +
					'means "leave unchanged", never "clear". Pass null when ' +
					"nothing is being removed.",
			),
	})
	.strict();

export type EditFieldInput = z.infer<typeof editFieldInputSchema>;

/** Success carries the LLM-facing `message` + a UI-only `summary` for the chat
 *  transcript; failure is an error record. */
export type EditFieldResult = MutationSuccess | { error: string };

/**
 * Coerce the scalar-patch portion of an `editField` call into the
 * reducer's field-patch shape. `id` and `kind` changes land via
 * dedicated mutations (`renameField`, `convertField`) earlier in the
 * tool body, so neither appears on this shape.
 *
 * Every key in the edit schema is `.nullable().optional()`:
 *   - absent OR `null` → leave the current value alone (key omitted from
 *     the output patch). The wire forces every key present on a tool
 *     call, so `null` is the model's only way to NOT touch a slot —
 *     treating it as a clear would wipe every property an edit didn't
 *     mention (observed live: "change only the label" arrived with null
 *     on every other slot).
 *   - a value → set the property (key present with the value).
 *
 * CLEARS are explicit: the input's `clear` array names the properties to
 * unset; `buildClearPatch` maps them to the `null`-valued patch entries
 * the `updateField` reducer deletes keys on (`null`, unlike `undefined`,
 * survives serialization, so the clear round-trips through the event log).
 */
/**
 * The WIDE edit-patch shape minus identity/discriminant. The per-kind edit
 * union tool input narrows this per arm; the mapper reads against the wide
 * shape so it touches any declared key without narrowing on `kind`.
 */
type EditUpdatesPatch = Omit<
	z.infer<typeof wideEditUpdatesSchema>,
	"id" | "kind"
>;

function editPatchToFieldPatch(
	updates: EditUpdatesPatch,
	parseExpr: (text: string) => XPathExpression,
	existingOptions: readonly SelectOption[] | undefined,
): FieldPatchFor<FieldKind> {
	const patch: Record<string, unknown> = {};
	// Plain scalars: SA passes a new value; `null` and absent both leave
	// the slot unchanged. The XPath-valued scalars get HTML-entity unescape
	// on the way through — same treatment `applyDefaults` applies on the add
	// path, so the same SA payload produces the same stored entity through
	// both tools — and the AST-stored slots (`relevant`, `calculate`,
	// `default_value`) additionally parse to their stored expression form.
	const astScalarKeys = new Set([
		"relevant",
		"calculate",
		"default_value",
		"required",
	]);
	const scalarKeys = [
		"label",
		"hint",
		// `help` is plain text (tap-to-expand longer-form guidance), so
		// it rides the plain-scalar path — no XPath unescape, unlike
		// `relevant` / `calculate` / `default_value` / `required`. The
		// media companion `help_media` is set through the dedicated
		// media tools, never via this text patch.
		"help",
		"required",
		"relevant",
		"calculate",
		"default_value",
		"case_property_on",
	] as const;
	for (const key of scalarKeys) {
		const value = updates[key];
		if (value === undefined || value === null) continue;
		if (typeof value === "string" && astScalarKeys.has(key)) {
			patch[key] = parseExpr(unescapeXPath(value));
		} else {
			patch[key] = value;
		}
	}
	if (updates.options !== undefined && updates.options !== null) {
		// The SA's wholesale replacement is uuid/order-less (identity is off its
		// wire — `saOptionSchema` omits both). Reconcile against the field's
		// CURRENT options so surviving values keep their uuid and every option
		// lands keyed: a uuid-less option committed mid-session is INVISIBLE to
		// the per-uuid option diff (and `options` sits in the generic-patch
		// skip-set), so a collaborator's next edit to it would silently never
		// persist until a reload's backfill.
		patch.options = reconciledOptions(updates.options, existingOptions);
	}
	// Nested `validate: { expr, msg? }` config. SA passes:
	//   - object → replace; flatten back to schema's `validate` +
	//     `validate_msg` keys (msg unset → `null`, which clears it).
	//     `expr` is XPath, so unescape on the way through.
	//   - null / omitted → leave unchanged (clears ride the `clear` list).
	if (updates.validate !== undefined && updates.validate !== null) {
		patch.validate = parseExpr(unescapeXPath(updates.validate.expr));
		patch.validate_msg = updates.validate.msg ?? null;
	}
	// Nested `repeat: { mode, count?, ids_query? }` config. The patch
	// always overwrites all three flat repeat keys when `repeat` is
	// present: the new mode determines which mode-specific field is
	// valid, and the unused field gets `null` so the reducer clears it.
	// Mode is required inside the nested object so we always have a value
	// to write. `count` and `ids_query` are XPath expressions —
	// empty-string is treated as "not set" (matching the add path's
	// truthy-check) and unescaped when present.
	if (updates.repeat !== undefined && updates.repeat !== null) {
		patch.repeat_mode = updates.repeat.mode;
		patch.repeat_count =
			updates.repeat.count && updates.repeat.count.length > 0
				? parseExpr(unescapeXPath(updates.repeat.count))
				: null;
		patch.data_source =
			updates.repeat.ids_query && updates.repeat.ids_query.length > 0
				? { ids_query: parseExpr(unescapeXPath(updates.repeat.ids_query)) }
				: null;
	}
	return patch as FieldPatchFor<FieldKind>;
}

export const editFieldTool = {
	description:
		"Update properties on an existing field. Pass the field's current kind to edit it in place — that selects the set of properties this kind actually has; passing a different kind requests a conversion to that kind. Give a property a value to change it; null (or leaving it out) keeps its current value. To REMOVE a property (drop a hint, unset validation), name it in `clear` — that is the only way to clear. Renaming the id automatically propagates XPath and column references — for case properties, propagates across all forms in the module.",
	inputSchema: editFieldInputSchema,
	async execute(
		input: EditFieldInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<EditFieldResult>> {
		const { moduleIndex, formIndex, fieldId, updates, clear } = input;
		try {
			const resolved = resolveFieldByIndex(
				doc,
				moduleIndex,
				formIndex,
				fieldId,
			);
			if (!resolved) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Field "${fieldId}" not found in m${moduleIndex}-f${formIndex}`,
					},
				};
			}

			const { id: newId, kind: newKind, ...fieldUpdates } = updates;

			// Candidate doc walks forward through each stage's batch so the
			// next stage builds against prior changes — locally only; nothing
			// persists until the whole edit passes the gate below.
			let workingDoc = doc;
			const stages: StagedMutationBatch[] = [];
			const fieldUuid: Uuid = resolved.field.uuid;

			// Pre-dispatch rename guard, checked BEFORE the convert stage so
			// a rejected rename fails the whole call with nothing persisted
			// (sibling scope and id format don't depend on the kind, so
			// checking against the pre-convert doc is equivalent). The shared
			// verdict (`lib/doc/identifierVerdicts.ts`) covers XML-name
			// legality, the reserved `__nova_` prefix, the case-property
			// length cap, and the peer-aware sibling-conflict scan — the same
			// rules the UI commit guard applies, with the validator's
			// DUPLICATE_FIELD_ID / INVALID_FIELD_ID rules as backstops.
			if (newId && newId !== fieldId) {
				const verdict = renameFieldIdVerdict({ doc, fieldUuid, newId });
				if (!verdict.ok) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Cannot rename "${fieldId}" to "${newId}". ${verdict.message}`,
						},
					};
				}
			}

			// Kind change → `convertField` mutation (not `updateField`). The
			// updateField reducer STRIPS `kind` (and `uuid`) from patches —
			// identity and discriminant are immutable through the patch path
			// — and applies the REST of the patch normally, so a kind-bearing
			// patch is NOT a whole-patch no-op: the kind silently drops while
			// every other key lands on the old kind. convertField is the
			// single designed kind-change path — it owns the convertibility
			// gate, and routing through it here surfaces a clear error when
			// the conversion isn't allowed by the source kind's
			// `convertTargets` list.
			if (newKind && newKind !== resolved.field.kind) {
				const fromKind = resolved.field.kind;
				const allowed = getConvertibleTypes(fromKind);
				if (!allowed.includes(newKind)) {
					// The passed `kind` is neither the field's actual kind nor a
					// legal conversion target. Name the ACTUAL kind so the agent
					// can correct in one turn — most often it meant to edit in
					// place and passed the wrong kind, so lead with the right one,
					// then compose the convert hint to read naturally whether or
					// not this kind has any conversion targets.
					const convertHint =
						allowed.length > 0
							? ` To convert it to a different kind, pass one of: ${allowed.join(", ")}.`
							: ` A "${fromKind}" field can't be converted to another kind.`;
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Field "${fieldId}" is a "${fromKind}" field, but you passed kind="${newKind}". To edit it in place, pass kind="${fromKind}".${convertHint}`,
						},
					};
				}
				const convertMuts: Mutation[] = [
					{ kind: "convertField", uuid: fieldUuid, toKind: newKind },
				];

				// Apply the candidate first so we can verify the reducer
				// accepted the conversion before STAGING it. A silent no-op
				// from the reducer (reconcile produces a shape the target
				// kind's schema rejects) would otherwise stage a misleading
				// `convert:M-F` event and the SA wrapper would advance
				// `doc = newDoc` against unchanged state.
				const afterConvert = applyToDoc(workingDoc, convertMuts);
				const postConvertField = afterConvert.fields[fieldUuid];
				if (!postConvertField || postConvertField.kind !== newKind) {
					// Candidate-only at this point — nothing has persisted.
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `convertField ${fromKind} → ${newKind} for "${fieldId}" rejected by the reducer: the target kind's schema requires a key the source doesn't carry. Add the missing key first (e.g. \`options\` for select kinds), then retry.`,
						},
					};
				}

				stages.push({
					mutations: convertMuts,
					doc: afterConvert,
					stage: `convert:${moduleIndex}-${formIndex}`,
				});
				workingDoc = afterConvert;
			}

			// Id rename next as its own emitted batch. The `renameField`
			// reducer handles the full cascade on its own — form-local rewrites,
			// cross-form hashtag and case-list column rewrites for the renamed
			// case property, and peer-field renames. The client runs the SAME
			// reducer against `applyMany`, so the cascade reproduces on the
			// client without needing a full blueprint snapshot.
			if (newId && newId !== fieldId) {
				const renameMuts = renameFieldMutations(workingDoc, fieldUuid, newId);
				if (renameMuts.length > 0) {
					workingDoc = applyToDoc(workingDoc, renameMuts);
					stages.push({
						mutations: renameMuts,
						doc: workingDoc,
						stage: `rename:${moduleIndex}-${formIndex}`,
					});
				}
			}

			// Re-resolve the field record after rename — the uuid is stable,
			// but we want the most recent `field` snapshot from `workingDoc`.
			const finalId = newId ?? fieldId;
			const afterRename = resolveFieldByIndex(
				workingDoc,
				moduleIndex,
				formIndex,
				finalId,
			);
			if (!afterRename) {
				// The rename stage is candidate-only at this point — nothing
				// has persisted, so the failure reports an untouched doc.
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Field "${finalId}" not found after rename` },
				};
			}

			// Remaining scalar-patch keys as a final stage. Convert + rename
			// are staged candidates above; this covers the leftovers. The reducer
			// still gates against shape violations via `fieldSchema.safeParse`,
			// so anything slipping through here that doesn't fit the
			// (possibly just-converted) kind is logged and no-ops safely.
			const clearRequested = [...new Set(clear ?? [])];
			if (Object.keys(fieldUpdates).length > 0 || clearRequested.length > 0) {
				// `fieldUpdates` is one validated per-kind union arm's rest; TS
				// infers its conditionally-present keys as `unknown`, so bridge
				// to the wide patch shape (sound — the arm is a structural
				// subset).
				// Expression text resolves against the doc as the patch will
				// see it (post-convert/rename stages), scoped to the field's
				// containing form.
				const patch = editPatchToFieldPatch(
					fieldUpdates as EditUpdatesPatch,
					(text) =>
						parseXPathForField(workingDoc, afterRename.field.uuid, text),
					(afterRename.field as { options?: SelectOption[] }).options,
				);
				// Fold the explicit clears in as `null` patch entries (the
				// reducer deletes a key on `null`). A slot the field's
				// (post-convert) kind doesn't declare, or one this same call
				// also SETS, is a contradiction — reject before staging.
				const postKind = afterRename.field.kind;
				const undeclared = clearRequested.filter(
					(slot) => !fieldKindDeclaresKey(postKind, slot),
				);
				if (undeclared.length > 0) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Cannot clear ${undeclared.map((c) => `"${c}"`).join(", ")} on "${finalId}" — a "${postKind}" field doesn't carry ${undeclared.length === 1 ? "that property" : "those properties"}.`,
						},
					};
				}
				const setAndCleared = clearRequested.filter(
					(slot) => patch[slot as keyof typeof patch] != null,
				);
				if (setAndCleared.length > 0) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `${setAndCleared.map((c) => `"${c}"`).join(", ")} on "${finalId}" ${setAndCleared.length === 1 ? "is" : "are"} both set in \`updates\` and listed in \`clear\` — pick one: a new value, or the clear.`,
						},
					};
				}
				const patchRecord = patch as Record<string, unknown>;
				for (const slot of clearRequested) {
					if (slot === "validate") {
						patchRecord.validate = null;
						patchRecord.validate_msg = null;
					} else {
						patchRecord[slot] = null;
					}
				}
				if (Object.keys(patch).length > 0) {
					// Declaration chokepoint: a patch RE-TARGETING `case_property_on`
					// to a type absent from the catalog declares it FIRST (a stage of
					// its own, so the type exists before the field's catalog sync
					// runs) — the reducer no longer auto-creates the type.
					const nextType = (patch as { case_property_on?: unknown })
						.case_property_on;
					if (typeof nextType === "string" && nextType.length > 0) {
						const declMuts = declareCaseTypeMutations(workingDoc, nextType);
						if (declMuts.length > 0) {
							workingDoc = applyToDoc(workingDoc, declMuts);
							stages.push({
								mutations: declMuts,
								doc: workingDoc,
								stage: `edit:${moduleIndex}-${formIndex}`,
							});
						}
					}
					// `afterRename.field.kind` is the kind after any
					// just-applied conversion — pass it as `targetKind` so
					// the mutation discriminates against the post-convert
					// shape, not the pre-convert kind from `resolved.field`.
					const updateMuts = updateFieldMutations(
						workingDoc,
						afterRename.field.uuid,
						afterRename.field.kind,
						patch,
					);
					if (updateMuts.length > 0) {
						workingDoc = applyToDoc(workingDoc, updateMuts);
						stages.push({
							mutations: updateMuts,
							doc: workingDoc,
							stage: `edit:${moduleIndex}-${formIndex}`,
						});
					}
				}
			}

			// Gate the WHOLE edit as one candidate; persist the stage batches
			// only after it passes. A rejection leaves zero committed prefix —
			// the agent re-issues the corrected call from the original state.
			const allMutations = stages.flatMap((s) => s.mutations);
			const commit = await guardedMutateStages(ctx, doc, stages);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}

			const postField = workingDoc.fields[afterRename.field.uuid];
			// `kind` is always present (it's the edit union's discriminator), so
			// only list it as a change when it was an actual conversion — and a
			// `null` update is a keep, never a change. Explicit clears are
			// reported as such.
			const changedKeys = [
				...Object.entries(updates)
					.filter(
						([k, v]) =>
							v !== null &&
							v !== undefined &&
							(k !== "kind" || newKind !== resolved.field.kind),
					)
					.map(([k]) => k),
				...clearRequested.map((slot) => `${slot} (cleared)`),
			];
			const renameNote =
				newId && newId !== fieldId ? ` (renamed from "${fieldId}")` : "";
			// `afterRename` already carries the form's uuid — read the display
			// name directly rather than re-traversing `moduleOrder` →
			// `formOrder` to get back to the same uuid.
			const formName =
				workingDoc.forms[afterRename.formUuid]?.name ??
				`m${moduleIndex}-f${formIndex}`;
			const label = postField && "label" in postField ? postField.label : "";
			const kind = postField?.kind ?? "unknown";
			// Report honestly when the call carried only the `kind` discriminator
			// and no rename — nothing actually changed, so don't claim a change
			// list ("Changed: .") the SA would read as a successful edit.
			const changeNote =
				changedKeys.length > 0
					? `Changed: ${changedKeys.join(", ")}.`
					: "No property values changed.";
			return {
				kind: "mutate" as const,
				mutations: allMutations,
				// The SA continues against the guarded writer's committed doc (a
				// peer's concurrent edit re-applied onto the fresh stored doc merged
				// in), NOT the tool's local `workingDoc` — every other mutating tool
				// returns `commit.newDoc` for the same reason. The message strings
				// above read `workingDoc` only for this call's own display values.
				newDoc: commit.newDoc,
				result: {
					message: `Successfully updated "${finalId}"${renameNote} in "${formName}". ${changeNote} Current label: "${label}", kind: ${kind}.`,
					summary: {
						location: formName,
						subject: label || finalId,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
