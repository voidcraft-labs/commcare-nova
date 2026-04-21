/**
 * Event log replay dispatchers. `replayEvents` (async + paced + abortable)
 * for demo playback; `replayEventsSync` for scrub/hydrate where the cursor
 * commit is adjacent. Chapter derivation lives in `./replayChapters`.
 */
import type { Mutation } from "@/lib/doc/types";
import type { ConversationPayload, Event } from "./types";

// Signal-aware sleep — resolves (not rejects) on abort so the replay
// loop's `signal?.aborted` check is the single abort-handling path.
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

export async function replayEvents(
	events: readonly Event[],
	onMutation: (m: Mutation) => void,
	onConversation: (p: ConversationPayload) => void,
	delayPerEvent = 150,
	signal?: AbortSignal,
): Promise<void> {
	for (const e of events) {
		if (signal?.aborted) return;
		if (e.kind === "mutation") onMutation(e.mutation);
		else onConversation(e.payload);
		if (delayPerEvent > 0) await sleep(delayPerEvent, signal);
	}
}

export function replayEventsSync(
	events: readonly Event[],
	onMutation: (m: Mutation) => void,
	onConversation: (p: ConversationPayload) => void,
): void {
	for (const e of events) {
		if (e.kind === "mutation") onMutation(e.mutation);
		else onConversation(e.payload);
	}
}
