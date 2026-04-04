/** Structured logging for the knowledge sync pipeline */

type Phase = "Discover" | "Crawl" | "Triage" | "Distill" | "Reorganize";

export function log(phase: Phase, message: string) {
	console.log(`[${phase}] ${message}`);
}

export function logCost(
	phase: Phase,
	label: string,
	inputTokens: number,
	outputTokens: number,
	costPerMInput: number,
	costPerMOutput: number,
) {
	const inputCost = (inputTokens / 1_000_000) * costPerMInput;
	const outputCost = (outputTokens / 1_000_000) * costPerMOutput;
	const totalCost = inputCost + outputCost;
	console.log(
		`[${phase}] ${label}: ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out — $${totalCost.toFixed(4)}`,
	);
	return totalCost;
}

export function logSummary(phase: Phase, lines: string[]) {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`[${phase}] Summary`);
	console.log("=".repeat(60));
	for (const line of lines) console.log(`  ${line}`);
	console.log("=".repeat(60) + "\n");
}
