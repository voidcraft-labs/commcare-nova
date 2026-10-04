// Scope analysis over an ESTree syntax tree (acorn's), for the surface
// extractor's JavaScript families (proof/surface/js/surface.mjs).
//
// `analyze(program)` binds every declaration to its scope (function, block,
// catch and module scopes, with `var` and function declarations hoisted to
// their function) and resolves every identifier in a reference position to
// the binding it reads, so a value can be followed from where it is made to
// every read of it, however often a minifier reuses a name.

const FUNCTION_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
]);

export function isFunction(node) {
	return node != null && FUNCTION_TYPES.has(node.type);
}

class Scope {
	constructor(node, parent, isFunctionScope) {
		this.node = node;
		this.parent = parent;
		this.isFunctionScope = isFunctionScope;
		this.bindings = new Map();
	}

	functionScope() {
		let scope = this;
		while (!scope.isFunctionScope) scope = scope.parent;
		return scope;
	}

	lookup(name) {
		for (let scope = this; scope; scope = scope.parent) {
			const found = scope.bindings.get(name);
			if (found) return found;
		}
		return null;
	}
}

function childNodes(node) {
	const children = [];
	for (const key of Object.keys(node)) {
		if (key === "type" || key === "start" || key === "end" || key === "loc")
			continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const element of value) {
				if (element && typeof element.type === "string")
					children.push([key, element]);
			}
		} else if (value && typeof value.type === "string") {
			children.push([key, value]);
		}
	}
	return children;
}

/** The identifiers a declaration pattern binds, with the path from the bound value to each. */
export function patternNames(pattern, path = []) {
	if (!pattern) return [];
	switch (pattern.type) {
		case "Identifier":
			return [{ id: pattern, path }];
		case "ObjectPattern":
			return pattern.properties.flatMap((property) => {
				if (property.type === "RestElement")
					return patternNames(property.argument, [...path, "..."]);
				const key =
					!property.computed && property.key.type === "Identifier"
						? property.key.name
						: property.key.type === "Literal"
							? String(property.key.value)
							: null;
				return patternNames(property.value, [...path, key]);
			});
		case "ArrayPattern":
			return pattern.elements.flatMap((element, index) =>
				patternNames(element, [...path, index]),
			);
		case "AssignmentPattern":
			return patternNames(pattern.left, path);
		case "RestElement":
			return patternNames(pattern.argument, [...path, "..."]);
		default:
			return [];
	}
}

export function analyze(program) {
	const scopeOf = new Map();
	const parentOf = new Map();
	const referenceOf = new Map();
	const bindings = [];
	const declared = new Set();

	function declare(scope, id, kind, declaration, extra = {}) {
		const binding = {
			name: id.name,
			kind,
			id,
			declaration,
			scope,
			references: [],
			...extra,
		};
		scope.bindings.set(id.name, binding);
		bindings.push(binding);
		declared.add(id);
		return binding;
	}

	// Pass 1: scopes and declarations.
	const moduleScope = new Scope(program, null, true);
	scopeOf.set(program, moduleScope);

	function newFunctionScope(node, scope) {
		const inner = new Scope(node, scope, true);
		scopeOf.set(node, inner);
		if (node.type === "FunctionExpression" && node.id)
			declare(inner, node.id, "function-name", node, { function: node });
		node.params.forEach((param, index) => {
			for (const { id, path } of patternNames(param)) {
				declare(inner, id, "param", node, {
					function: node,
					paramIndex: index,
					paramPath: path,
				});
			}
		});
		return inner;
	}

	function visitDeclare(node, parent, scope) {
		parentOf.set(node, parent);
		switch (node.type) {
			case "FunctionDeclaration": {
				if (node.id)
					declare(scope, node.id, "function", node, { function: node });
				const inner = newFunctionScope(node, scope);
				for (const param of node.params)
					visitChildrenOfPattern(param, node, inner);
				for (const statement of node.body.body)
					visitDeclare(statement, node.body, inner);
				parentOf.set(node.body, node);
				return;
			}
			case "FunctionExpression":
			case "ArrowFunctionExpression": {
				const inner = newFunctionScope(node, scope);
				for (const param of node.params)
					visitChildrenOfPattern(param, node, inner);
				if (node.body.type === "BlockStatement") {
					parentOf.set(node.body, node);
					for (const statement of node.body.body)
						visitDeclare(statement, node.body, inner);
				} else {
					visitDeclare(node.body, node, inner);
				}
				return;
			}
			case "ClassDeclaration":
				if (node.id) declare(scope, node.id, "class", node);
				break;
			case "VariableDeclaration": {
				const target = node.kind === "var" ? scope.functionScope() : scope;
				for (const declarator of node.declarations) {
					parentOf.set(declarator, node);
					for (const { id, path } of patternNames(declarator.id)) {
						declare(target, id, node.kind, declarator, {
							init: declarator.init,
							initPath: path,
						});
					}
					visitChildrenOfPattern(declarator.id, declarator, scope);
					if (declarator.init) visitDeclare(declarator.init, declarator, scope);
				}
				return;
			}
			case "ImportDeclaration":
				for (const specifier of node.specifiers) {
					parentOf.set(specifier, node);
					declare(scope, specifier.local, "import", node, { specifier });
				}
				return;
			case "CatchClause": {
				const inner = new Scope(node, scope, false);
				scopeOf.set(node, inner);
				if (node.param)
					for (const { id } of patternNames(node.param))
						declare(inner, id, "catch", node);
				parentOf.set(node.body, node);
				for (const statement of node.body.body)
					visitDeclare(statement, node.body, inner);
				return;
			}
			case "BlockStatement":
			case "ForStatement":
			case "ForInStatement":
			case "ForOfStatement":
			case "SwitchStatement":
			case "StaticBlock": {
				const inner = new Scope(node, scope, false);
				scopeOf.set(node, inner);
				for (const [, child] of childNodes(node))
					visitDeclare(child, node, inner);
				return;
			}
			default:
				break;
		}
		for (const [, child] of childNodes(node)) visitDeclare(child, node, scope);
	}

	function visitChildrenOfPattern(pattern, parent, scope) {
		// Default values and computed keys in a pattern are expressions.
		parentOf.set(pattern, parent);
		for (const [key, child] of childNodes(pattern)) {
			if (pattern.type === "AssignmentPattern" && key === "right")
				visitDeclare(child, pattern, scope);
			else if (pattern.type === "Property" && key === "key" && pattern.computed)
				visitDeclare(child, pattern, scope);
			else visitChildrenOfPattern(child, pattern, scope);
		}
	}

	for (const statement of program.body)
		visitDeclare(statement, program, moduleScope);

	// Pass 2: resolve every identifier in a reference position.
	function resolve(node, scope) {
		const own = scopeOf.get(node);
		const here = own ?? scope;
		switch (node.type) {
			case "Identifier": {
				if (declared.has(node)) return;
				const binding = here.lookup(node.name);
				referenceOf.set(node, binding);
				if (binding) binding.references.push(node);
				return;
			}
			case "MemberExpression":
				resolve(node.object, here);
				if (node.computed) resolve(node.property, here);
				return;
			case "Property":
			case "MethodDefinition":
			case "PropertyDefinition":
				if (node.computed) resolve(node.key, here);
				if (node.value) resolve(node.value, here);
				return;
			case "LabeledStatement":
				resolve(node.body, here);
				return;
			case "BreakStatement":
			case "ContinueStatement":
			case "MetaProperty":
				return;
			case "ExportNamedDeclaration":
				if (node.declaration) resolve(node.declaration, here);
				if (!node.source)
					for (const specifier of node.specifiers)
						resolve(specifier.local, here);
				return;
			case "ImportDeclaration":
				return;
			default:
				for (const [, child] of childNodes(node)) resolve(child, here);
		}
	}
	resolve(program, scopeOf.get(program));

	return { scopeOf, parentOf, referenceOf, bindings };
}

/** The function a binding holds, when it is bound to one. */
export function functionOf(binding) {
	if (!binding) return null;
	if (binding.kind === "function" || binding.kind === "function-name")
		return binding.function;
	if (binding.init && isFunction(binding.init) && binding.initPath.length === 0)
		return binding.init;
	return null;
}

/** The source text of a node. */
export function text(source, node) {
	return source.slice(node.start, node.end);
}

/** A node's static property name: `a.b` gives "b", `a["b"]` gives "b", otherwise null. */
export function propertyName(member) {
	if (member.type !== "MemberExpression") return null;
	if (!member.computed && member.property.type === "Identifier")
		return member.property.name;
	if (member.computed && member.property.type === "Literal")
		return typeof member.property.value === "string"
			? member.property.value
			: null;
	return null;
}

/** Every node of a tree, each with its parent. */
export function* walk(node, parent = null) {
	yield [node, parent];
	for (const [, child] of childNodes(node)) yield* walk(child, node);
}
