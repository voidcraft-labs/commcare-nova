/**
 * Ambient open/close policy for a reasoning block. The rule that overrides
 * everything: once the USER has toggled the block, the automation never moves
 * it again. A block someone opened to read must not close itself under them
 * when the stream moves on, and one they closed must not spring back open.
 * Untouched blocks keep the ambient lifecycle: open while their reasoning
 * streams, then close shortly after it ends (once).
 */
export function reasoningAutoBehavior(args: {
	isStreaming: boolean;
	isOpen: boolean;
	userToggled: boolean;
	explicitlyClosed: boolean;
	hasAutoClosed: boolean;
	everStreamed: boolean;
}): "open" | "scheduleClose" | "none" {
	if (args.userToggled) return "none";
	if (args.isStreaming) {
		return !args.isOpen && !args.explicitlyClosed ? "open" : "none";
	}
	return args.everStreamed && args.isOpen && !args.hasAutoClosed
		? "scheduleClose"
		: "none";
}

/** Compact elapsed time for the reasoning trigger. Long model turns are easier
 * to scan as clock-like units than as a large count of seconds. */
export function formatThinkingDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return remainingSeconds === 0
			? `${minutes}m`
			: `${minutes}m ${remainingSeconds}s`;
	}

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0
		? `${hours}h`
		: `${hours}h ${remainingMinutes}m`;
}
