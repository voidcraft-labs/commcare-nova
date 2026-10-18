// The instances each XPath expression reads, as HQ's own XPath parser reads it.
//
// Reads a JSON array of strings on stdin and writes a JSON array of the same
// length: for each string, `{ "instances": [...], "structure": [...] }`
// with the sorted ids of every instance('<id>') call and the parser's
// expression structure (ordered same-AND/OR chains share one shape), or
// `{ "error": "..." }`
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

// HQ pins this parser through yarn.lock (js-xpath v0.0.8). Its grammar puts
// parentheses in `parens` after it has built their operand tree; quote
// delimiters live beside a string's decoded `value`. Neither is a semantic
// node. Read every semantic field directly, never a printer's output. An
// unhandled model is a failed comparison, not an empty or guessed shape.
function expressionStructure(node) {
	if (node instanceof models.XPathNumericLiteral) {
		// SchemeNumber distinguishes exact 1 from inexact 1.0 by printing
		// the latter as `1.`. XPath has no exact/inexact numeric distinction.
		// Keep every digit; converting through Number would lose precision.
		const value = node.value.toString();
		return ["number", value.endsWith(".") ? value.slice(0, -1) : value];
	}
	if (node instanceof models.XPathStringLiteral) {
		return ["string", node.value];
	}
	if (node instanceof models.XPathVariableReference) {
		return ["variable", node.value];
	}
	if (node instanceof models.XPathStep) {
		return [
			"step",
			node.axis,
			node.test,
			node.name ?? null,
			node.namespace ?? null,
			// The grammar holds a processing-instruction's literal with its
			// delimiters, unlike XPathStringLiteral. Keep its entire contents.
			node.literal == null ? null : node.literal.slice(1, -1),
			node.predicates.map(expressionStructure),
		];
	}
	if (node instanceof models.XPathPathExpr) {
		return [
			"path",
			node.initial_context,
			node.filter == null ? null : expressionStructure(node.filter),
			node.steps.map(expressionStructure),
		];
	}
	if (node instanceof models.XPathFuncExpr) {
		return ["call", node.id, node.args.map(expressionStructure)];
	}
	if (node instanceof models.XPathFilterExpr) {
		return [
			"filter",
			expressionStructure(node.expr),
			node.predicates.map(expressionStructure),
		];
	}
	if (node instanceof models.XPathBoolExpr) {
		if (node.type !== "and" && node.type !== "or") {
			throw new Error(
				"HQ's XPath parser returned an unhandled Boolean operator.",
			);
		}
		// The canonical wire rule omits parentheses on either side of the
		// same AND or OR. Keep their ordered operands, flattening only the
		// same operator; mixed Boolean and every other grouping stay intact.
		const operands = [];
		const collect = (operand) => {
			if (
				operand instanceof models.XPathBoolExpr &&
				operand.type === node.type
			) {
				collect(operand.left);
				collect(operand.right);
			} else {
				operands.push(expressionStructure(operand));
			}
		};
		collect(node.left);
		collect(node.right);
		return ["boolean", node.type, operands];
	}
	for (const [kind, model] of [
		["equality", models.XPathEqExpr],
		["comparison", models.XPathCmpExpr],
		["arithmetic", models.XPathArithExpr],
		["union", models.XPathUnionExpr],
	]) {
		if (node instanceof model) {
			return [
				kind,
				node.type,
				expressionStructure(node.left),
				expressionStructure(node.right),
			];
		}
	}
	if (node instanceof models.XPathNumNegExpr) {
		return ["negative", expressionStructure(node.value)];
	}
	throw new Error("HQ's XPath parser returned an unhandled expression model.");
}

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
	try {
		const tree = parser.parse(value);
		return {
			instances: instancesRead(tree),
			structure: expressionStructure(tree),
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
		};
	}
});
process.stdout.write(JSON.stringify(results));
