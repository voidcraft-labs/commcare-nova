import { produce } from "immer";
import { z } from "zod";
import { automationMatchProjection } from "@/lib/automations/matching";
import { buildAutomationSetupGuide } from "@/lib/automations/setupGuidance";
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
	StoredLocation,
} from "@/lib/organization/types";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	type ReadToolResult,
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
				"Complete automation definitions in display order. Every automation and nested collection item uses a stable UUID. Use Nova case-property names. Email content carries exactly one plain-text or rich-text body, never parallel bodies.",
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
			"Complete desired state of one existing automation. Preserve every UUID that still names the same rule or nested item; omitted nested items are removed. Use Nova case-property names and one email body form.",
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

function scope(ctx: ToolExecutionContext): OrganizationScope {
	return {
		appId: ctx.appId,
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

function setupGuideResult(
	doc: BlueprintDoc,
	automation: z.infer<typeof automationSchema>,
	locations: readonly StoredLocation[],
): SetupGuideResult {
	return {
		automationUuid: automation.uuid,
		setupGuide: buildAutomationSetupGuide(doc, automation, locations),
		omittedCriteria: automationMatchProjection(doc, automation).omittedCriteria,
		executesInPreview: false,
	};
}

function mutationError(
	doc: BlueprintDoc,
	error: string,
): MutatingToolResult<{ error: string }> {
	return {
		kind: "mutate",
		mutations: [],
		newDoc: doc,
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
		"Read every representable automatic case-update rule and conditional alert in display order, with stable UUIDs and freshly derived manual CommCare HQ setup guidance. Nova describes and locally counts matching cases but never executes these automations.",
	inputSchema: getAutomationsInputSchema,
	async execute(
		_input: z.infer<typeof getAutomationsInputSchema>,
		ctx: ToolExecutionContext,
		_doc: BlueprintDoc,
	): Promise<ReadToolResult<unknown>> {
		try {
			const authoring = await readOrganizationAuthoringSnapshot(scope(ctx));
			return {
				kind: "read",
				data: orderedAutomations(authoring.blueprint).map((automation) => ({
					automation,
					...setupGuideResult(
						authoring.blueprint,
						automation,
						authoring.organization.locations,
					),
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
		"Add one or more complete automatic case-update rules or conditional alerts to the app. Use Nova standard property names; the gate refuses status, standard-datetime equality/regex, and standard properties in dynamic-only restart/event-time slots. Email body is plain-text (Rich text emails off) or rich-text HTML source (toggle on; HQ sanitizes it and derives plaintext). This records canonical Nova definitions and setup guidance; it does not install or run them in CommCare HQ.",
	inputSchema: addAutomationsInputSchema,
	async execute(
		input: z.infer<typeof addAutomationsInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AutomationMutationResult>> {
		try {
			const existing = new Set<string>();
			for (const automation of input.automations) {
				for (const uuid of allIdentities(automation)) {
					if (
						existing.has(uuid) ||
						findAuthoredBlueprintIdentity(doc, uuid) !== undefined
					) {
						return mutationError(doc, `UUID "${uuid}" is already in use.`);
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
					doc,
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
			const commit = await guardedMutate(ctx, doc, mutations, "automations");
			if (!commit.ok) return mutationError(doc, commit.error);
			const locations = (await readOrganization(scope(ctx))).locations;
			const names = input.automations.map((automation) => automation.name);
			return {
				kind: "mutate",
				mutations: commit.mutations,
				newDoc: commit.newDoc,
				result: {
					message: `Added ${names.length} ${names.length === 1 ? "automation" : "automations"}: ${names.join(", ")}. Nova will not run them in Preview; use each generated guide to configure CommCare HQ manually.`,
					automationUuids: input.automations.map(
						(automation) => automation.uuid,
					),
					setupGuides: input.automations.map((automation) =>
						setupGuideResult(commit.newDoc, automation, locations),
					),
					summary: { count: names.length },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const updateAutomationTool = {
	description:
		"Replace one existing automation with its complete desired canonical state. Use Nova standard property names and one plain-text or rich-text email body. The automation kind and UUID are create-once; nested UUIDs preserve identity across edits.",
	inputSchema: updateAutomationInputSchema,
	async execute(
		input: z.infer<typeof updateAutomationInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AutomationMutationResult>> {
		try {
			const before = ownRecordValue(doc.automations, input.automation.uuid);
			if (before === undefined) {
				return mutationError(
					doc,
					`Automation UUID "${input.automation.uuid}" does not exist.`,
				);
			}
			if (before.kind !== input.automation.kind) {
				return mutationError(doc, "An automation's kind cannot be changed.");
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
				const locations = (await readOrganization(scope(ctx))).locations;
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						message: `Automation "${before.name}" already has the requested settings.`,
						automationUuids: [before.uuid],
						setupGuides: [setupGuideResult(doc, before, locations)],
						summary: { subject: before.name },
					},
				};
			}
			const commit = await guardedMutate(ctx, doc, mutations, "automations");
			if (!commit.ok) return mutationError(doc, commit.error);
			const committedAutomation = ownRecordValue(
				commit.newDoc.automations,
				input.automation.uuid,
			);
			if (committedAutomation === undefined) {
				return mutationError(
					commit.newDoc,
					"The automation changed concurrently and is no longer available.",
				);
			}
			const locations = (await readOrganization(scope(ctx))).locations;
			return {
				kind: "mutate",
				mutations: commit.mutations,
				newDoc: commit.newDoc,
				result: {
					message: `Updated automation "${committedAutomation.name}". Its setup guide has been regenerated; Nova will not execute it in Preview.`,
					automationUuids: [input.automation.uuid],
					setupGuides: [
						setupGuideResult(commit.newDoc, committedAutomation, locations),
					],
					summary: { subject: committedAutomation.name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};

export const removeAutomationTool = {
	description:
		"Remove one automation definition and its generated setup guidance from the app. This does not remove a rule already configured manually in CommCare HQ.",
	inputSchema: removeAutomationInputSchema,
	async execute(
		input: z.infer<typeof removeAutomationInputSchema>,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AutomationMutationResult>> {
		try {
			const automation = ownRecordValue(doc.automations, input.automationUuid);
			if (automation === undefined) {
				return mutationError(
					doc,
					`Automation UUID "${input.automationUuid}" does not exist.`,
				);
			}
			const commit = await guardedMutate(
				ctx,
				doc,
				[{ kind: "removeAutomation", uuid: automation.uuid }],
				"automations",
			);
			if (!commit.ok) return mutationError(doc, commit.error);
			return {
				kind: "mutate",
				mutations: commit.mutations,
				newDoc: commit.newDoc,
				result: {
					message: `Removed automation "${automation.name}" from Nova. A copy configured manually in CommCare HQ is unchanged.`,
					automationUuids: [automation.uuid],
					summary: { subject: automation.name },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};
