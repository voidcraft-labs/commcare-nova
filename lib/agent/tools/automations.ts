import { produce } from "immer";
import { z } from "zod";
import { automationMatchProjection } from "@/lib/automations/matching";
import { buildAutomationSetupGuide } from "@/lib/automations/setupGuidance";
import { deepEqual } from "@/lib/doc/deepEqual";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	automationNestedUuids,
	automationSchema,
	type BlueprintDoc,
	findAuthoredBlueprintIdentity,
	orderedAutomations,
	ownRecordValue,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import {
	readOrganization,
	readOrganizationAuthoringSnapshot,
} from "@/lib/organization/service";
import type {
	OrganizationScope,
	OrganizationSnapshot,
	StoredLocation,
} from "@/lib/organization/types";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	type ReadToolResult,
	requireInvocationAppId,
	toToolErrorResult,
} from "./common";
import type { MutationSuccess } from "./shared/toolCallSummary";

export const getAutomationsInputSchema = z.object({}).strict();

export const addAutomationsInputSchema = z
	.object({
		automations: z
			.array(automationSchema)
			.min(1)
			.max(50)
			.describe(
				"Complete automation definitions in display order. Every automation and nested collection item uses a stable UUID. Use Nova case-property names and UUID-backed location conditions. Host-scoped criteria, update targets, update sources, and message case-property parts are refused when an advanced case operation can add a second extension relationship to the automation case type. Every host-scoped reference also requires exactly one live extension at runtime; retained extra extension indices make the current-match count unavailable when a criterion reads the host, and HQ's host choice is undefined. Message fields are structural templates: text parts stay literal, case-property parts are explicit identity references, and context-property parts explicitly select case-owner or recipient values. Message case-property parts cannot use owner, host, or last_modified_by because CommCare HQ's formatter context shadows those names. Recipient-filter values are structural exact literals or custom case-property references; every triggering case must contain a referenced property because HQ raises when it is missing. Filters may accompany only recipient kinds HQ resolves or expands to user accounts, never case, parent/child-case, case-email, case-group, or registered custom recipients. After trimming, a case-property event-time value must begin with H:MM or HH:MM and the whole value must parse as a time; AM/PM and seconds are accepted, while blank, nonmatching, or unparseable values use 12:00 PM. Email content carries exactly one plain-text or rich-text body, never parallel bodies. Registered IDs, language codes, and setup-only instructions are exact trimmed nonblank target-HQ values; setup-only instructions distinguish UCR from registered-custom criteria.",
			),
		afterAutomationUuid: uuidSchema
			.nullable()
			.optional()
			.describe(
				"Existing automation after which the new contiguous block belongs, null for first, or omit to append.",
			),
	})
	.strict();

export const updateAutomationInputSchema = z
	.object({
		automation: automationSchema.describe(
			"Complete desired state of one existing automation. Preserve every UUID that still names the same rule or nested item; omitted nested items are removed. Use Nova case-property names, structural message-template and recipient-filter values, explicit UCR/registered-custom setup-only kinds, exact registered/setup-only text, and one email body form. Filters require only user-account recipient kinds, and every triggering case must contain each structurally referenced filter property. After trimming, case-property event-time value must begin with H:MM or HH:MM and be entirely parseable as a time; AM/PM and seconds are accepted, while blank, nonmatching, or unparseable values fall back to 12:00 PM. Host-scoped criteria, update targets, update sources, and message case-property parts are refused when an advanced case operation can add a second extension relationship to the automation case type. Every host-scoped reference also requires exactly one live extension at runtime; retained extra extension indices make the current-match count unavailable when a criterion reads the host, and HQ's host choice is undefined. Message case-property parts cannot use owner, host, or last_modified_by because CommCare HQ's formatter context shadows those names.",
		),
	})
	.strict();

export const removeAutomationInputSchema = z
	.object({ automationUuid: uuidSchema })
	.strict();

interface SetupGuideResult {
	readonly automationUuid: Uuid;
	readonly setupGuide: ReturnType<typeof buildAutomationSetupGuide>;
	readonly omittedCriteria: readonly string[];
	readonly executesInPreview: false;
}

type AutomationMutationResult =
	| (MutationSuccess & {
			automationUuids: readonly Uuid[];
			setupGuides?: readonly SetupGuideResult[];
	  })
	| { error: string };

function scope(ctx: ToolInvocationContext): OrganizationScope {
	return {
		appId: requireInvocationAppId(ctx),
		projectId: ctx.projectId,
		actorUserId: ctx.userId,
		role: "tool",
		changeSource: {
			kind: ctx.chatRunHolder === undefined ? "mcp" : "chat",
			runId: ctx.runId,
		},
		...(ctx.chatRunHolder === undefined
			? {}
			: { chatRunHolder: ctx.chatRunHolder }),
	};
}

/**
 * The place catalog a setup guide resolves its location references against.
 *
 * Places are rows in the app's own store rather than Blueprint state, so this
 * stays an external read even where the document itself comes from the
 * workspace. A change set that has no app row yet cannot have a place row
 * either, so an empty catalog at revision 0 — the same answer
 * {@link readOrganization} gives an app that never created an organization —
 * is the honest reading, not a lookup against an app id that does not exist.
 *
 * Revision zero is also the real organization fence for genesis: no app row
 * or place row exists yet, and the materialization transaction proves that
 * empty snapshot before it creates either one.
 */
async function readPlacesForGuidance(
	ctx: ToolInvocationContext,
): Promise<OrganizationSnapshot> {
	if (ctx.appId === null) return { revision: "0", locations: [] };
	return readOrganization(scope(ctx));
}

function setupGuideResult(
	doc: BlueprintDoc,
	automation: z.infer<typeof automationSchema>,
	locations: readonly StoredLocation[],
): SetupGuideResult {
	return {
		automationUuid: automation.uuid,
		setupGuide: buildAutomationSetupGuide(doc, automation, locations),
		omittedCriteria: automationMatchProjection(doc, automation, locations)
			.omittedCriteria,
		executesInPreview: false,
	};
}

function mutationError(error: string): MutatingToolResult<{ error: string }> {
	return {
		kind: "mutate",
		mutations: [],
		result: { error },
	};
}

function allIdentities(
	automation: z.infer<typeof automationSchema>,
): readonly Uuid[] {
	return [automation.uuid, ...automationNestedUuids(automation)];
}

export const getAutomationsTool = {
	description:
		"Read every representable automatic case-update rule and conditional alert in display order, with stable UUIDs and freshly derived manual CommCare HQ setup guidance. Nova describes the locally representable matching subset but never executes these automations; match counts are available only in Builder Preview.",
	inputSchema: getAutomationsInputSchema,
	async execute(
		_input: z.infer<typeof getAutomationsInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		try {
			// The workspace owns the document, so the automations come from the
			// snapshot this invocation reads. Re-reading the persisted app would
			// answer from a document the caller never saw: a private change set's
			// staged automations would be invisible to the executor that staged
			// them, and a canonical call would silently jump ahead of its own
			// working doc. Only the places stay external — they are rows, not
			// Blueprint.
			const doc = ctx.snapshot.doc;
			const organization = await readPlacesForGuidance(ctx);
			return {
				kind: "read",
				data: orderedAutomations(doc).map((automation) => ({
					automation,
					...setupGuideResult(doc, automation, organization.locations),
				})),
			};
		} catch (error) {
			return {
				kind: "read",
				data: { error: error instanceof Error ? error.message : String(error) },
			};
		}
	},
};

export const addAutomationsTool = {
	description:
		"Add one or more complete automatic case-update rules or conditional alerts to the app. Use Nova standard property names; case_type projects to HQ type, while case_id and case_type are read-only. The gate refuses status, standard-datetime equality/regex, every standard scalar in dynamic-only restart/event-time slots, and blank or padded HQ recipient IDs. Recipient filters require only user-account recipient kinds; every triggering case must contain a structurally referenced filter property. After trimming, case-property event-time values must begin with H:MM or HH:MM and be entirely parseable as a time; AM/PM and seconds are accepted, while blank, nonmatching, or unparseable values fall back to 12:00 PM. Host-scoped criteria, update targets, update sources, and message case-property parts are refused when an advanced case operation can add a second extension relationship to the automation case type. Every host-scoped reference also requires exactly one live extension at runtime; retained extra extension indices make the current-match count unavailable when a criterion reads the host, and HQ's host choice is undefined. Message case-property parts cannot use owner, host, or last_modified_by because CommCare HQ's formatter context shadows those names. Email body is plain-text (Rich text emails off) or rich-text HTML source (toggle on; HQ sanitizes it and derives plaintext). This records canonical Nova definitions and setup guidance; it does not install or run them in CommCare HQ.",
	inputSchema: addAutomationsInputSchema,
	async execute(
		input: z.infer<typeof addAutomationsInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AutomationMutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const existing = new Set<string>();
			for (const automation of input.automations) {
				for (const uuid of allIdentities(automation)) {
					if (
						existing.has(uuid) ||
						findAuthoredBlueprintIdentity(doc, uuid) !== undefined
					) {
						return mutationError(`UUID "${uuid}" is already in use.`);
					}
					existing.add(uuid);
				}
			}
			if (
				input.afterAutomationUuid !== undefined &&
				input.afterAutomationUuid !== null &&
				ownRecordValue(doc.automations, input.afterAutomationUuid) === undefined
			) {
				return mutationError(
					`Automation UUID "${input.afterAutomationUuid}" does not exist.`,
				);
			}
			const mutations: Mutation[] = [];
			let after = input.afterAutomationUuid;
			for (const automation of input.automations) {
				mutations.push({
					kind: "addAutomation",
					automation: structuredClone(automation),
					...(after === undefined ? {} : { after }),
				});
				after = automation.uuid;
			}
			// Guidance needs the external location catalog. Resolve it before the
			// authoritative write so no fallible read can turn a successful commit
			// into an error-shaped tool result and invite a duplicate retry.
			const organization = await readPlacesForGuidance(ctx);
			const commit = await guardedMutate(ctx, mutations, "automations", {
				expectedOrganizationRevision: organization.revision,
			});
			if (!commit.ok) return mutationError(commit.error);
			const names = input.automations.map((automation) => automation.name);
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message: `Added ${names.length} ${names.length === 1 ? "automation" : "automations"}: ${names.join(", ")}. Nova will not run them in Preview; use each generated guide to configure CommCare HQ manually.`,
					automationUuids: input.automations.map(
						(automation) => automation.uuid,
					),
					setupGuides: input.automations.map((automation) =>
						setupGuideResult(commit.newDoc, automation, organization.locations),
					),
					summary: { count: names.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const updateAutomationTool = {
	description:
		"Replace one existing automation with its complete desired canonical state. Use Nova standard property names and one plain-text or rich-text email body. Recipient filters require only user-account recipient kinds; every triggering case must contain a structurally referenced filter property. After trimming, case-property event-time values must begin with H:MM or HH:MM and be entirely parseable as a time; AM/PM and seconds are accepted, while blank, nonmatching, or unparseable values fall back to 12:00 PM. Host-scoped criteria, update targets, update sources, and message case-property parts are refused when an advanced case operation can add a second extension relationship to the automation case type. Every host-scoped reference also requires exactly one live extension at runtime; retained extra extension indices make the current-match count unavailable when a criterion reads the host, and HQ's host choice is undefined. Message case-property parts cannot use owner, host, or last_modified_by because CommCare HQ's formatter context shadows those names. The automation kind and UUID are create-once; nested UUIDs preserve identity across edits.",
	inputSchema: updateAutomationInputSchema,
	async execute(
		input: z.infer<typeof updateAutomationInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AutomationMutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const before = ownRecordValue(doc.automations, input.automation.uuid);
			if (before === undefined) {
				return mutationError(
					`Automation UUID "${input.automation.uuid}" does not exist.`,
				);
			}
			if (before.kind !== input.automation.kind) {
				return mutationError("An automation's kind cannot be changed.");
			}
			const next = produce(doc, (draft) => {
				if (draft.automations !== undefined) {
					draft.automations[input.automation.uuid] = structuredClone(
						input.automation,
					);
				}
			});
			const mutations = diffDocsToMutations(doc, next);
			if (mutations.length === 0) {
				if (ctx.snapshot.externalContextDigest !== undefined) {
					/* A private change-set overlay (the one snapshot field only that
					 * host sets). Its invocations are strictly serialized and it has
					 * no peers, so the overlay IS the current state of this change
					 * set: the snapshot itself proves the no-op, and there is no
					 * fresher authority to adopt — which is exactly why
					 * `adoptAuthoritativeSnapshot` is a protocol error here. */
					const organization = await readPlacesForGuidance(ctx);
					return {
						kind: "mutate",
						mutations: [],
						result: {
							message: `Automation "${before.name}" already has the requested settings.`,
							automationUuids: [before.uuid],
							setupGuides: [
								setupGuideResult(doc, before, organization.locations),
							],
							summary: { subject: before.name },
						},
					};
				}
				// A canonical invocation's closure may trail a peer. Prove the no-op
				// and derive guidance from one authoritative Blueprint-plus-
				// organization read; otherwise stale target state could be reported
				// as current.
				const authoring = await readOrganizationAuthoringSnapshot(scope(ctx));
				const persistedAutomation = ownRecordValue(
					authoring.blueprint.automations,
					input.automation.uuid,
				);
				/* The authoritative snapshot supersedes the invocation snapshot on
				 * BOTH branches — conflict and proven no-op alike — so the workspace
				 * continues from the state the proof actually read, never a stale
				 * closure. Adoption is the invocation's one workspace operation. */
				ctx.adoptAuthoritativeSnapshot({
					doc: authoring.blueprint,
					canonicalSeq: authoring.blueprintSeq,
				});
				if (
					persistedAutomation === undefined ||
					!deepEqual(persistedAutomation, input.automation)
				) {
					return mutationError(
						"This automation changed concurrently. Read automations again and retry from the current complete state.",
					);
				}
				return {
					kind: "mutate",
					mutations: [],
					result: {
						message: `Automation "${persistedAutomation.name}" already has the requested settings.`,
						automationUuids: [persistedAutomation.uuid],
						setupGuides: [
							setupGuideResult(
								authoring.blueprint,
								persistedAutomation,
								authoring.organization.locations,
							),
						],
						summary: { subject: persistedAutomation.name },
					},
				};
			}
			// Keep every fallible external projection before the write. The guide
			// is pure over this authorized snapshot plus the committed document.
			const organization = await readPlacesForGuidance(ctx);
			const commit = await guardedMutate(ctx, mutations, "automations", {
				expectedOrganizationRevision: organization.revision,
			});
			if (!commit.ok) return mutationError(commit.error);
			const committedAutomation = ownRecordValue(
				commit.newDoc.automations,
				input.automation.uuid,
			);
			if (committedAutomation === undefined) {
				return mutationError(
					"The automation changed concurrently and is no longer available.",
				);
			}
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message: `Updated automation "${committedAutomation.name}". Its setup guide has been regenerated; Nova will not execute it in Preview.`,
					automationUuids: [input.automation.uuid],
					setupGuides: [
						setupGuideResult(
							commit.newDoc,
							committedAutomation,
							organization.locations,
						),
					],
					summary: { subject: committedAutomation.name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};

export const removeAutomationTool = {
	description:
		"Remove one automation definition and its generated setup guidance from the app. This does not remove a rule already configured manually in CommCare HQ.",
	inputSchema: removeAutomationInputSchema,
	async execute(
		input: z.infer<typeof removeAutomationInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<AutomationMutationResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const automation = ownRecordValue(doc.automations, input.automationUuid);
			if (automation === undefined) {
				return mutationError(
					`Automation UUID "${input.automationUuid}" does not exist.`,
				);
			}
			const commit = await guardedMutate(
				ctx,
				[
					{
						kind: "removeAutomation",
						uuid: automation.uuid,
						targetKind: automation.kind,
					},
				],
				"automations",
			);
			if (!commit.ok) return mutationError(commit.error);
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message: `Removed automation "${automation.name}" from Nova. A copy configured manually in CommCare HQ is unchanged.`,
					automationUuids: [automation.uuid],
					summary: { subject: automation.name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
