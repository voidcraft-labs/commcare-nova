import { z } from "zod";
import {
	type ConnectTargetParticipant,
	type ConnectTargetState,
	planConnectTargetState,
} from "@/lib/doc/connectTargetState";
import {
	type BlueprintDoc,
	type ConnectConfig,
	type ConnectType,
	uuidSchema,
} from "@/lib/domain";
import { connectFormConfigSchema } from "../planningSchemas";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	connectIdsInConfig,
	enforceConnectIds,
	reserveExplicitConnectIds,
} from "./shared/connectIds";
import { buildConnectConfig } from "./shared/connectInput";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

const participantSchema = z
	.object({
		formUuid: uuidSchema.describe(
			"The stable UUID of a form that participates in this complete target state.",
		),
		connect: connectFormConfigSchema.describe(
			"The form's complete mode-compatible Connect configuration. Omit an id to have Nova derive it once; an explicit id is kept or rejected, never rewritten.",
		),
	})
	.strict();

const participantsSchema = z
	.array(participantSchema)
	.min(1, "A Connect mode requires at least one participating form.")
	.superRefine((participants, ctx) => {
		const seen = new Set<string>();
		participants.forEach((participant, index) => {
			if (seen.has(participant.formUuid)) {
				ctx.addIssue({
					code: "custom",
					path: [index, "formUuid"],
					message:
						"Each form may appear only once in the complete participant set.",
				});
			}
			seen.add(participant.formUuid);
		});
	});

export const configureConnectInputSchema = z
	.object({
		mode: z
			.enum(["learn", "deliver"])
			.nullable()
			.describe(
				'The exact target mode. "learn" and "deliver" require participants; null turns Connect off and clears every form block.',
			),
		participants: participantsSchema
			.optional()
			.describe(
				"The complete set of participating forms for a non-null mode. Every unlisted form becomes auxiliary and has any old Connect block cleared. Omit when mode is null.",
			),
	})
	.strict()
	.superRefine((target, ctx) => {
		if (target.mode === null && target.participants !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["participants"],
				message: "Omit participants when mode is null.",
			});
		}
		if (target.mode !== null && target.participants === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["participants"],
				message:
					"A non-null Connect mode requires the complete nonempty participant set.",
			});
		}
	});

export type ConfigureConnectInput = z.infer<typeof configureConnectInputSchema>;
export type ConfigureConnectResult = MutationSuccess | { error: string };

interface ResolvedForm {
	readonly formUuid: string;
	readonly formName: string;
	readonly moduleName: string;
}

function formInventory(doc: BlueprintDoc): Map<string, ResolvedForm> {
	const inventory = new Map<string, ResolvedForm>();
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (!module) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!form) continue;
			inventory.set(formUuid, {
				formUuid,
				formName: form.name,
				moduleName: module.name,
			});
		}
	}
	return inventory;
}

function prepareParticipants(
	doc: BlueprintDoc,
	mode: ConnectType,
	input: readonly z.infer<typeof participantSchema>[],
):
	| {
			readonly ok: true;
			readonly participants: readonly ConnectTargetParticipant[];
			readonly labels: readonly string[];
	  }
	| { readonly ok: false; readonly error: string } {
	const forms = formInventory(doc);
	const errors: string[] = [];
	const requestedByForm = new Map<string, z.infer<typeof participantSchema>>();

	// Resolve every identity and mode family before projecting or finalizing
	// even one id. The schema has already rejected duplicate form UUIDs.
	for (const participant of input) {
		const resolved = forms.get(participant.formUuid);
		if (!resolved) {
			errors.push(
				`Form UUID "${participant.formUuid}" is not a form in this app.`,
			);
			continue;
		}
		const hasLearn =
			participant.connect.learn_module != null ||
			participant.connect.assessment != null;
		const hasDeliver =
			participant.connect.deliver_unit != null ||
			participant.connect.task != null;
		if (
			(mode === "learn" && (!hasLearn || hasDeliver)) ||
			(mode === "deliver" && (!hasDeliver || hasLearn))
		) {
			errors.push(
				`Form "${resolved.formName}" must contain only ${mode}-mode Connect blocks and at least one such block.`,
			);
		}
		requestedByForm.set(participant.formUuid, participant);
	}
	if (errors.length > 0) return { ok: false, error: errors.join(" ") };

	// Project the exact target in canonical document order. Existing content is
	// not merged, but the current same-form/same-kind id is an identity source:
	// omitting that id during a complete reconfiguration preserves it.
	const candidates: Array<{
		readonly resolved: ResolvedForm;
		readonly draft: ReturnType<typeof buildConnectConfig>;
	}> = [];
	for (const resolved of forms.values()) {
		const participant = requestedByForm.get(resolved.formUuid);
		if (!participant) continue;
		candidates.push({
			resolved,
			draft: buildConnectConfig(
				participant.connect,
				undefined,
				doc.forms[resolved.formUuid]?.connect,
			),
		});
	}

	// Reserve every explicit or already-established target identity before one
	// genuinely new omission derives. Thus a caller's array order can neither
	// steal an explicit spelling nor change the deterministic suffixes.
	const taken = new Set<string>();
	for (const { resolved, draft } of candidates) {
		for (const error of reserveExplicitConnectIds(draft, taken)) {
			errors.push(`${resolved.formName}: Connect ${error}`);
		}
	}
	if (errors.length > 0) return { ok: false, error: errors.join(" ") };

	const participants: ConnectTargetParticipant[] = [];
	const labels: string[] = [];
	for (const { resolved, draft } of candidates) {
		// The target-wide reservation includes this candidate's own identities.
		// Exclude them while its local finalizer validates the same values; every
		// other target identity remains protected from derived collisions.
		const localTaken = new Set(taken);
		for (const id of connectIdsInConfig(draft)) {
			localTaken.delete(id);
		}
		const enforced = enforceConnectIds(
			draft,
			mode,
			resolved.moduleName,
			resolved.formName,
			localTaken,
		);
		if (!enforced.ok) {
			errors.push(`${resolved.formName}: ${enforced.error}`);
			continue;
		}
		participants.push({
			formUuid: resolved.formUuid,
			connect: enforced.config as ConnectConfig,
		});
		labels.push(`"${resolved.formName}" (${resolved.formUuid})`);
		for (const id of connectIdsInConfig(enforced.config)) {
			taken.add(id);
		}
	}
	return errors.length > 0
		? { ok: false, error: errors.join(" ") }
		: { ok: true, participants, labels };
}

export const configureConnectTool = {
	description:
		"Set the app's complete CommCare Connect target state atomically. mode null turns Connect off and clears all form blocks; learn/deliver requires the complete nonempty UUID-addressed participant set, and every unlisted form becomes auxiliary.",
	inputSchema: configureConnectInputSchema,
	async execute(
		input: ConfigureConnectInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<ConfigureConnectResult>> {
		const doc = ctx.snapshot.doc;
		try {
			let labels: readonly string[] = [];
			let target: ConnectTargetState = { mode: null };
			if (input.mode !== null) {
				if (input.participants === undefined) {
					throw new Error(
						"configureConnect schema admitted a mode without participants.",
					);
				}
				const prepared = prepareParticipants(
					doc,
					input.mode,
					input.participants,
				);
				if (!prepared.ok) {
					return {
						kind: "mutate",
						mutations: [],
						result: { error: prepared.error },
					};
				}
				labels = prepared.labels;
				target = {
					mode: input.mode,
					participants: prepared.participants,
				};
			}
			const planned = planConnectTargetState(doc, target);
			if (!planned.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: planned.messages.join(" ") },
				};
			}
			if (planned.mutations.length === 0) {
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error:
							input.mode === null
								? "CommCare Connect is already off. mode null only clears an existing Connect target; it does not configure case lists or ordinary forms. Continue without retrying this call."
								: `CommCare Connect already matches this complete ${input.mode} target. This call would make no edit; continue without retrying it.`,
					},
				};
			}
			const commit = await guardedMutate(ctx, planned.mutations, "app");
			if (!commit.ok) {
				return {
					kind: "mutate",
					mutations: [],
					result: { error: commit.error },
				};
			}
			const summary: ToolCallSummary = {
				connect: input.mode ?? "off",
				...(input.mode === null ? {} : { count: labels.length }),
			};
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					message:
						input.mode === null
							? "CommCare Connect is off. Every form Connect block was cleared."
							: `CommCare Connect is now ${input.mode}. Complete participant set: ${labels.join(", ")}. Every unlisted form is auxiliary.`,
					summary,
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
