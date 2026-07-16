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
 *   1. Field not resolved at the given triple (missing, or a duplicated
 *      bare id `resolveFieldTarget` refuses as ambiguous — the uuid is
 *      the unambiguous handle) → `{ error }`, no mutations.
 *   2. Rename rejected by the shared identifier verdict (XML-illegal /
 *      reserved / over-long / sibling-conflicting new id, checked
 *      before ANY stage builds) → `{ error }`, nothing persisted.
 *   3. Illegal kind conversion (target not in the source kind's
 *      `convertTargets`), or a conversion into a select kind without
 *      the `options` the destination schema requires (they must ride
 *      the same call — the seed travels on the `convertField` mutation
 *      itself) → `{ error }`, no mutations.
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
	FIELD_REF_HINT,
	renameFieldMutations,
	resolveFieldTarget,
	updateFieldMutations,
} from "../blueprintHelpers";
import { unescapeXPath } from "../contentProcessing";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { editFieldUpdatesSchema } from "../toolSchemas";
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

export const editFieldInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z.string().describe(`Field to update — ${FIELD_REF_HINT}`),
		updates: editFieldUpdatesSchema,
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
 * Every clearable key in the edit schema is `.nullable().optional()`:
 *   - absent  → leave the current value alone (key omitted from the
 *     output patch)
 *   - `null`  → CLEAR the property — emitted as `null`, NOT `undefined`.
 *     The `updateField` reducer deletes the key on a `null` value, and
 *     `null` (unlike `undefined`) survives serialization, so the clear
 *     round-trips through the event log.
 *   - a value → set the property (key present with the value)
 */
/** The edit-patch shape minus identity (`id`/`kind` land via dedicated
 *  mutations earlier in the tool body, so neither appears here). */
type EditUpdatesPatch = Omit<
	z.infer<typeof editFieldUpdatesSchema>,
	"id" | "kind"
>;

function editPatchToFieldPatch(
	updates: EditUpdatesPatch,
	parseExpr: (text: string) => XPathExpression,
	existingOptions: readonly SelectOption[] | undefined,
): FieldPatchFor<FieldKind> {
	const patch: Record<string, unknown> = {};
	// Plain scalars: SA passes a new value, `null` to clear, or omits to
	// leave unchanged. A `null` is preserved as `null` (the reducer deletes
	// the key on it). The XPath-valued scalars get HTML-entity unescape
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
		if (value === undefined) continue;
		if (typeof value === "string" && astScalarKeys.has(key)) {
			patch[key] = parseExpr(unescapeXPath(value));
		} else {
			// A string sets the property; `null` clears it (preserved as
			// `null` so the clear survives serialization).
			patch[key] = value;
		}
	}
	if (updates.options !== undefined) {
		// The SA's wholesale replacement is uuid/order-less (identity is off its
		// wire — `saOptionSchema` omits both). Reconcile against the field's
		// CURRENT options so surviving values keep their uuid and every option
		// lands keyed: a uuid-less option committed mid-session is INVISIBLE to
		// the per-uuid option diff (and `options` sits in the generic-patch
		// skip-set), so a collaborator's next edit to it would silently never
		// persist until a reload's backfill. A `null` passes through verbatim
		// (a clear — on a kind that requires options, the commit gate rejects).
		patch.options =
			updates.options === null
				? null
				: reconciledOptions(updates.options, existingOptions);
	}
	// Nested `validate: { expr, msg? }` config. SA passes:
	//   - object → replace; flatten back to schema's `validate` +
	//     `validate_msg` keys (msg unset → `null`, which clears it).
	//     `expr` is XPath, so unescape on the way through.
	//   - null → clear both keys (emitted as `null`).
	//   - undefined (omitted) → leave unchanged.
	if (updates.validate !== undefined) {
		if (updates.validate === null) {
			patch.validate = null;
			patch.validate_msg = null;
		} else {
			patch.validate = parseExpr(unescapeXPath(updates.validate.expr));
			patch.validate_msg = updates.validate.msg ?? null;
		}
	}
	// Nested mode-discriminated `repeat` config. The patch always
	// overwrites all three flat repeat keys when `repeat` is present: the
	// new mode determines which mode-specific field is valid, and the
	// unused field gets `null` so the reducer clears it. `count` and
	// `ids_query` are XPath expressions — empty-string is treated as "not
	// set" (matching the add path's truthy-check) and unescaped when
	// present.
	const repeat = updates.repeat;
	if (repeat != null) {
		patch.repeat_mode = repeat.mode;
		patch.repeat_count =
			repeat.mode === "count_bound" && repeat.count.length > 0
				? parseExpr(unescapeXPath(repeat.count))
				: null;
		patch.data_source =
			repeat.mode === "query_bound" && repeat.ids_query.length > 0
				? { ids_query: parseExpr(unescapeXPath(repeat.ids_query)) }
				: null;
	}
	return patch as FieldPatchFor<FieldKind>;
}

export const editFieldTool = {
	description:
		"Update a field. Pass its current kind to edit in place, or a different kind to convert it. A value sets a property, null REMOVES it, leaving it out keeps it. An id rename propagates every reference automatically.",
	inputSchema: editFieldInputSchema,
	async execute(
		input: EditFieldInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<EditFieldResult>> {
		const { moduleIndex, formIndex, fieldId, updates } = input;
		try {
			const resolved = resolveFieldTarget(doc, moduleIndex, formIndex, fieldId);
			if (!resolved.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: resolved.error },
				};
			}
			// `fieldId` may have been the field's uuid — every rename
			// comparison below is against the SEMANTIC id.
			const currentId = resolved.field.id;

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
			if (newId && newId !== currentId) {
				const verdict = renameFieldIdVerdict({ doc, fieldUuid, newId });
				if (!verdict.ok) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Cannot rename "${currentId}" to "${newId}". ${verdict.message}`,
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
							error: `Field "${currentId}" is a "${fromKind}" field, but you passed kind="${newKind}". To edit it in place, pass kind="${fromKind}".${convertHint}`,
						},
					};
				}

				// Converting INTO a select kind from a kind that carries no
				// options (text → single_select): the destination schema
				// requires `.min(2)` options, and the only way they can exist
				// on the converted field is riding the convertField mutation
				// itself — a post-convert `updateField { options }` can't
				// help, because the convert would already have no-opped. So
				// the call's `options` are CONSUMED into the convert (minted
				// here, at the batch-building layer) and dropped from the
				// later scalar-patch stage. Kinds that already carry options
				// (single ↔ multi) keep the existing behavior: options
				// transfer verbatim in the reducer, and a same-call `options`
				// patch reconciles uuid identity in the patch stage.
				let convertOptionSeed: SelectOption[] | undefined;
				const sourceHasOptions = "options" in resolved.field;
				if (fieldKindDeclaresKey(newKind, "options") && !sourceHasOptions) {
					const seedInput = fieldUpdates.options;
					if (!seedInput || seedInput.length < 2) {
						return {
							kind: "mutate" as const,
							mutations: [],
							newDoc: doc,
							result: {
								error: `Converting "${currentId}" from ${fromKind} to ${newKind} needs the option list in the same call — pass \`options\` with at least 2 entries alongside kind="${newKind}".`,
							},
						};
					}
					convertOptionSeed = reconciledOptions(seedInput, undefined);
					// Consumed by the convert — the patch stage must not apply
					// it a second time against the already-seeded options.
					fieldUpdates.options = undefined;
				}

				const convertMuts: Mutation[] = [
					{
						kind: "convertField",
						uuid: fieldUuid,
						toKind: newKind,
						...(convertOptionSeed && { options: convertOptionSeed }),
					},
				];

				// Apply the candidate first so we can verify the reducer
				// accepted the conversion before STAGING it. A silent no-op
				// from the reducer (reconcile produces a shape the target
				// kind's schema rejects) would otherwise stage a misleading
				// `convert:M-F` event and the SA wrapper would advance
				// `doc = newDoc` against unchanged state. With the option
				// seed handled above, no matrix edge should land here — this
				// is the backstop for a future kind pair whose required keys
				// this tool doesn't know to thread.
				const afterConvert = applyToDoc(workingDoc, convertMuts);
				const postConvertField = afterConvert.fields[fieldUuid];
				if (!postConvertField || postConvertField.kind !== newKind) {
					// Candidate-only at this point — nothing has persisted.
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `convertField ${fromKind} → ${newKind} for "${currentId}" rejected by the reducer: the target kind's schema requires a key the source doesn't carry and this call didn't supply. Pass the missing property in the same call, or report this if none applies.`,
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
			if (newId && newId !== currentId) {
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

			// Re-read the field record after the convert/rename stages — by
			// its STABLE uuid, never by id: the just-assigned id could match
			// another field elsewhere in the form (the sibling-conflict
			// verdict only scans peers at the field's own level), and a
			// depth-first id lookup would silently patch that one instead.
			const finalId = newId ?? currentId;
			const currentField = workingDoc.fields[fieldUuid];
			if (!currentField) {
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
			if (Object.keys(fieldUpdates).length > 0) {
				// Expression text resolves against the doc as the patch will
				// see it (post-convert/rename stages), scoped to the field's
				// containing form.
				const patch = editPatchToFieldPatch(
					fieldUpdates,
					(text) => parseXPathForField(workingDoc, fieldUuid, text),
					(currentField as { options?: SelectOption[] }).options,
				);
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
					// `currentField.kind` is the kind after any just-applied
					// conversion — pass it as `targetKind` so the mutation
					// discriminates against the post-convert shape, not the
					// pre-convert kind from `resolved.field`.
					const updateMuts = updateFieldMutations(
						workingDoc,
						fieldUuid,
						currentField.kind,
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

			const postField = workingDoc.fields[fieldUuid];
			// `kind` is always required on the patch, so only list it as a
			// change when it was an actual conversion. A `null` update is a
			// clear — reported as such.
			const changedKeys = Object.entries(updates)
				.filter(
					([k, v]) =>
						v !== undefined &&
						(k !== "kind" || newKind !== resolved.field.kind),
				)
				.map(([k, v]) => (v === null ? `${k} (cleared)` : k));
			const renameNote =
				newId && newId !== currentId ? ` (renamed from "${currentId}")` : "";
			// `resolved` already carries the form's uuid — read the display
			// name directly rather than re-traversing `moduleOrder` →
			// `formOrder` to get back to the same uuid.
			const formName =
				workingDoc.forms[resolved.formUuid]?.name ??
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
