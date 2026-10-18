/** Read-only served-schema census. No environment, database or provider calls.
 * Usage: npx tsx --conditions=react-server scripts/inspect-tool-schema-hashes.ts
 * Hashes the exact JSON bytes shared tools send, including tools with no content
 * family. The aggregate hashes sorted name<TAB>sha256<LF> rows, including the
 * final newline; the final `set` row is not part of its own input.
 */
import { createHash } from "node:crypto";
import { authoringToolSchema } from "../lib/agent/authoring/toolSchema";
import { SHARED_TOOL_REGISTRY } from "../lib/agent/sharedToolRegistry";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
	console.log(
		"Usage: npx tsx --conditions=react-server scripts/inspect-tool-schema-hashes.ts\n\nPrints name<TAB>SHA-256 for every shared tool, followed by set<TAB>SHA-256.\nThe set digest hashes the sorted tool rows, each ending in a newline.\nNo database access or model calls.",
	);
} else if (args.length > 0) {
	console.error("This inspector takes no arguments. Use --help for usage.");
	process.exitCode = 1;
} else {
	const hash = (value: string) =>
		createHash("sha256").update(value).digest("hex");
	const entries = [...SHARED_TOOL_REGISTRY].sort((a, b) =>
		a.saName < b.saName ? -1 : a.saName > b.saName ? 1 : 0,
	);
	const rows = entries
		.map(({ saName, tool }) => {
			const bytes = JSON.stringify(
				authoringToolSchema(saName, tool.inputSchema).inputSchema.jsonSchema,
			);
			return `${saName}\t${hash(bytes)}\n`;
		})
		.join("");
	process.stdout.write(`${rows}set\t${hash(rows)}\n`);
}
