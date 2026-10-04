// The surface extractor's JavaScript families (proof/surface/__init__.py),
// read from each file's syntax tree (acorn, from the image's own tools) with
// the scope analysis in scope.mjs. Each command prints one JSON document.
//
//   node surface.mjs vellum-features <main.js>
//   node surface.mjs detail-formats <utils.js> <column.js>...
//   node surface.mjs version-gates <script>...
//   node surface.mjs web-apps-appearances <form_entry directory> [<bindings.json>]
//
// Nothing here matches source text with a pattern: values are followed
// through bindings, parameters and properties.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	analyze,
	functionOf,
	isFunction,
	propertyName,
	text,
	walk,
} from "./scope.mjs";

const tools = process.env.PROOF_TOOLS ?? "/opt/proof-tools";
const require = createRequire(join(tools, "package.json"));
const acorn = require("acorn");

function parse(path) {
	const source = readFileSync(path, "utf8");
	for (const sourceType of ["module", "script"]) {
		try {
			return {
				source,
				program: acorn.parse(source, {
					ecmaVersion: "latest",
					sourceType,
					allowHashBang: true,
					allowReturnOutsideFunction: sourceType === "script",
				}),
			};
		} catch (error) {
			if (sourceType === "script")
				throw new Error(`acorn could not parse ${path}: ${error.message}`);
		}
	}
	throw new Error(`acorn could not parse ${path}`);
}

function stringValue(node) {
	if (node?.type === "Literal" && typeof node.value === "string")
		return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
		return node.quasis[0].value.cooked;
	return null;
}

// ---------------------------------------------------------------------------
// Vellum's feature readers: every `<features>.<key>` read, where the features
// object is followed from each `X.features` read through variables,
// assignments, destructuring and the parameters of the functions it is
// passed to.

function vellumFeatures(path) {
	const { program } = parse(path);
	const { referenceOf, bindings } = analyze(program);
	const tainted = new Set();

	function isFeatures(node) {
		if (!node) return false;
		switch (node.type) {
			case "MemberExpression":
				return propertyName(node) === "features";
			case "Identifier": {
				const binding = referenceOf.get(node);
				return binding != null && tainted.has(binding);
			}
			case "LogicalExpression":
				return isFeatures(node.left) || isFeatures(node.right);
			case "ConditionalExpression":
				return isFeatures(node.consequent) || isFeatures(node.alternate);
			case "SequenceExpression":
				return isFeatures(node.expressions[node.expressions.length - 1]);
			case "AssignmentExpression":
				return node.operator === "=" && isFeatures(node.right);
			default:
				return false;
		}
	}

	// What flows into each binding: its initialiser, each assignment to it,
	// and for a parameter each argument passed at a call of its function.
	const inflows = new Map(bindings.map((binding) => [binding, []]));
	for (const binding of bindings) {
		if (binding.init && binding.initPath.length === 0)
			inflows.get(binding).push(binding.init);
	}
	const destructured = [];
	for (const binding of bindings) {
		if (binding.init && binding.initPath.length > 0)
			destructured.push({ source: binding.init, path: binding.initPath });
	}
	const callsByFunction = new Map();
	for (const [node] of walk(program)) {
		if (
			node.type === "AssignmentExpression" &&
			node.operator === "=" &&
			node.left.type === "Identifier"
		) {
			const binding = referenceOf.get(node.left);
			if (binding) inflows.get(binding).push(node.right);
		}
		if (node.type === "CallExpression" || node.type === "NewExpression") {
			let callee = node.callee;
			let args = node.arguments;
			// f.call(this, a, b) passes a and b to f's parameters.
			if (
				callee.type === "MemberExpression" &&
				propertyName(callee) === "call" &&
				!callee.computed
			) {
				callee = callee.object;
				args = args.slice(1);
			}
			const target = isFunction(callee)
				? callee
				: callee.type === "Identifier"
					? functionOf(referenceOf.get(callee))
					: null;
			if (target) {
				const list = callsByFunction.get(target) ?? [];
				list.push(args);
				callsByFunction.set(target, list);
			}
		}
	}
	const paramBindings = bindings.filter((binding) => binding.kind === "param");
	const destructuredParams = [];
	for (const binding of paramBindings) {
		for (const args of callsByFunction.get(binding.function) ?? []) {
			const arg = args[binding.paramIndex];
			if (!arg || arg.type === "SpreadElement") continue;
			if (binding.paramPath.length === 0) inflows.get(binding).push(arg);
			else destructuredParams.push({ source: arg, path: binding.paramPath });
		}
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const [binding, sources] of inflows) {
			if (!tainted.has(binding) && sources.some(isFeatures)) {
				tainted.add(binding);
				changed = true;
			}
		}
	}

	const keys = new Set();
	for (const { source, path: keyPath } of [
		...destructured,
		...destructuredParams,
	]) {
		if (
			isFeatures(source) &&
			typeof keyPath[0] === "string" &&
			keyPath[0] !== "..."
		)
			keys.add(keyPath[0]);
	}
	for (const [node, parent] of walk(program)) {
		if (node.type === "MemberExpression" && isFeatures(node.object)) {
			const name = propertyName(node);
			const called =
				parent?.type === "CallExpression" && parent.callee === node;
			if (name != null && !called) keys.add(name);
		}
		if (
			node.type === "BinaryExpression" &&
			node.operator === "in" &&
			isFeatures(node.right)
		) {
			const name = stringValue(node.left);
			if (name != null) keys.add(name);
		}
	}
	return { keys: [...keys].sort() };
}

// ---------------------------------------------------------------------------
// The case list editor's formats: the entries `getFieldFormats` offers with
// the toggle or add-on that guards each, the format dependencies
// `dynamicFormats` declares, and the formats `filterFormats` treats apart.

function enclosingTests(node, parentOf, stop) {
	const tests = [];
	let child = node;
	for (
		let current = parentOf.get(node);
		current && current !== stop;
		current = parentOf.get(current)
	) {
		if (current.type === "IfStatement") {
			// A value inside a condition is what is tested, not what the branch does.
			if (child === current.test) return null;
			tests.push({
				test: current.test,
				branch: child === current.consequent ? "then" : "else",
			});
		}
		child = current;
	}
	return tests.reverse();
}

function parentMap(program) {
	const parentOf = new Map();
	for (const [node, parent] of walk(program)) parentOf.set(node, parent);
	return parentOf;
}

function functionNamed(program, name) {
	for (const [node] of walk(program)) {
		if (
			node.type === "AssignmentExpression" &&
			node.left.type === "MemberExpression" &&
			propertyName(node.left) === name &&
			isFunction(node.right)
		)
			return node.right;
		if (node.type === "FunctionDeclaration" && node.id?.name === name)
			return node;
		if (
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier" &&
			node.id.name === name &&
			isFunction(node.init)
		)
			return node.init;
		if (
			node.type === "Property" &&
			propertyName({
				type: "MemberExpression",
				computed: node.computed,
				property: node.key,
			}) === name &&
			isFunction(node.value)
		)
			return node.value;
	}
	return null;
}

function describeGuard(source, test, referenceOf) {
	if (
		test.type === "CallExpression" &&
		test.callee.type === "MemberExpression" &&
		propertyName(test.callee) === "toggleEnabled" &&
		stringValue(test.arguments[0]) != null
	)
		return { toggle: stringValue(test.arguments[0]) };
	if (test.type === "MemberExpression" && test.object.type === "Identifier") {
		const binding = referenceOf.get(test.object);
		const init = binding?.init;
		if (
			init?.type === "CallExpression" &&
			init.callee.type === "MemberExpression" &&
			propertyName(init.callee) === "get" &&
			stringValue(init.arguments[0]) === "add_ons"
		)
			return { addOn: propertyName(test) };
	}
	return { expression: text(source, test) };
}

function literalValue(node) {
	if (node.type === "Literal") return node.value;
	if (node.type === "ArrayExpression") return node.elements.map(literalValue);
	if (node.type === "ObjectExpression") {
		const out = {};
		for (const property of node.properties) {
			const key =
				property.key.type === "Identifier"
					? property.key.name
					: property.key.value;
			out[key] = literalValue(property.value);
		}
		return out;
	}
	throw new Error(`not a literal: ${node.type}`);
}

function detailFormats(utilsPath, columnPaths) {
	const utils = parse(utilsPath);
	const { referenceOf } = analyze(utils.program);
	const parentOf = parentMap(utils.program);
	const getFieldFormats = functionNamed(utils.program, "getFieldFormats");
	if (!getFieldFormats) throw new Error(`no getFieldFormats in ${utilsPath}`);
	const offered = [];
	for (const [node] of walk(getFieldFormats)) {
		if (node.type !== "ObjectExpression") continue;
		const valueProperty = node.properties.find(
			(p) =>
				p.type === "Property" &&
				propertyName({
					type: "MemberExpression",
					computed: p.computed,
					property: p.key,
				}) === "value",
		);
		const value = valueProperty && stringValue(valueProperty.value);
		if (value == null) continue;
		const guards = (enclosingTests(node, parentOf, getFieldFormats) ?? []).map(
			({ test, branch }) => ({
				...describeGuard(utils.source, test, referenceOf),
				branch,
			}),
		);
		offered.push({ value, guards });
	}
	let dependencies = {};
	for (const [node] of walk(utils.program)) {
		if (
			node.type === "Property" &&
			propertyName({
				type: "MemberExpression",
				computed: node.computed,
				property: node.key,
			}) === "COLUMN_FORMAT_DEPENDENCIES" &&
			node.value.type === "ObjectExpression"
		)
			dependencies = literalValue(node.value);
	}
	const filters = {};
	for (const columnPath of columnPaths) {
		const column = parse(columnPath);
		const columnParents = parentMap(column.program);
		const { referenceOf } = analyze(column.program);
		const filterFormats = functionNamed(column.program, "filterFormats");
		if (!filterFormats) throw new Error(`no filterFormats in ${columnPath}`);
		const found = {};
		for (const [node] of walk(filterFormats)) {
			const value = stringValue(node);
			if (value == null) continue;
			const parent = columnParents.get(node);
			// A property key (`value:`) or a field name is not a format.
			if (parent?.type === "Property" && parent.key === node) continue;
			// A value inside a condition is what is tested, not what the branch does.
			if (enclosingTests(node, columnParents, filterFormats) == null) continue;
			const list = found[value] ?? [];
			list.push(
				filterOperation(
					column.source,
					node,
					columnParents,
					referenceOf,
					filterFormats,
				),
			);
			found[value] = list;
		}
		filters[columnPath] = found;
	}
	return { offered, dependencies, filters };
}

// The list methods filterFormats changes its options with: whether each adds
// a format to the menu or removes one (a splice that inserts the format adds it).
const LIST_OPERATIONS = {
	concat: "add",
	push: "add",
	unshift: "add",
	splice: "remove",
	filter: "remove",
};

function listCall(node) {
	if (
		node?.type === "CallExpression" &&
		node.callee.type === "MemberExpression" &&
		!node.callee.computed
	) {
		const method = propertyName(node.callee);
		if (method in LIST_OPERATIONS) return method;
	}
	return null;
}

function nearest(node, parentOf, stop, test) {
	for (
		let current = node;
		current && current !== stop;
		current = parentOf.get(current)
	) {
		if (test(current)) return current;
	}
	return null;
}

function within(node, ancestor, parentOf) {
	for (let current = node; current; current = parentOf.get(current)) {
		if (current === ancestor) return true;
	}
	return false;
}

// Every read, inside `scope`, of the variable a declarator binds.
function readsOf(declarator, scope, referenceOf) {
	const reads = [];
	for (const [node] of walk(scope)) {
		if (
			node.type === "Identifier" &&
			referenceOf.get(node)?.declaration === declarator
		)
			reads.push(node);
	}
	return reads;
}

const MATCHERS = ["includes", "startsWith", "endsWith", "indexOf"];

// What filterFormats does with a format literal: the list call that consumes
// it (the call it is an argument of, as `concat([{value: "graph"}])` is; the
// list call in the branch whose test compares an option with the literal's
// variable, as `splice(j, 1)` is for `menuOptionsToRemove[i]`; or the list
// call a `findIndex` verdict that tests the literal is passed to), the
// comparison that matches an option against it, and every test around that
// call up to filterFormats, loop bodies included.
function filterOperation(source, literal, parentOf, referenceOf, stop) {
	let holder = literal;
	for (;;) {
		const parent = parentOf.get(holder);
		const contains =
			parent?.type === "ArrayExpression" ||
			parent?.type === "ObjectExpression" ||
			(parent?.type === "Property" && parent.value === holder);
		if (!contains) break;
		holder = parent;
	}
	let consumer = null;
	let match = null;
	const container = parentOf.get(holder);
	if (listCall(container) && container.arguments.includes(holder))
		consumer = container;
	const uses =
		container?.type === "VariableDeclarator" && container.init === holder
			? readsOf(container, stop, referenceOf)
			: [literal];
	for (const use of consumer ? [] : uses) {
		const comparison = nearest(
			use,
			parentOf,
			stop,
			(node) =>
				node.type === "BinaryExpression" ||
				(node.type === "CallExpression" &&
					node.callee.type === "MemberExpression" &&
					MATCHERS.includes(propertyName(node.callee))),
		);
		if (!comparison) continue;
		// A test whose branch changes the list.
		const branch = nearest(
			comparison,
			parentOf,
			stop,
			(node) => node.type === "IfStatement",
		);
		if (branch && within(comparison, branch.test, parentOf)) {
			for (const [inner] of walk(branch.consequent)) {
				if (listCall(inner)) {
					consumer = inner;
					break;
				}
			}
		}
		// A callback's verdict, as `findIndex(f => f.value.includes(...))`,
		// bound and passed to a list call.
		const callback = consumer
			? null
			: nearest(comparison, parentOf, stop, isFunction);
		const call = callback ? parentOf.get(callback) : null;
		const declarator = call ? parentOf.get(call) : null;
		if (
			call?.type === "CallExpression" &&
			declarator?.type === "VariableDeclarator"
		) {
			for (const read of readsOf(declarator, stop, referenceOf)) {
				const user = parentOf.get(read);
				if (listCall(user) && user.arguments[0] === read) {
					consumer = user;
					break;
				}
			}
		}
		if (consumer) {
			match = text(source, comparison);
			break;
		}
	}
	const conditions = (
		enclosingTests(consumer ?? literal, parentOf, stop) ?? []
	).map(({ test, branch }) => ({ test: text(source, test), branch }));
	const method = consumer ? listCall(consumer) : null;
	// `splice(start, count, ...items)` adds the items it is given.
	const inserted =
		method === "splice" && consumer.arguments.indexOf(holder) >= 2;
	return {
		operation: method ? (inserted ? "add" : LIST_OPERATIONS[method]) : null,
		method,
		match,
		conditions,
	};
}

// ---------------------------------------------------------------------------
// Version gates in app-manager scripts: the attributes read with `.attr()`
// next to `data-since-version`, and the fields read on a setting whose
// `since` the script reads.

function versionGates(paths) {
	const out = {};
	for (const path of paths) {
		const { program } = parse(path);
		const { referenceOf } = analyze(program);
		const parentOf = parentMap(program);
		const readers = [];
		for (const [node] of walk(program)) {
			if (
				node.type === "CallExpression" &&
				node.callee.type === "MemberExpression" &&
				propertyName(node.callee) === "attr" &&
				stringValue(node.arguments[0]) === "data-since-version"
			) {
				let fn = parentOf.get(node);
				while (fn && !isFunction(fn)) fn = parentOf.get(fn);
				const strings = new Set();
				for (const [inner] of walk(fn ?? program)) {
					const value = stringValue(inner);
					if (value != null) strings.add(value);
				}
				readers.push({
					reads: "attribute data-since-version",
					strings: [...strings].sort(),
				});
			}
		}
		const settings = new Map();
		for (const [node] of walk(program)) {
			if (
				node.type === "MemberExpression" &&
				propertyName(node) === "since" &&
				node.object.type === "Identifier"
			) {
				const binding = referenceOf.get(node.object);
				if (binding) settings.set(binding, binding);
			}
		}
		for (const binding of settings.keys()) {
			const fields = new Set();
			for (const reference of binding.references) {
				const parent = parentOf.get(reference);
				if (
					parent?.type === "MemberExpression" &&
					parent.object === reference
				) {
					const name = propertyName(parent);
					if (name != null) fields.add(name);
				}
			}
			readers.push({
				reads: `setting fields through ${binding.name}`,
				fields: [...fields].sort(),
			});
		}
		out[path] = { readers };
	}
	return out;
}

const [command, ...args] = process.argv.slice(2);
let result;
switch (command) {
	case "vellum-features":
		result = vellumFeatures(args[0]);
		break;
	case "detail-formats":
		result = detailFormats(args[0], args.slice(1));
		break;
	case "version-gates":
		result = versionGates(args);
		break;
	case "web-apps-appearances":
		result = webAppsAppearances(args[0], args[1]);
		break;
	default:
		throw new Error(`unknown command ${command}`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);

// ---------------------------------------------------------------------------
// Web Apps' form entry: every read of a question's appearance, followed from
// `style.raw` (the appearance Formplayer passes through as `{raw: hint}`)
// through variables, parameters, returns, object properties, `.split()`
// tokens and indexed words to each comparison, with the token compared with.
// A token a helper takes as a parameter is followed back to the constants its
// callers pass (`question.stylesContains(constants.MINIMAL)`), resolving
// `constants.X` through const.js.

function namedFunctions(unit) {
	const byName = new Map();
	const add = (name, fn) => {
		if (name == null || !isFunction(fn)) return;
		const list = byName.get(name) ?? [];
		list.push({ fn, unit });
		byName.set(name, list);
	};
	for (const [node] of walk(unit.program)) {
		if (node.type === "FunctionDeclaration") add(node.id?.name, node);
		else if (
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier"
		)
			add(node.id.name, node.init);
		else if (
			node.type === "AssignmentExpression" &&
			node.left.type === "MemberExpression"
		)
			add(propertyName(node.left), node.right);
		else if (
			node.type === "Property" &&
			!node.computed &&
			node.key.type === "Identifier"
		)
			add(node.key.name, node.value);
		else if (node.type === "MethodDefinition" && node.key.type === "Identifier")
			add(node.key.name, node.value);
	}
	return byName;
}

function functionLabel(unit, fn) {
	const parent = unit.parents.get(fn);
	if (fn.type === "FunctionDeclaration" && fn.id) return fn.id.name;
	if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier")
		return parent.id.name;
	if (parent?.type === "AssignmentExpression")
		return text(unit.source, parent.left);
	if (parent?.type === "Property" || parent?.type === "MethodDefinition")
		return text(unit.source, parent.key);
	return "<anonymous>";
}

function enclosingFunction(unit, node) {
	for (
		let current = unit.parents.get(node);
		current;
		current = unit.parents.get(current)
	) {
		if (isFunction(current)) return current;
	}
	return null;
}

function webAppsAppearances(directory, bindingsPath) {
	const units = readdirSync(directory)
		.filter((name) => name.endsWith(".js"))
		.sort()
		.map((name) => {
			const parsed = parse(join(directory, name));
			const scope = analyze(parsed.program);
			return { name, ...parsed, ...scope, parents: parentMap(parsed.program) };
		});
	// Knockout binding expressions from the form entry templates run against the
	// question view model, so a bare name there is one of its methods.
	const bindings = bindingsPath
		? JSON.parse(readFileSync(bindingsPath, "utf8"))
		: [];
	for (const { file, expressions } of bindings) {
		const source = expressions
			.map((expression) => `({${expression}});`)
			.join("\n");
		const program = acorn.parse(source, {
			ecmaVersion: "latest",
			sourceType: "script",
		});
		units.push({
			name: file,
			source,
			program,
			template: true,
			...analyze(program),
			parents: parentMap(program),
		});
	}
	const constants = new Map();
	for (const unit of units.filter((u) => u.name === "const.js")) {
		for (const [node] of walk(unit.program)) {
			if (
				node.type !== "ExportDefaultDeclaration" ||
				node.declaration.type !== "ObjectExpression"
			)
				continue;
			for (const property of node.declaration.properties) {
				const key = propertyName({
					type: "MemberExpression",
					computed: property.computed,
					property: property.key,
				});
				const value = property.value;
				if (stringValue(value) != null)
					constants.set(key, { kind: "string", value: stringValue(value) });
				else if (value.type === "Literal" && value.regex)
					constants.set(key, { kind: "regex", value: value.regex.pattern });
				else if (
					value.type === "NewExpression" &&
					value.callee.name === "RegExp" &&
					stringValue(value.arguments[0]) != null
				)
					constants.set(key, {
						kind: "regex",
						value: stringValue(value.arguments[0]),
					});
			}
		}
	}
	const byName = new Map();
	for (const unit of units) {
		for (const [name, list] of namedFunctions(unit))
			byName.set(name, [...(byName.get(name) ?? []), ...list]);
	}
	const unitOfFunction = new Map();
	for (const list of byName.values())
		for (const { fn, unit } of list) unitOfFunction.set(fn, unit);

	function targets(unit, callee) {
		if (isFunction(callee)) return [{ fn: callee, unit }];
		if (callee.type === "Identifier") {
			const binding = unit.referenceOf.get(callee);
			if (!binding && unit.template) return byName.get(callee.name) ?? [];
			const fn = functionOf(binding);
			return fn ? [{ fn, unit }] : [];
		}
		if (callee.type === "MemberExpression") {
			const name = propertyName(callee);
			return name ? (byName.get(name) ?? []) : [];
		}
		return [];
	}

	const bindingTaint = new Map();
	const propertyTaint = new Map();
	const returnTaint = new Map();
	const add = (map, key, labels) => {
		const current = map.get(key) ?? new Set();
		let changed = false;
		for (const label of labels) {
			if (!current.has(label)) {
				current.add(label);
				changed = true;
			}
		}
		map.set(key, current);
		return changed;
	};
	const isStyle = (node) =>
		(node.type === "Identifier" && node.name === "style") ||
		(node.type === "MemberExpression" && propertyName(node) === "style");

	function labelsOf(unit, node) {
		const out = new Set();
		if (!node) return out;
		switch (node.type) {
			case "MemberExpression": {
				const name = propertyName(node);
				if (name === "raw" && isStyle(node.object)) return new Set(["raw"]);
				if (
					node.computed &&
					node.property.type === "Literal" &&
					typeof node.property.value === "number"
				) {
					for (const label of labelsOf(unit, node.object))
						if (label.startsWith("tokens:"))
							out.add(`word:${node.property.value}:${label.slice(7)}`);
					return out;
				}
				if (name != null && name !== "raw" && name !== "style")
					for (const label of propertyTaint.get(name) ?? []) out.add(label);
				return out;
			}
			case "Identifier": {
				const binding = unit.referenceOf.get(node);
				return new Set(binding ? (bindingTaint.get(binding) ?? []) : []);
			}
			case "LogicalExpression":
				return new Set([
					...labelsOf(unit, node.left),
					...labelsOf(unit, node.right),
				]);
			case "ConditionalExpression":
				return new Set([
					...labelsOf(unit, node.consequent),
					...labelsOf(unit, node.alternate),
				]);
			case "AssignmentExpression":
				return labelsOf(unit, node.right);
			case "CallExpression": {
				const callee = node.callee;
				const name =
					callee.type === "MemberExpression"
						? propertyName(callee)
						: callee.name;
				if (
					callee.type === "MemberExpression" &&
					name === "raw" &&
					isStyle(callee.object)
				)
					return new Set(["raw"]);
				if (name === "unwrapObservable")
					return labelsOf(unit, node.arguments[0]);
				if (
					callee.type === "MemberExpression" &&
					(name === "toLowerCase" || name === "trim")
				) {
					for (const label of labelsOf(unit, callee.object))
						out.add(name === "toLowerCase" ? `${label}+lower` : label);
					return out;
				}
				if (callee.type === "MemberExpression" && name === "split") {
					const separator = node.arguments[0];
					const shown =
						stringValue(separator) != null
							? JSON.stringify(stringValue(separator))
							: separator?.regex
								? `/${separator.regex.pattern}/`
								: "?";
					for (const label of labelsOf(unit, callee.object))
						if (label.startsWith("raw")) out.add(`tokens:${shown}`);
					return out;
				}
				for (const target of targets(unit, callee))
					for (const label of returnTaint.get(target.fn) ?? []) out.add(label);
				return out;
			}
			default:
				return out;
		}
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const unit of units) {
			for (const binding of unit.bindings) {
				if (binding.init && binding.initPath.length === 0)
					changed =
						add(bindingTaint, binding, labelsOf(unit, binding.init)) || changed;
			}
			for (const [node] of walk(unit.program)) {
				if (node.type === "AssignmentExpression" && node.operator === "=") {
					const labels = labelsOf(unit, node.right);
					if (node.left.type === "Identifier") {
						const binding = unit.referenceOf.get(node.left);
						if (binding)
							changed = add(bindingTaint, binding, labels) || changed;
					} else if (node.left.type === "MemberExpression") {
						const name = propertyName(node.left);
						if (name && name !== "raw" && name !== "style")
							changed = add(propertyTaint, name, labels) || changed;
					}
				} else if (node.type === "Property" && !node.computed) {
					const name = propertyName({
						type: "MemberExpression",
						computed: false,
						property: node.key,
					});
					if (name && name !== "raw" && name !== "style")
						changed =
							add(propertyTaint, name, labelsOf(unit, node.value)) || changed;
				} else if (node.type === "ReturnStatement" && node.argument) {
					const fn = enclosingFunction(unit, node);
					if (fn)
						changed =
							add(returnTaint, fn, labelsOf(unit, node.argument)) || changed;
				} else if (node.type === "CallExpression") {
					const callee = node.callee;
					const name =
						callee.type === "MemberExpression" ? propertyName(callee) : null;
					// tokens.forEach(function (token) {...}): each element of the tokens.
					if (
						["forEach", "map", "filter", "some", "every", "find"].includes(name)
					) {
						const callback = node.arguments[0];
						const labels = [...labelsOf(unit, callee.object)].filter((l) =>
							l.startsWith("tokens:"),
						);
						if (
							isFunction(callback) &&
							callback.params[0]?.type === "Identifier" &&
							labels.length
						) {
							const binding = unit.bindings.find(
								(b) => b.id === callback.params[0],
							);
							if (binding)
								changed =
									add(
										bindingTaint,
										binding,
										labels.map((l) => `token:${l.slice(7)}`),
									) || changed;
						}
					}
					for (const target of targets(unit, callee)) {
						const targetUnit = unitOfFunction.get(target.fn) ?? target.unit;
						node.arguments.forEach((argument, index) => {
							const param = target.fn.params[index];
							if (param?.type !== "Identifier") return;
							const binding = targetUnit.bindings.find((b) => b.id === param);
							if (binding)
								changed =
									add(bindingTaint, binding, labelsOf(unit, argument)) ||
									changed;
						});
					}
				}
			}
		}
	}

	function valuesOf(unit, node, depth = 0) {
		if (!node || depth > 5) return [];
		const literal = stringValue(node);
		if (literal != null) return [{ kind: "string", value: literal }];
		if (node.type === "Literal" && node.regex)
			return [{ kind: "regex", value: node.regex.pattern }];
		if (
			node.type === "MemberExpression" &&
			node.object.type === "Identifier" &&
			constants.has(propertyName(node))
		) {
			const binding = unit.referenceOf.get(node.object);
			if (binding?.kind === "import")
				return [constants.get(propertyName(node))];
		}
		if (node.type === "Identifier") {
			const binding = unit.referenceOf.get(node);
			if (binding?.kind === "param") {
				const found = [];
				for (const caller of units) {
					for (const [call] of walk(caller.program)) {
						if (call.type !== "CallExpression") continue;
						if (
							!targets(caller, call.callee).some(
								(t) => t.fn === binding.function,
							)
						)
							continue;
						found.push(
							...valuesOf(
								caller,
								call.arguments[binding.paramIndex],
								depth + 1,
							),
						);
					}
				}
				return found;
			}
			if (binding?.init && binding.initPath.length === 0)
				return valuesOf(unit, binding.init, depth + 1);
		}
		return [];
	}

	const reads = new Map();
	function record(unit, at, labels, values, how) {
		let fn = enclosingFunction(unit, at);
		while (fn && functionLabel(unit, fn) === "<anonymous>")
			fn = enclosingFunction(unit, fn);
		const where = `${unit.name}::${fn ? functionLabel(unit, fn) : "<template>"}`;
		for (const label of labels) {
			const lower = label.endsWith("+lower");
			const base = lower ? label.slice(0, -6) : label;
			let match;
			if (base === "raw") match = how === "equals" ? "whole" : how;
			else if (base.startsWith("token:"))
				match = `${how === "equals" ? "token" : `token-${how}`} split on ${base.slice(6)}`;
			else if (base.startsWith("tokens:"))
				match = `${how === "contains" ? "token" : `tokens-${how}`} split on ${base.slice(7)}`;
			else if (base.startsWith("word:")) {
				const [, index, separator] = base.match(/^word:(\d+):(.*)$/) ?? [];
				match = `word ${index} split on ${separator}${how === "equals" ? "" : ` (${how})`}`;
			} else match = how;
			// `.match()` reads a pattern and `===` a string: a caller's other kind of value reaches
			// that comparison only past a type test (`pattern instanceof RegExp`), so it is not read there.
			const kinds = how === "regex" ? ["regex"] : ["string"];
			const typed = values.filter((value) => kinds.includes(value.kind));
			const found = values.length
				? typed
				: [{ kind: "unresolved", value: "<unresolved>" }];
			for (const value of found) {
				const kind = match;
				const key = JSON.stringify([
					value.value,
					kind,
					lower ? "lowercased" : "exact",
				]);
				const entry = reads.get(key) ?? new Set();
				entry.add(where);
				reads.set(key, entry);
			}
		}
	}
	for (const unit of units) {
		for (const [node] of walk(unit.program)) {
			if (
				node.type === "BinaryExpression" &&
				["===", "==", "!==", "!="].includes(node.operator)
			) {
				for (const [side, other] of [
					[node.left, node.right],
					[node.right, node.left],
				]) {
					const labels = labelsOf(unit, side);
					if (labels.size)
						record(unit, node, labels, valuesOf(unit, other), "equals");
				}
			} else if (node.type === "CallExpression") {
				const callee = node.callee;
				const name =
					callee.type === "MemberExpression" ? propertyName(callee) : null;
				if (
					name === "match" ||
					name === "startsWith" ||
					name === "includes" ||
					name === "indexOf"
				) {
					const labels = labelsOf(unit, callee.object);
					const how = {
						match: "regex",
						startsWith: "prefix",
						includes: "contains",
						indexOf: "contains",
					}[name];
					if (labels.size)
						record(unit, node, labels, valuesOf(unit, node.arguments[0]), how);
				}
				if (
					name === "contains" &&
					callee.object.type === "Identifier" &&
					callee.object.name === "_"
				) {
					const labels = labelsOf(unit, node.arguments[0]);
					if (labels.size)
						record(
							unit,
							node,
							labels,
							valuesOf(unit, node.arguments[1]),
							"contains",
						);
				}
			} else if (node.type === "SwitchStatement") {
				const labels = labelsOf(unit, node.discriminant);
				if (labels.size)
					record(
						unit,
						node,
						labels,
						node.cases.flatMap((c) => (c.test ? valuesOf(unit, c.test) : [])),
						"equals",
					);
			}
		}
	}
	return {
		reads: [...reads.entries()]
			.map(([key, where]) => {
				const [token, match, caseHandling] = JSON.parse(key);
				return { token, match, case: caseHandling, at: [...where].sort() };
			})
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
	};
}
