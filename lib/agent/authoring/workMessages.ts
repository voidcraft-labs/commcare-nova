import type { ModelMessage } from "ai";
import type { getWork } from "./session";

/** One volatile, private-state tail across ordinary editing and retries. */
export function buildWorkStateMessage(
	work: Awaited<ReturnType<typeof getWork>>,
	interrupted = false,
): ModelMessage {
	return {
		role: "user",
		content:
			(interrupted
				? "The previous attempt was interrupted. Continue from the preserved private work below, inspect what remains, and save a valid checkpoint before reporting completion.\n"
				: "Current private work (saved app stays unchanged until saveWork):\n") +
			JSON.stringify(work),
	};
}
