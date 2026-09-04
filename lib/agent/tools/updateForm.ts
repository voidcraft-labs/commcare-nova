/**
 * SA tool: `updateForm` — patch form-level metadata.
 *
 * Covers the four form-scoped edits the SA exposes: display name,
 * close condition (close forms only), refinement of an existing Connect
 * participant, and
 * post-submit navigation. Both the SA chat factory and the MCP adapter
 * call this through the shared `ToolInvocationContext` interface.
 *
 * Omission keeps, null clears: a slot left out keeps its current value;
 * an explicit `null` clears it (unconditional close again, post-submit
 * back to the form-type default). `name` is not nullable — a form always has
 * a name. App-wide Connect participation changes belong to
 * `configureConnect`; this tool can refine only a form that already
 * participates after the app has a mode. Connect-config patches go through
 * `buildConnectConfig`, a structural partial-update merge that applies
 * the same law per sub-config: a supplied sub-config merges with its
 * existing counterpart, a null one is REMOVED, an omitted one passes
 * through unchanged. A patch that would remove the last sub-config is a
 * participant-set change and is refused with the app-wide tool named.
 *
 * The merged connect config then runs through `enforceConnectIds` (the
 * agent-path source guard): an omitted connect id is autofilled with a
 * valid, unique, name-derived id (the doc carries it from then on), and an
 * explicitly-supplied invalid or duplicate id fails the call. Other
 * defaults are NOT invented here — `deliver_unit` may still land without
 * `entity_id`/`entity_name`, and the wire-emit layer supplies those XPath
 * fallbacks at bind time.
 *
 * Four exit branches:
 *
 *   1. Form UUID address does not resolve → `{ error }`, no mutations.
 *   2. An explicit connect id is invalid/duplicate → `{ error }`, no
 *      mutations (nothing written).
 *   3. Form disappeared after the patch (reducer-level rejection) →
 *      `{ error }`, mutations may have already been persisted.
 *   4. Success → human-readable summary listing the changed keys,
 *      tagged `form:M-F`.
 */

import { z } from "zod";
import { setFormDisplayConditionMutation } from "@/lib/doc/displayConditionMutations";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import { noMatchesFormEntryMutations } from "@/lib/doc/searchNoMatchesForm";
import type { ConnectConfig, PostSubmitDestination } from "@/lib/domain";
import {
	asUuid,
	moduleOpensOnSearch,
	POST_SUBMIT_DESTINATIONS,
} from "@/lib/domain";
import { predicateSchema } from "@/lib/domain/predicate";
import {
	refineFormConnectMutations,
	updateFormMutations,
} from "../blueprintHelpers";
import {
	closeConditionInputSchema,
	connectFormPatchSchema,
} from "../planningSchemas";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import { collectConnectIds, enforceConnectIds } from "./shared/connectIds";
import { buildConnectConfig } from "./shared/connectInput";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";
import {
	FORM_ENTRY_DESCRIPTION,
	formEntryInputSchema,
} from "./shared/formEntry";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const updateFormInputSchema = formAddressSchema
	.extend({
		name: z
			.string()
			.min(1)
			.optional()
			.describe("New form name. Leave it out to keep the current name."),
		close_condition: closeConditionInputSchema
			.nullable()
			.optional()
			.describe(
				'Close forms only. Set conditional close; use operator "selected" for multi-select fields. Pass null to make the close unconditional again; leave it out to keep the current condition.',
			),
		post_submit: z
			.enum(POST_SUBMIT_DESTINATIONS)
			.nullable()
			.optional()
			.describe(
				'Post-submit destination: "app_home", "module" (its form list), or "previous". null resets to the form-type default ("module" for a case form in a module that opens on Search, where "previous" is refused). With conditional after-submit links and no otherwise link this is where the form goes when none match, and it must be explicit.',
			),
		connect: connectFormPatchSchema
			.nullable()
			.optional()
			.describe(
				"Refine this already-participating form after the app has a Connect mode: omitted sub-configs keep their current value, null removes one sub-config only while another remains, and a stated one replaces it. Use configureConnect/configure_connect for enable, mode switch, participant-set changes, or disable; whole-slot null is refused here.",
			),
		displayCondition: predicateSchema
			.nullable()
			.optional()
			.describe(
				"Running-app visibility rule. A Predicate sets it, null removes it, omission keeps it.",
			),
		entry: formEntryInputSchema
			.nullable()
			.optional()
			.describe(FORM_ENTRY_DESCRIPTION),
	})
	.strict();

export type UpdateFormInput = z.infer<typeof updateFormInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateFormResult = MutationSuccess | { error: string };

export const updateFormTool = {
	description:
		"Update form metadata: name, close condition (close forms only), one existing Connect participant's configuration, or post-submit navigation.",
	inputSchema: updateFormInputSchema,
	async execute(
		input: UpdateFormInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<UpdateFormResult>> {
		const doc = ctx.snapshot.doc;
		const {
			moduleUuid: rawModuleUuid,
			formUuid: rawFormUuid,
			name,
			close_condition,
			post_submit,
			connect,
			displayCondition,
			entry,
		} = input;
		try {
			const address = resolveFormAddress(doc, {
				moduleUuid: rawModuleUuid,
				formUuid: rawFormUuid,
			});
			if (!address.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: address.error },
				};
			}
			const { formUuid, form: existing, module } = address;

			// Build the helper's patch shape. The SA's tool arg uses
			// `field` directly — no translation needed since the SA speaks
			// domain vocabulary. Omitted = leave unchanged; `null` = clear
			// (a `null` patch entry — the reducer deletes the key).
			const patch: Parameters<typeof updateFormMutations>[2] = {};
			let refinedConnect: ConnectConfig | undefined;
			if (name !== undefined) patch.name = name;
			if (close_condition === null) patch.closeCondition = null;
			if (close_condition != null) {
				const fieldUuid = asUuid(close_condition.fieldUuid);
				if (
					doc.fields[fieldUuid] === undefined ||
					findContainingForm(doc, fieldUuid) !== formUuid
				) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error: `Field UUID "${close_condition.fieldUuid}" is not in form "${existing.name}".`,
						},
					};
				}
				patch.closeCondition = {
					field: fieldUuid,
					answer: close_condition.answer,
					...(close_condition.operator && {
						operator: close_condition.operator,
					}),
				};
			}
			if (post_submit === null) patch.postSubmit = null;
			if (post_submit != null) {
				patch.postSubmit = post_submit as PostSubmitDestination;
			}
			if (entry != null) {
				/* The no-matches form's after-submit is fixed and it is on no
				 * menu, so the three navigation slots are refused in the same
				 * call rather than left for the gate to name one at a time. */
				const carried = [
					...(post_submit != null ||
					(post_submit === undefined && existing.postSubmit !== undefined)
						? ["post_submit"]
						: []),
					...(displayCondition != null ||
					(displayCondition === undefined &&
						existing.displayCondition !== undefined)
						? ["displayCondition"]
						: []),
					...((existing.formLinks?.length ?? 0) > 0
						? ["after-submit links"]
						: []),
				];
				if (carried.length > 0) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error: `Form "${existing.name}" cannot open after a search finds no matches while it carries ${carried.join(", ")}: that form always returns to Results showing the case it registered and is on no menu. Clear ${carried.length === 1 ? "it" : "them"} (post_submit: null, displayCondition: null, remove_form_link) in this call or before, then set entry.`,
						},
					};
				}
			}
			if (connect !== undefined) {
				if (doc.connectType === null) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error:
								"CommCare Connect is not enabled. Use configureConnect/configure_connect with the complete nonempty participant set.",
						},
					};
				}
				if (existing.connect === undefined) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error:
								"This form is not a Connect participant. Use configureConnect/configure_connect to replace the complete participant set.",
						},
					};
				}
				if (connect === null) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error:
								"Removing a form from Connect changes the app-wide participant set. Use configureConnect/configure_connect with the complete target.",
						},
					};
				}
				// Structural partial-update merge of exact XPath AST slots. Per
				// sub-config: omitted keeps the existing one, an explicit
				// null REMOVES it, a stated one replaces it.
				const merged = buildConnectConfig(connect, existing.connect);
				if (
					!merged.learn_module &&
					!merged.assessment &&
					!merged.deliver_unit &&
					!merged.task
				) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error:
								"Removing the form's final Connect section changes the app-wide participant set. Use configureConnect/configure_connect with the complete target.",
						},
					};
				} else {
					// Force connect ids correct at the source: autofill omitted
					// ids, reject explicit-invalid ids (fail the call, write
					// nothing). `existingIds` excludes this form's own ids so a
					// re-patch of an unchanged id doesn't read as a self-conflict.
					const enforced = enforceConnectIds(
						merged,
						doc.connectType,
						module.name,
						name ?? existing.name,
						collectConnectIds(doc, formUuid),
					);
					if (!enforced.ok) {
						return {
							kind: "mutate" as const,
							mutations: [],
							result: { error: enforced.error },
						};
					}
					refinedConnect = enforced.config;
				}
			}

			// Compute the mutations, apply via Immer, and persist through
			// the shared context so both surfaces write the same stream +
			// log + Postgres trio.
			const mutations = [
				...updateFormMutations(doc, formUuid, patch),
				...(refinedConnect === undefined
					? []
					: refineFormConnectMutations(doc, formUuid, refinedConnect)),
				/* Omission keeps the current condition; an explicit null clears it.
				 * The mutation spells the clear as null so it survives JSONB, SSE,
				 * and replay — `undefined` would be dropped and the stale condition
				 * would reappear on the next save. */
				...(displayCondition === undefined
					? []
					: [
							setFormDisplayConditionMutation(
								formUuid,
								displayCondition ?? undefined,
							),
						]),
				/* Setting the entry also opens the module on Search when it does
				 * not already, in this same batch (`searchNoMatchesForm.ts`). */
				...(entry === undefined
					? []
					: noMatchesFormEntryMutations(
							doc,
							module.uuid,
							formUuid,
							entry === null
								? null
								: {
										kind: entry.kind,
										...(entry.label != null && { label: entry.label }),
									},
						)),
			];
			const commit = await guardedMutate(ctx, mutations, `form:${formUuid}`);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

			const formAfter = newDoc.forms[formUuid];
			if (!formAfter) {
				return {
					kind: "mutate" as const,
					mutations: commit.mutations,
					result: {
						error: `Form ${formUuid} not found after update`,
					},
				};
			}
			const formChanges: string[] = [];
			if (name !== undefined) formChanges.push(`name → "${formAfter.name}"`);
			if (close_condition === null)
				formChanges.push("close_condition removed (unconditional close)");
			if (close_condition != null) formChanges.push("close_condition updated");
			if (post_submit !== undefined)
				formChanges.push(
					`post_submit → "${formAfter.postSubmit ?? "form-type default"}"`,
				);
			if (connect !== undefined) formChanges.push("connect updated");
			if (displayCondition === null)
				formChanges.push("display condition removed (always shown)");
			else if (displayCondition !== undefined)
				formChanges.push("display condition updated");
			if (entry === null)
				formChanges.push(
					`entry cleared (menu form${moduleOpensOnSearch(module) ? "; Search first off, search-answer starting values removed" : ""})`,
				);
			else if (entry !== undefined)
				formChanges.push(
					`entry → search-no-matches${moduleOpensOnSearch(module) ? "" : " (module now opens on Search)"}`,
				);
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Successfully updated form "${formAfter.name}" (${formAfter.type}, UUID ${formUuid}). Changed: ${formChanges.join(", ")}.`,
					summary: {
						location: module.name,
						subject: formAfter.name,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
