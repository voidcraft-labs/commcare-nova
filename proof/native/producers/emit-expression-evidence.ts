/** Private Core expression controls. This family constructs no app. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	instantFixedClock,
	instantOrderingPairs,
} from "../../../lib/commcare/__tests__/instantOrderingTable";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-expression-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
const pairs = instantOrderingPairs().map((pair) => ({
	...pair,
	left: { ...pair.left, node: "left" },
	right: { ...pair.right, node: "right" },
}));
writeFileSync(
	resolve(output, "orderings.json"),
	`${JSON.stringify({
		schemaVersion: 1,
		fixedClock: instantFixedClock,
		pairs,
	})}\n`,
);
console.log(`Produced ${pairs.length} private expression controls.`);
