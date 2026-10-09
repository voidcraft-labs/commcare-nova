import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { setAwaitingInput } from "@/lib/db/apps";
import { RunHolderLostError } from "@/lib/db/commitGuard";
import { setDesignSessionAwaitingInput } from "@/lib/db/designSessions";
import type { GenerationTarget } from "@/lib/db/generationTargets";
import { persistResponseSnapshot } from "@/lib/db/threads";
import { type InputRound, inputRoundSchema } from "./inputRound";

export type InputPause = {
	kind: "questions" | "message" | "review";
	origin: string;
	toolCallIds: string[];
};

/** The one terminal pause commit shared by HTTP and evaluation callers. */
export async function commitThreadInputPause(args: {
	target: GenerationTarget;
	holderTarget: GenerationTarget;
	threadId: string;
	streamId: string;
	runId: string;
	holderNonce: string;
	mode: "build" | "edit";
	actorUserId: string;
	expectedProjectId: string;
	responseMessage: UIMessage;
	pause: InputPause;
	commitState?: (
		tx: import("kysely").Transaction<import("@/lib/db/pg").AppDatabase>,
	) => Promise<void>;
}): Promise<InputRound> {
	if (args.pause.kind === "questions" && args.pause.toolCallIds.length === 0)
		throw new Error("A question pause requires pending questions");
	const round: InputRound = {
		id: createHash("sha256")
			.update(
				JSON.stringify([args.threadId, args.pause.kind, args.pause.origin]),
			)
			.digest("hex"),
		kind: args.pause.kind,
		assistantMessageId: args.responseMessage.id,
		toolCallIds: args.pause.toolCallIds,
		state: "pending",
		acceptedStreamId: null,
	};
	let committedRound = round;
	const persist = async (
		tx: import("kysely").Transaction<import("@/lib/db/pg").AppDatabase>,
	) => {
		const existing = await tx
			.selectFrom("threads")
			.select([
				"input_round",
				"active_stream_id",
				"active_holder_nonce",
				"app_id",
				"design_session_id",
			])
			.where("thread_id", "=", args.threadId)
			.executeTakeFirst();
		const sameTarget =
			args.target.kind === "app"
				? existing?.app_id === args.target.appId
				: existing?.design_session_id === args.target.designSessionId;
		if (
			sameTarget &&
			existing?.active_stream_id === null &&
			existing.active_holder_nonce === args.holderNonce &&
			existing.input_round?.id === round.id &&
			existing.input_round.state === "pending"
		) {
			committedRound = inputRoundSchema.parse(existing.input_round);
			return false as const;
		}
		await args.commitState?.(tx);
		await persistResponseSnapshot(
			{
				target: args.target,
				threadId: args.threadId,
				streamId: args.streamId,
				expectedProjectId: args.expectedProjectId,
				responseMessage: args.responseMessage,
				clearMarker: true,
				retainHolderNonce: true,
				inputRound: round,
			},
			tx,
		);
		return true;
	};
	const outcome =
		args.holderTarget.kind === "design-session"
			? await setDesignSessionAwaitingInput(
					args.holderTarget.designSessionId,
					args.runId,
					args.holderNonce,
					true,
					args.actorUserId,
					args.expectedProjectId,
					persist,
				)
			: await setAwaitingInput(
					args.holderTarget.appId,
					args.runId,
					args.holderNonce,
					args.mode,
					true,
					args.actorUserId,
					args.expectedProjectId,
					persist,
				);
	if (outcome !== "owned") throw new RunHolderLostError(outcome);
	return committedRound;
}
