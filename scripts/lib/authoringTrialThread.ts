import { persistResponseSnapshot } from "@/lib/db/threads";

/** Retire the stream marker while preserving an ordinary paused continuation. */
export async function persistArchitectTrialResponse(
	args: Omit<
		Parameters<typeof persistResponseSnapshot>[0],
		"clearMarker" | "retainHolderNonce"
	> & { paused: boolean },
) {
	const { paused, ...snapshot } = args;
	await persistResponseSnapshot({
		...snapshot,
		clearMarker: true,
		retainHolderNonce: paused,
	});
}
