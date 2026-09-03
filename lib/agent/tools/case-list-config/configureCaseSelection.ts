import { z } from "zod";
import {
	type CaseSelectionTransition,
	type CaseSelectionTransitionBlocker,
	type CaseSelectionTransitionReason,
	planCaseSelectionTransition,
} from "@/lib/doc/caseSelectionMutations";
import {
	type CaseSelection,
	caseSelectionSchema,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { ToolInvocationContext } from "../../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "../shared/entityAddresses";
import type { ToolCallSummary } from "../shared/toolCallSummary";

export const configureCaseSelectionInputSchema = moduleAddressSchema
	.extend({
		selection: caseSelectionSchema
			.nullable()
			.describe(
				'How workers choose cases from Results. Pass `{ kind: "multiple", maximum: N }` to let them choose a bounded set before continuing, where N is an integer from 1 through 100. Pass null to return to opening one case at a time.',
			),
		confirmedModuleUuids: z
			.array(uuidSchema)
			.min(1)
			.optional()
			.describe(
				"Approval to update the other modules needed by this selection change in the same atomic batch. Omit on the first call. If the result needs confirmation, repeat the request with exactly requiredConfirmedModuleUuids from that result and its confirmationToken. Never guess or reuse confirmation values from an older result.",
			),
		confirmationToken: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional()
			.describe(
				"Opaque proof of the exact coordinated effects previously returned for review. Omit on the first call. On confirmation, pass the result's confirmationToken unchanged together with its exact requiredConfirmedModuleUuids.",
			),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (
			(input.confirmedModuleUuids === undefined) !==
			(input.confirmationToken === undefined)
		) {
			ctx.addIssue({
				code: "custom",
				path:
					input.confirmedModuleUuids === undefined
						? ["confirmedModuleUuids"]
						: ["confirmationToken"],
				message:
					"confirmedModuleUuids and confirmationToken must be passed together from the same needs_changes result.",
			});
		}
	});

export type ConfigureCaseSelectionInput = z.infer<
	typeof configureCaseSelectionInputSchema
>;

export interface CaseSelectionTransitionResult {
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly selection: CaseSelection | null;
	readonly clearedPersistentTile: boolean;
	readonly reasons: readonly CaseSelectionTransitionReason[];
}

export interface ConfigureCaseSelectionSuccess {
	readonly outcome: "applied" | "unchanged";
	readonly message: string;
	readonly selection: CaseSelection | null;
	readonly clearedPersistentTile: boolean;
	readonly transitions: readonly CaseSelectionTransitionResult[];
	readonly summary: ToolCallSummary;
}

export interface ConfigureCaseSelectionNeedsConfirmation {
	readonly outcome: "needs_changes";
	readonly needs: "confirmation";
	readonly message: string;
	readonly selection: CaseSelection | null;
	readonly requiredConfirmedModuleUuids: readonly Uuid[];
	readonly confirmationToken: string;
	readonly coordinatedChanges: readonly CaseSelectionTransitionResult[];
	readonly clearedPersistentTile: boolean;
	readonly blockers: readonly [];
	readonly summary: ToolCallSummary;
}

export interface ConfigureCaseSelectionNeedsRepair {
	readonly outcome: "needs_changes";
	readonly needs: "repair";
	readonly message: string;
	readonly selection: CaseSelection | null;
	readonly requiredConfirmedModuleUuids: readonly [];
	readonly confirmationToken: null;
	readonly coordinatedChanges: readonly [];
	readonly blockers: readonly CaseSelectionTransitionBlocker[];
	readonly summary: ToolCallSummary;
}

export interface ConfigureCaseSelectionNeedsRefresh {
	readonly outcome: "needs_changes";
	readonly needs: "refresh";
	readonly message: string;
	readonly selection: CaseSelection | null;
	readonly requiredConfirmedModuleUuids: readonly [];
	readonly confirmationToken: null;
	readonly coordinatedChanges: readonly [];
	readonly blockers: readonly [];
	readonly summary: ToolCallSummary;
}

export type ConfigureCaseSelectionResult =
	| ConfigureCaseSelectionSuccess
	| ConfigureCaseSelectionNeedsConfirmation
	| ConfigureCaseSelectionNeedsRepair
	| ConfigureCaseSelectionNeedsRefresh
	| { readonly outcome: "unavailable"; readonly error: string };

function transitionResult(
	transition: CaseSelectionTransition,
): CaseSelectionTransitionResult {
	return {
		moduleUuid: transition.moduleUuid,
		moduleName: transition.moduleName,
		selection: transition.selection ?? null,
		clearedPersistentTile: transition.clearsPersistentTile,
		reasons: transition.reasons,
	};
}

function confirmationTokenFor(
	moduleUuid: Uuid,
	selection: CaseSelection | null,
	transitions: readonly CaseSelectionTransition[],
): string {
	return canonicalJsonDigest({
		moduleUuid,
		selection,
		transitions: transitions.map(transitionResult),
	});
}

function needsConfirmationResult(args: {
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly selection: CaseSelection | null;
	readonly transitions: readonly CaseSelectionTransition[];
}): MutatingToolResult<ConfigureCaseSelectionResult> {
	const sourceChange = args.transitions.find(
		(transition) => transition.moduleUuid === args.moduleUuid,
	);
	const coordinatedChanges = args.transitions
		.filter((transition) => transition.moduleUuid !== args.moduleUuid)
		.map(transitionResult);
	const names = coordinatedChanges
		.map((transition) => `"${transition.moduleName}"`)
		.join(", ");
	const tileMessage = sourceChange?.clearsPersistentTile
		? " The source module's Results tile will also stop staying above forms; its layout and grouping remain unchanged."
		: "";
	return {
		kind: "mutate",
		mutations: [],
		result: {
			outcome: "needs_changes",
			needs: "confirmation",
			message: `Changing case selection for module "${args.moduleName}" also changes ${coordinatedChanges.length === 1 ? "module" : "modules"} ${names} so linked workflows remain compatible.${tileMessage} No changes were applied. Repeat this request with confirmedModuleUuids exactly matching requiredConfirmedModuleUuids and pass confirmationToken unchanged to apply the reviewed change atomically.`,
			selection: args.selection,
			requiredConfirmedModuleUuids: coordinatedChanges.map(
				(transition) => transition.moduleUuid,
			),
			confirmationToken: confirmationTokenFor(
				args.moduleUuid,
				args.selection,
				args.transitions,
			),
			coordinatedChanges,
			clearedPersistentTile: sourceChange?.clearsPersistentTile ?? false,
			blockers: [],
			summary: { location: args.moduleName },
		},
	};
}

export const configureCaseSelectionTool = {
	description:
		"Choose whether a module opens one case at a time or lets workers select a bounded set of cases before continuing. Multiple selection accepts an integer maximum from 1 through 100. null returns to one-case selection. Linked workflows may require coordinated selection changes. The first call either returns needs_changes with exact module confirmations and an effect-bound confirmation token for an atomic retry, or UUID-located blockers to repair; it applies no mutations in either case. If the reviewed effects change before retry, the stale confirmation applies nothing and returns a fresh review. If a case tile was configured to stay above forms, enabling multiple selection removes only that incompatible presentation setting and keeps the tile layout and grouping.",
	inputSchema: configureCaseSelectionInputSchema,
	async execute(
		input: ConfigureCaseSelectionInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<ConfigureCaseSelectionResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const address = resolveModuleAddress(doc, input);
			if (!address.ok) return errorResult(address.error);
			const { moduleUuid, module: mod } = address;
			const selection = input.selection ?? undefined;
			let plan = planCaseSelectionTransition(doc, {
				sourceModuleUuid: moduleUuid,
				selection,
				...(input.confirmedModuleUuids !== undefined && {
					confirmedModuleUuids: input.confirmedModuleUuids,
				}),
			});
			let staleConfirmation = false;
			if (
				plan.kind === "unavailable" &&
				plan.reason === "not-coordinated-module" &&
				input.confirmationToken !== undefined
			) {
				plan = planCaseSelectionTransition(doc, {
					sourceModuleUuid: moduleUuid,
					selection,
				});
				staleConfirmation = true;
			}
			if (plan.kind === "unavailable") {
				return errorResult(unavailableMessage(mod.name, moduleUuid, plan));
			}
			if (plan.kind === "needs-coordination") {
				const confirmedPlan = planCaseSelectionTransition(doc, {
					sourceModuleUuid: moduleUuid,
					selection,
					confirmedModuleUuids: plan.transitions.map(
						(transition) => transition.moduleUuid,
					),
				});
				if (confirmedPlan.kind !== "ready") {
					return errorResult(
						"Nova couldn't prepare the complete linked workflow review. Read the current app and try this selection change again.",
					);
				}
				return needsConfirmationResult({
					moduleUuid,
					moduleName: mod.name,
					selection: input.selection,
					transitions: confirmedPlan.transitions,
				});
			}
			if (plan.kind === "blocked") {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						outcome: "needs_changes",
						needs: "repair",
						message: `Case selection for module "${mod.name}" cannot change until ${plan.blockers.length === 1 ? "one linked workflow issue is" : `${plan.blockers.length} linked workflow issues are`} fixed. No changes were applied. Repair the UUID-located blockers, then call this tool again without confirmedModuleUuids for a fresh plan.`,
						selection: input.selection,
						requiredConfirmedModuleUuids: [],
						confirmationToken: null,
						coordinatedChanges: [],
						blockers: plan.blockers,
						summary: { location: mod.name },
					},
				};
			}
			if (staleConfirmation) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						outcome: "needs_changes",
						needs: "refresh",
						message: `The linked workflow changed after the earlier review for module "${mod.name}". No changes were applied. Call this tool again without confirmedModuleUuids or confirmationToken to review the current effect.`,
						selection: input.selection,
						requiredConfirmedModuleUuids: [],
						confirmationToken: null,
						coordinatedChanges: [],
						blockers: [],
						summary: { location: mod.name },
					},
				};
			}
			if (
				input.confirmationToken !== undefined &&
				input.confirmationToken !==
					confirmationTokenFor(moduleUuid, input.selection, plan.transitions)
			) {
				return needsConfirmationResult({
					moduleUuid,
					moduleName: mod.name,
					selection: input.selection,
					transitions: plan.transitions,
				});
			}

			const commit =
				plan.mutations.length === 0
					? { ok: true as const, mutations: plan.mutations }
					: await guardedMutate(
							ctx,
							plan.mutations,
							`module:${moduleUuid}:caseList:selection`,
						);
			if (!commit.ok) return errorResult(commit.error);

			const selectionMessage =
				selection === undefined
					? `Set module "${mod.name}" (${moduleUuid}) to open one case at a time.`
					: `Set module "${mod.name}" (${moduleUuid}) to let workers select up to ${selection.maximum} ${selection.maximum === 1 ? "case" : "cases"} before continuing.`;
			const sourceTransition = plan.transitions.find(
				(transition) => transition.moduleUuid === moduleUuid,
			);
			const tileMessage = sourceTransition?.clearsPersistentTile
				? " The case tile will no longer stay above forms because that placement works only when a form opens one case. Its Results layout and grouping are unchanged."
				: "";
			const linkedTransitions = plan.transitions.filter(
				(transition) => transition.moduleUuid !== moduleUuid,
			);
			const linkedMessage =
				linkedTransitions.length === 0
					? ""
					: ` Also updated ${linkedTransitions.length === 1 ? "linked module" : "linked modules"} ${linkedTransitions.map((transition) => `"${transition.moduleName}"`).join(", ")} so the complete selection can continue through the linked workflow.`;
			const outcome = commit.mutations.length === 0 ? "unchanged" : "applied";

			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					outcome,
					message:
						outcome === "unchanged"
							? `Module "${mod.name}" (${moduleUuid}) already uses that case selection.`
							: `${selectionMessage}${linkedMessage}${tileMessage}`,
					selection: input.selection,
					clearedPersistentTile:
						sourceTransition?.clearsPersistentTile ?? false,
					transitions: plan.transitions.map((transition) => ({
						moduleUuid: transition.moduleUuid,
						moduleName: transition.moduleName,
						selection: transition.selection ?? null,
						clearedPersistentTile: transition.clearsPersistentTile,
						reasons: transition.reasons,
					})),
					summary: { location: mod.name },
				},
			};
		} catch (error) {
			const caught = toToolErrorResult(error);
			return {
				...caught,
				result: { outcome: "unavailable", error: caught.result.error },
			};
		}
	},
};

function errorResult(
	error: string,
): MutatingToolResult<ConfigureCaseSelectionResult> {
	return {
		kind: "mutate",
		mutations: [],
		result: { outcome: "unavailable", error },
	};
}

function unavailableMessage(
	moduleName: string,
	moduleUuid: Uuid,
	plan: Extract<
		ReturnType<typeof planCaseSelectionTransition>,
		{ kind: "unavailable" }
	>,
): string {
	if (plan.reason === "missing-case-list") {
		return `Tried to change case selection on module "${moduleName}" (${moduleUuid}), but that module has no case list. Add its Results fields first, then choose how workers select cases.`;
	}
	if (plan.reason === "not-coordinated-module") {
		return `Module ${plan.moduleUuid} is not one of the coordinated changes required by the current app. Call this tool again without confirmedModuleUuids to receive a fresh exact list.`;
	}
	if (plan.reason === "duplicate-module") {
		return `confirmedModuleUuids must contain each required coordinated module exactly once and must not include the source module. Module ${plan.moduleUuid} does not satisfy that requirement.`;
	}
	return `Module ${plan.moduleUuid} is no longer available. Read the current app and retry with its current module UUID.`;
}
