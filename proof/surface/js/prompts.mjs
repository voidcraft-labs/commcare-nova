// The values Web Apps compares a search prompt's `input` or `appearance` with
// (proof/surface/families/search.py), read from syntax trees (acorn, from the
// image's own tools):
//
//   node prompts.mjs <hq with node_modules> < {"root", "scripts": [path...], "templates": [{"file", "text"}...]}
//
// `root` is the HQ checkout the scripts are named relative to; Underscore is
// HQ's own, from the checkout that holds HQ's node_modules.
//
// In a script, a read is `<model>.get("input")` (or "appearance") and a
// comparison is `===`/`==`/`!==`/`!=` with a string literal, or a `case` of a
// `switch` on the read. A template is an Underscore template (a
// `<script type="text/template">` body): it is compiled with HQ's own
// Underscore (`_.template(text).source`), whose `with (obj)` makes `input` and
// `appearance` the prompt's fields, and the compiled source is read the same
// way. Prints one JSON document: {reads: [...]}.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

const tools = process.env.PROOF_TOOLS ?? "/opt/proof-tools";
const toolsRequire = createRequire(join(tools, "package.json"));
const acorn = toolsRequire("acorn");
const walk = toolsRequire("acorn-walk");

const PROPERTIES = new Set(["input", "appearance"]);

function literal(node) {
	if (node?.type === "Literal" && typeof node.value === "string")
		return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
		return node.quasis[0].value.cooked;
	return null;
}

/** "input" / "appearance" when the node reads that field of a prompt. */
function readOf(node, template) {
	if (template && node?.type === "Identifier" && PROPERTIES.has(node.name))
		return node.name;
	if (
		node?.type === "CallExpression" &&
		node.callee.type === "MemberExpression" &&
		!node.callee.computed &&
		node.callee.property.name === "get" &&
		node.arguments.length === 1
	) {
		const field = literal(node.arguments[0]);
		if (PROPERTIES.has(field)) return field;
	}
	return null;
}

function functionName(ancestors) {
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const node = ancestors[i];
		if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
		if (node.type === "Property" && node.key)
			return node.key.name ?? node.key.value;
		if (node.type === "MethodDefinition" && node.key) return node.key.name;
		if (node.type === "VariableDeclarator" && node.id?.name)
			return node.id.name;
		if (
			node.type === "AssignmentExpression" &&
			node.left.type === "MemberExpression" &&
			!node.left.computed
		)
			return node.left.property.name;
	}
	return null;
}

function reads(program, file, template) {
	const found = [];
	walk.ancestor(program, {
		BinaryExpression(node, _state, ancestors) {
			if (!["===", "==", "!==", "!="].includes(node.operator)) return;
			for (const [side, other] of [
				[node.left, node.right],
				[node.right, node.left],
			]) {
				const property = readOf(side, template);
				const value = literal(other);
				if (property && value !== null) {
					const where = template
						? file
						: `${file}::${functionName(ancestors) ?? "?"}`;
					found.push({ property, value, how: "compared", at: where });
				}
			}
		},
		SwitchStatement(node, _state, ancestors) {
			const property = readOf(node.discriminant, template);
			if (!property) return;
			for (const choice of node.cases) {
				const value = literal(choice.test);
				if (value !== null) {
					const where = template
						? file
						: `${file}::${functionName(ancestors) ?? "?"}`;
					found.push({ property, value, how: "compared", at: where });
				}
			}
		},
	});
	return found;
}

const [hqNode] = process.argv.slice(2);
const request = JSON.parse(readFileSync(0, "utf8"));
const hqRoot = request.root;
const underscore = createRequire(join(hqNode, "package.json"))("underscore");
const all = [];
for (const path of request.scripts) {
	const program = acorn.parse(readFileSync(path, "utf8"), {
		ecmaVersion: "latest",
		sourceType: "module",
	});
	all.push(...reads(program, `commcare-hq/${relative(hqRoot, path)}`, false));
}
for (const template of request.templates) {
	const source = underscore.template(template.text).source;
	const program = acorn.parse(`(${source})`, { ecmaVersion: "latest" });
	all.push(...reads(program, template.file, true));
}
process.stdout.write(JSON.stringify({ reads: all }));
