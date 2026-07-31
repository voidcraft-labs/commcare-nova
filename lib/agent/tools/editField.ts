/**
 * SA tool: `editField` — update properties on an existing field.
 *
 * The most complex of the field-edit tools: a single call can carry a
 * kind conversion, an id change, AND a scalar-property patch. Kind
 * conversion remains its dedicated mutation; every field property,
 * including `id` and `caseWrite`, lands in one post-conversion
 * `updateField` patch so the reducer sees the complete semantic edit
 * atomically. Both the SA chat factory and the MCP adapter call this
 * through the shared `ToolExecutionContext` interface.
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
 * Seven exit branches:
 *
 *   1. Field not resolved at the given triple (missing, or a duplicated
 *      bare id `resolveFieldTarget` refuses as ambiguous — the uuid is
 *      the unambiguous handle) → `{ error }`, no mutations.
 *   2. Rename rejected by the shared identifier verdict (XML-illegal /
 *      reserved / over-long / sibling-conflicting new id, checked
 *      before ANY stage builds) → `{ error }`, nothing persisted.
 *   3. Illegal kind conversion (target not in the source kind's
 *      `convertTargets`), or a conversion into a select kind without
 *      the `optionsSource` the destination schema requires (it must ride
 *      the same call — the seed travels on the `convertField` mutation
 *      itself) → `{ error }`, no mutations.
 *   4. A failable conversion (`plan.dataLossRisk`) whose counted
 *      impact is non-empty, without `confirmConversion: true` →
 *      `{ needsConfirmation, message }`, nothing persisted — the
 *      consent round; the same call with the flag proceeds.
 *   5. Conversion rejected by the reducer (reconcile returned a shape
 *      the target kind's schema rejects) → `{ error }`, nothing
 *      persisted (the candidate apply runs before anything commits).
 *   6. Commit-gate rejection of the whole edit (`guardedMutateStages` —
 *      the combined batches would introduce a validator finding) →
 *      `{ error }` listing the findings, nothing persisted.
 *   7. Success → a human-readable `message` referencing the final id +
 *      changes, plus a UI `summary` for the chat transcript.
 */

import { z } from "zod";
import { renameFieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import { planKindConversion } from "@/lib/doc/kindConversionCascade";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import { declareCaseTypeMutations } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	Field,
	FieldKind,
	FieldPatchFor,
	SelectOptionsSource,
	Uuid,
} from "@/lib/domain";
import {
	convertNeedsOptionSeed,
	findAuthoredBlueprintIdentity,
	getConvertibleTypes,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import { updateFieldMutations } from "../blueprintHelpers";
import { prepareToolOptionsSource } from "../contentProcessing";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { editFieldUpdatesSchema } from "../toolSchemas";
import {
	applyToDoc,
	guardedMutateStages,
	type MutatingToolResult,
	type StagedMutationBatch,
	toToolErrorResult,
} from "./common";
import {
	fieldAddressSchema,
	resolveFieldAddress,
} from "./shared/entityAddresses";
import type { CreatedOptionIdentity } from "./shared/fieldAssembly";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const editFieldInputSchema = fieldAddressSchema
	.extend({
		updates: editFieldUpdatesSchema,
		confirmConversion: z
			.boolean()
			.optional()
			.describe(
				"Consent flag for a kind conversion that would set saved case values aside. When a convert call returns needsConfirmation, tell the user what would happen, and repeat the same call with confirmConversion: true only after they agree. Meaningless on any other call — leave it out.",
			),
	})
	.strict();

export type EditFieldInput = z.infer<typeof editFieldInputSchema>;

/** Success carries the LLM-facing `message` + a UI-only `summary` for the chat
 *  transcript; failure is an error record. The `needsConfirmation` arm is
 *  the consent round for a failable kind conversion: nothing was changed,
 *  the counts state what the conversion would set aside, and the same call
 *  with `confirmConversion: true` proceeds. */
export type EditFieldResult =
	| (MutationSuccess & { options?: CreatedOptionIdentity[] })
	| { error: string }
	| {
			needsConfirmation: {
				property: string;
				fromType: CasePropertyDataType;
				toType: CasePropertyDataType;
				totalWithValue: number;
				uncastable: number;
				alreadyHeld: number;
				samples: readonly unknown[];
			};
			message: string;
			/** Transcript presentation — `awaitingConsent` keeps the row
			 *  from claiming a completed edit, and its presence keeps the
			 *  model-directed `message` prose off the user-facing detail
			 *  line. */
			summary: ToolCallSummary;
	  };

/**
 * Coerce the property-patch portion of an `editField` call into the
 * reducer's field-patch shape. `kind` alone lands via its dedicated
 * `convertField` mutation. `id` and `caseWrite` remain independent slots:
 * changing the form-local id never renames a case property, while setting or
 * clearing `caseWrite` retargets only this writer.
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
/** The edit-patch shape minus only the conversion discriminator. */
type EditUpdatesPatch = Omit<z.infer<typeof editFieldUpdatesSchema>, "kind">;

function editPatchToFieldPatch(
	updates: EditUpdatesPatch,
	preparedOptionsSource: SelectOptionsSource | undefined,
): FieldPatchFor<FieldKind> {
	const patch: Record<string, unknown> = {};
	// Scalar SA/MCP values already use stored structures. A value sets the
	// property, `null` clears it, and omission leaves it unchanged. The
	// projected options source is the one exception, supplied separately after
	// its identity bridge.
	const scalarKeys = [
		"id",
		"label",
		"hint",
		"help",
		"required",
		"relevant",
		"calculate",
		"default_value",
		"caseWrite",
	] as const;
	for (const key of scalarKeys) {
		const value = updates[key];
		if (value === undefined) continue;
		patch[key] = value;
	}
	if (updates.optionsSource !== undefined) {
		if (preparedOptionsSource === undefined) {
			throw new Error("Prepared select-source identity projection is missing.");
		}
		// Source replacement is atomic. The one boundary bridge already mapped
		// every `optionUuid` creation slot before collision/admission.
		patch.optionsSource = preparedOptionsSource;
	}
	// Nested `validate: { expr, msg? }` config. SA passes:
	//   - object → replace; flatten back to schema's `validate` +
	//     `validate_msg` keys (msg unset → `null`, which clears it).
	//     both values are already canonical stored structures.
	//   - null → clear both keys (emitted as `null`).
	//   - undefined (omitted) → leave unchanged.
	if (updates.validate !== undefined) {
		if (updates.validate === null) {
			patch.validate = null;
			patch.validate_msg = null;
		} else {
			patch.validate = updates.validate.expr;
			patch.validate_msg = updates.validate.msg ?? null;
		}
	}
	// Nested mode-discriminated `repeat` config. The patch always
	// overwrites all three flat repeat keys when `repeat` is present: the
	// new mode determines which mode-specific field is valid, and the
	// unused field gets `null` so the reducer clears it.
	const repeat = updates.repeat;
	if (repeat != null) {
		patch.repeat_mode = repeat.mode;
		patch.repeat_count = repeat.mode === "count_bound" ? repeat.count : null;
		patch.data_source =
			repeat.mode === "query_bound" ? { ids_query: repeat.ids_query } : null;
	}
	return patch as FieldPatchFor<FieldKind>;
}

export const editFieldTool = {
	description:
		"Update a field. Pass its current kind to edit in place, or a different kind to convert it. A value sets a property, null REMOVES it, leaving it out keeps it. `id` is the form-local question name used in friendly XPath; changing it keeps UUID-backed references attached and never renames case data. Set `caseWrite` to a complete {caseType, property} pair to retarget this writer, or null to stop this field from writing a case property. A conversion that would set saved case values aside returns needsConfirmation instead of converting — relay it and re-call with confirmConversion: true once the user agrees.",
	inputSchema: editFieldInputSchema,
	async execute(
		input: EditFieldInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<EditFieldResult>> {
		const { updates, confirmConversion } = input;
		try {
			const resolved = resolveFieldAddress(doc, input);
			if (!resolved.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: resolved.error },
				};
			}
			const currentId = resolved.field.id;

			const { id: newId, kind: newKind, ...fieldUpdates } = updates;
			const preparedOptionsSource =
				fieldUpdates.optionsSource === undefined
					? undefined
					: prepareToolOptionsSource(fieldUpdates.optionsSource);

			// Replacement options may preserve identities already owned by this
			// field, but may not capture another authored object's UUID or repeat
			// one UUID inside the source. Admission runs on the prepared stored
			// shape, after the one optionUuid -> uuid bridge and before any
			// conversion or mutation is planned.
			if (preparedOptionsSource?.kind === "inline") {
				const ownOptionUuids = new Set(
					"optionsSource" in resolved.field &&
						resolved.field.optionsSource.kind === "inline"
						? resolved.field.optionsSource.options.map((option) => option.uuid)
						: [],
				);
				const seen = new Set<Uuid>();
				for (const option of preparedOptionsSource.options) {
					const existing = findAuthoredBlueprintIdentity(doc, option.uuid);
					if (
						seen.has(option.uuid) ||
						(existing !== undefined && !ownOptionUuids.has(option.uuid))
					) {
						return {
							kind: "mutate" as const,
							mutations: [],
							newDoc: doc,
							result: {
								error: `Option UUID ${option.uuid} is duplicated in this call or already belongs to another authored object.`,
							},
						};
					}
					seen.add(option.uuid);
				}
			}

			// Candidate doc walks forward through each stage's batch so the
			// next stage builds against prior changes — locally only; nothing
			// persists until the whole edit passes the gate below.
			let workingDoc = doc;
			const stages: StagedMutationBatch[] = [];
			const fieldUuid: Uuid = resolved.field.uuid;
			// Property-wide conversion effects, appended to the success
			// message by the convert stage below.
			let conversionNote = "";

			// Pre-dispatch rename guard, checked BEFORE the convert stage so
			// a rejected rename fails the whole call with nothing persisted
			// (sibling scope and id format don't depend on the kind, so
			// checking against the pre-convert doc is equivalent). The shared
			// verdict (`lib/doc/identifierVerdicts.ts`) covers XML-name
			// legality, the reserved `__nova_` prefix, and the sibling-conflict
			// scan — the same rules the UI commit guard applies, with the validator's
			// DUPLICATE_FIELD_ID / INVALID_FIELD_ID rules as backstops.
			if (newId && newId !== currentId) {
				const verdict = renameFieldIdVerdict({
					doc,
					fieldUuid,
					newId,
				});
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
				// requires a complete source arm, and the only way it can exist
				// on the converted field is riding the convertField mutation
				// itself — a post-convert `updateField { options }` can't
				// help, because the convert would already have no-opped. So
				// the call's `optionsSource` is CONSUMED into the convert
				// here, at the batch-building layer) and dropped from the
				// later scalar-patch stage. Kinds that already carry options
				// (single ↔ multi) keep the existing behavior: options
				// transfer verbatim in the reducer, and a same-call `optionsSource`
				// patch reconciles uuid identity in the patch stage.
				let selectSource: SelectOptionsSource | undefined;
				if (convertNeedsOptionSeed(resolved.field, newKind)) {
					if (!preparedOptionsSource) {
						return {
							kind: "mutate" as const,
							mutations: [],
							newDoc: doc,
							result: {
								error: `Converting "${currentId}" from ${fromKind} to ${newKind} needs a complete choice source in the same call — pass \`optionsSource\` alongside kind="${newKind}".`,
							},
						};
					}
					selectSource = preparedOptionsSource;
					// Consumed by the convert — the patch stage must not apply
					// it a second time against the already-seeded options.
					delete fieldUpdates.optionsSource;
				}

				// The property-centric plan: a case-bound string-scalar
				// conversion carries the property's other writers across in
				// the same batch and re-declares a stale declared data_type —
				// one field at a time can never cross the agreement gate. The
				// plan must see the binding as THIS CALL leaves it: a
				// same-call `caseWrite` change (retarget or null-clear)
				// must not cascade a binding the field is leaving.
				const changesCaseWrite = Object.hasOwn(fieldUpdates, "caseWrite");
				const planField = changesCaseWrite
					? ({
							...resolved.field,
							caseWrite: fieldUpdates.caseWrite ?? undefined,
						} as Field)
					: resolved.field;
				const plan = planKindConversion({
					doc: workingDoc,
					field: planField,
					toKind: newKind,
					...(selectSource && { optionsSource: selectSource }),
				});
				if (!plan.ok) {
					const blockerMessage =
						plan.blocker.carrier === "case-operation"
							? `case operation "${plan.blocker.id}" also writes it, and operation expressions cannot be converted mechanically. Update or remove that operation first.`
							: (() => {
									const blockerFormUuid = findContainingForm(
										workingDoc,
										plan.blocker.uuid,
									);
									const blockerForm =
										(blockerFormUuid
											? workingDoc.forms[blockerFormUuid]?.name
											: undefined) ?? "another form";
									return `the same case property is also captured by a ${plan.blocker.kind} field in "${blockerForm}", and a ${plan.blocker.kind} field can't convert to ${newKind}. Convert that field to text first (editField with kind="text"), then convert this property.`;
								})();
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Converting "${currentId}" to ${newKind} is blocked: ${blockerMessage}`,
						},
					};
				}

				const convertMuts: Mutation[] = plan.mutations;

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

				// The consent round — AFTER the cheap local checks above, so
				// the user is never asked to consent to an edit the reducer
				// would refuse anyway (and the impact's row scan doesn't run
				// for one). A flip whose per-row cast can fail
				// (`plan.dataLossRisk`) counts its actual impact BEFORE
				// anything commits: zero uncastable values means nothing to
				// consent to, so the call proceeds; a non-empty count
				// returns with nothing persisted so the model can relay the
				// stakes and re-call with the user's consent. The committed
				// mutations carry no consent flag — replay and undo re-run
				// the migration unconditionally, and the review surface is
				// the recovery path either way.
				if (plan.dataLossRisk !== undefined && confirmConversion !== true) {
					const risk = plan.dataLossRisk;
					const impact = await ctx.conversionImpact({
						caseType: risk.caseType,
						property: risk.property,
						toType: risk.toType,
					});
					if (impact.uncastable > 0) {
						const newlyHeld = impact.uncastable - impact.alreadyHeld;
						const examples = impact.samples
							.map((sample) => JSON.stringify(sample))
							.join(", ");
						const fieldLabel =
							"label" in resolved.field && resolved.field.label
								? projectProseTemplate(resolved.field.label, doc).text ||
									currentId
								: currentId;
						return {
							kind: "mutate" as const,
							mutations: [],
							newDoc: doc,
							result: {
								needsConfirmation: {
									property: risk.property,
									fromType: risk.fromType,
									toType: risk.toType,
									totalWithValue: impact.totalWithValue,
									uncastable: impact.uncastable,
									alreadyHeld: impact.alreadyHeld,
									samples: impact.samples,
								},
								message:
									`Nothing was changed. Converting "${currentId}" to ${newKind} retypes the case property "${risk.property}" from ${risk.fromType} to ${risk.toType}, and ${impact.uncastable} of ${impact.totalWithValue} saved values can't convert (for example: ${examples}). ` +
									`Each of those values would move to Data to review, and its case would be held out of the running app until someone decides it there — ${newlyHeld} case${newlyHeld === 1 ? "" : "s"} newly held${impact.alreadyHeld > 0 ? `, ${impact.alreadyHeld} already held for other waiting values` : ""}. Converting the property back restores the values automatically. ` +
									`Tell the user what would happen; if they agree, repeat this call with confirmConversion: true.`,
								summary: {
									location:
										doc.forms[resolved.formUuid]?.name ?? resolved.formUuid,
									subject: fieldLabel,
									awaitingConsent: true,
								} satisfies ToolCallSummary,
							},
						};
					}
				}

				stages.push({
					mutations: convertMuts,
					stage: `convert:${resolved.formUuid}`,
				});
				workingDoc = afterConvert;

				// Name the property-wide effects so the SA can relay them
				// without re-reading the blueprint: peer writers carried
				// across (by their containing form), and the declaration
				// following the writers.
				if (plan.peers.length > 0) {
					const peerForms = plan.peers.map((p) => {
						const peerFormUuid = findContainingForm(workingDoc, p.uuid);
						const name = peerFormUuid
							? workingDoc.forms[peerFormUuid]?.name
							: undefined;
						return name ? `"${name}"` : "another form";
					});
					conversionNote += ` Also converted the property's other writer${plan.peers.length === 1 ? "" : "s"} of the same kind (in ${peerForms.join(", ")}) so every form stays in agreement.`;
				}
				if (plan.redeclaredTo !== undefined) {
					// Worded from the plan's actual declaration — a hidden
					// conversion PINS the source type ("text"), it doesn't
					// declare "hidden" (not a data type).
					conversionNote += ` The case property's declared data_type is now "${plan.redeclaredTo}".`;
				}
			}

			// Re-read the field record after conversion by its STABLE uuid,
			// never by id. The one property patch below may change the id, but
			// address identity remains the uuid throughout.
			const finalId = newId ?? currentId;
			const currentField = workingDoc.fields[fieldUuid];
			if (!currentField) {
				// The conversion stage is candidate-only at this point — nothing
				// has persisted, so the failure reports an untouched doc.
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Field "${finalId}" not found after conversion` },
				};
			}

			// Every property, including an id change and a case destination,
			// lands in ONE final updateField patch. They remain independent:
			// id is form-local identity text; caseWrite retargets this writer.
			const propertyUpdates: EditUpdatesPatch = {
				...fieldUpdates,
				...(newId !== undefined &&
					newId !== currentId && {
						id: newId,
					}),
			};
			if (Object.keys(propertyUpdates).length > 0) {
				const patch = editPatchToFieldPatch(
					propertyUpdates,
					preparedOptionsSource,
				);
				if (Object.keys(patch).length > 0) {
					// Declaration chokepoint: a patch RE-TARGETING `caseWrite`
					// to a type absent from the catalog declares it FIRST (a stage of
					// its own, so the type exists before the field's catalog sync
					// runs) — the reducer no longer auto-creates the type.
					const nextWrite = (patch as { caseWrite?: unknown }).caseWrite;
					const nextType =
						typeof nextWrite === "object" &&
						nextWrite !== null &&
						"caseType" in nextWrite &&
						typeof nextWrite.caseType === "string"
							? nextWrite.caseType
							: undefined;
					if (nextType !== undefined && nextType.length > 0) {
						const declMuts = declareCaseTypeMutations(workingDoc, nextType);
						if (declMuts.length > 0) {
							workingDoc = applyToDoc(workingDoc, declMuts);
							stages.push({
								mutations: declMuts,
								stage: `edit:${resolved.formUuid}`,
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
							stage: `edit:${resolved.formUuid}`,
						});
					}
				}
			}

			// Gate the WHOLE edit as one candidate; persist the stage batches
			// only after it passes. A rejection leaves zero committed prefix —
			// the agent re-issues the corrected call from the original state.
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
						(k !== "kind" || newKind !== resolved.field.kind) &&
						(k !== "id" || newId !== currentId),
				)
				.map(([k, v]) => (v === null ? `${k} (cleared)` : k));
			const renameNote =
				newId && newId !== currentId ? ` (renamed from "${currentId}")` : "";
			// `resolved` already carries the form's uuid — read the display
			// name directly rather than re-traversing `moduleOrder` →
			// `formOrder` to get back to the same uuid.
			const formName =
				workingDoc.forms[resolved.formUuid]?.name ?? resolved.formUuid;
			const label =
				postField && "label" in postField && postField.label
					? projectProseTemplate(postField.label, workingDoc).text
					: "";
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
				mutations: commit.mutations,
				// The SA continues against the guarded writer's committed doc (a
				// peer's concurrent edit re-applied onto the fresh stored doc merged
				// in), NOT the tool's local `workingDoc` — every other mutating tool
				// returns `commit.newDoc` for the same reason. The message strings
				// above read `workingDoc` only for this call's own display values.
				newDoc: commit.newDoc,
				result: {
					message: `Successfully updated "${finalId}"${renameNote} in "${formName}". ${changeNote} Current label: "${label}", kind: ${kind}.${conversionNote}`,
					...(preparedOptionsSource?.kind === "inline" && {
						options: preparedOptionsSource.options.map((option) => ({
							uuid: option.uuid,
							value: option.value,
						})),
					}),
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
