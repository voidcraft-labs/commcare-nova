// The instances each XPath expression reads, as HQ's own XPath parser reads it.
//
// Reads a JSON array of strings on stdin and writes a JSON array of the same
// length: for each string, `{ "instances": [...] }` with the sorted ids of
// every instance('<id>') call in its parse tree, or `{ "error": "..." }`
// with the parser's message when the string does not parse. The caller
// sends only values the suite holds as XPath, so an error there is a
// failure, never a value that reads no instance. The parser is js-xpath
// from HQ's node packages, the one HQ's build runs on every module and form
// filter (corehq/apps/app_manager/xpath_validator/nodejs/xpathValidator.js);
// the harness image keeps it at $PROOF_HQ/node_modules/xpath.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const hqRoot = process.env.PROOF_HQ ?? "/opt/hq";
const parser = require(
	join(hqRoot, "node_modules", "xpath", "dist", "js-xpath.js"),
);
const models = parser.yy.xpathmodels;

function instancesRead(tree) {
	const found = new Set();
	const seen = new Set();
	const visit = (node) => {
		if (node === null || typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		if (
			node instanceof models.XPathFuncExpr &&
			node.id === "instance" &&
			node.args.length === 1 &&
			node.args[0] instanceof models.XPathStringLiteral
		) {
			found.add(node.args[0].value);
		}
		// Every part of the tree: a path's filter and steps, a step's
		// predicates, a call's arguments, an operator's operands.
		for (const value of Object.values(node)) visit(value);
	};
	visit(tree);
	return [...found].sort();
}

const values = JSON.parse(readFileSync(0, "utf8"));
const results = values.map((value) => {
	let tree;
	try {
		tree = parser.parse(value);
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return { instances: instancesRead(tree) };
});
process.stdout.write(JSON.stringify(results));
