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

export const getAutomationsInputSchema = z
	.object({
		automationUuid: uuidSchema
			.optional()
			.describe("One automation to inspect; omit to read all definitions."),
		includeSetupGuide: z
			.boolean()
			.optional()
			.describe(
				"Include this automation's manual CommCare HQ setup guide. Requires automationUuid.",
			),
	})
	.strict()
	.refine(
		(input) =>
			input.includeSetupGuide !== true || input.automationUuid !== undefined,
		{
			path: ["automationUuid"],
			message: "Choose one automation for its setup guide.",
		},
	);

export const addAutomationsInputSchema = z
	.object({
		automations: z
			.array(automationSchema)
			.min(1)
			.max(50)
			.describe(
				"Complete rules in display order. Use record-property names and one plain-text or HTML email body. Nova assigns omitted identities. The automation reference covers recipient filters, host relationships, and timing.",
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
			"Complete replacement for this automation. Preserve identities for retained rules and nested items; omitted items are removed.",
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
			setupRequired?: true;
			hqUpdated?: false;
			unchanged?: true;
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
		"Read automation definitions in display order, or one by automationUuid. Request includeSetupGuide for that rule when preparing manual CommCare HQ setup. Preview does not execute automations; matching counts are available in the Builder.",
	inputSchema: getAutomationsInputSchema,
	async execute(
		input: z.infer<typeof getAutomationsInputSchema>,
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
			const automations = orderedAutomations(doc).filter(
				(automation) =>
					input.automationUuid === undefined ||
					automation.uuid === input.automationUuid,
			);
			if (input.automationUuid !== undefined && automations.length === 0)
				return { kind: "read", data: { error: "Automation not found." } };
			const organization =
				input.includeSetupGuide === true
					? await readPlacesForGuidance(ctx)
					: undefined;
			return {
				kind: "read",
				data: automations.map((automation) => ({
					automation,
					executesInPreview: false,
					...(organization &&
						setupGuideResult(doc, automation, organization.locations)),
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
		"Add automatic record-update rules or conditional alerts. Saving here does not install or activate them in CommCare HQ. Read getAutomations with includeSetupGuide for an HQ handoff. Preview does not execute automations.",
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
			const commit = await guardedMutate(ctx, mutations, "automations");
			if (!commit.ok) return mutationError(commit.error);
			const names = input.automations.map((automation) => automation.name);
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					ok: true,
					automationUuids: input.automations.map(
						(automation) => automation.uuid,
					),
					setupRequired: true,
					hqUpdated: false,
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
		"Replace an automation with its complete desired state. Its identity and kind stay fixed; preserve identities of retained nested items. Read getAutomations with includeSetupGuide for the current HQ setup guide.",
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
				if (ctx.snapshot.mode === "change-set") {
					// Private invocations are serialized. Their current candidate
					// proves the no-op; no canonical app need exist yet.
					return {
						kind: "mutate",
						mutations: [],
						result: {
							ok: true,
							automationUuids: [before.uuid],
							setupRequired: true,
							hqUpdated: false,
							unchanged: true,
							summary: { subject: before.name, noop: true },
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
						ok: true,
						automationUuids: [persistedAutomation.uuid],
						setupRequired: true,
						hqUpdated: false,
						unchanged: true,
						summary: { subject: persistedAutomation.name, noop: true },
					},
				};
			}
			const commit = await guardedMutate(ctx, mutations, "automations");
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
					ok: true,
					automationUuids: [input.automation.uuid],
					setupRequired: true,
					hqUpdated: false,
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
					ok: true,
					automationUuids: [automation.uuid],
					hqUpdated: false,
					summary: { subject: automation.name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
