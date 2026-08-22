/** Keep the paid design preview's input-terminal arbitration identical to the
 * production stream arbiter. The shared execution queue makes a successful
 * wait conclusive: every provider-later question lost. Otherwise the first
 * schema-valid question is the one card production would expose. */

interface PreviewToolCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
	readonly invalid?: boolean;
}

interface PreviewToolResult {
	readonly toolName: string;
	readonly output: unknown;
}

function successfulWaitOutput(output: unknown): boolean {
	return (
		typeof output === "object" &&
		output !== null &&
		"ok" in output &&
		output.ok === true &&
		"awaitingInput" in output &&
		output.awaitingInput === true
	);
}

export function designPreviewPendingQuestions<T extends PreviewToolCall>(
	toolCalls: readonly T[],
	toolResults: readonly PreviewToolResult[],
): T[] {
	const waitWon = toolResults.some(
		(result) =>
			result.toolName === "waitForInput" && successfulWaitOutput(result.output),
	);
	if (waitWon) return [];
	const firstQuestion = toolCalls.find(
		(call) => call.toolName === "askQuestions" && call.invalid !== true,
	);
	return firstQuestion === undefined ? [] : [firstQuestion];
}
