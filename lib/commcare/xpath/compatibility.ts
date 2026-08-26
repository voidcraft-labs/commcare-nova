import type { SyntaxNode } from "@lezer/common";
import { FUNCTION_REGISTRY } from "../validator/functionRegistry";
import type { XPathCarrierProfile } from "./carriers";
import {
	inspectXPathFunctionCalls,
	pathInitializerStringArgument,
} from "./functionCapabilities";
import { parser } from "./parser";

export type XPathCompatibilityCode =
	| "XPATH_PARSE_ERROR"
	| "XPATH_UNBOUND_VARIABLE"
	| "XPATH_UNSUPPORTED_UNION"
	| "XPATH_UNSUPPORTED_DESCENDANT"
	| "XPATH_UNSUPPORTED_FILTER"
	| "XPATH_UNSUPPORTED_AXIS"
	| "XPATH_UNSUPPORTED_NODE_TEST"
	| "XPATH_UNSUPPORTED_PATH"
	| "XPATH_CARRIER_CONTEXT_UNAVAILABLE"
	| "XPATH_FUNCTION_UNAVAILABLE"
	| "XPATH_FUNCTION_SIGNATURE_UNAVAILABLE"
	| "XPATH_FUNCTION_CONTEXT_UNAVAILABLE"
	| "XPATH_INSTANCE_UNAVAILABLE";

export type XPathCompatibilityOwner = "java-rosa" | "preview";

export interface XPathCompatibilityFinding {
	readonly code: XPathCompatibilityCode;
	readonly severity: "error";
	readonly owner: XPathCompatibilityOwner;
	/** Constant diagnostic prose. It never contains authored source text. */
	readonly detail: string;
	readonly position?: number;
}

const DETAILS: Record<XPathCompatibilityCode, string> = {
	XPATH_PARSE_ERROR: "The expression is not valid JavaRosa XPath syntax.",
	XPATH_UNBOUND_VARIABLE:
		"This carrier does not provide a JavaRosa variable binding context.",
	XPATH_UNSUPPORTED_UNION:
		"JavaRosa parses union expressions but cannot execute them.",
	XPATH_UNSUPPORTED_DESCENDANT:
		"JavaRosa parses descendant paths but cannot execute them.",
	XPATH_UNSUPPORTED_FILTER:
		"JavaRosa can execute step predicates, but not general filter expressions.",
	XPATH_UNSUPPORTED_AXIS: "This path axis is not executable by JavaRosa.",
	XPATH_UNSUPPORTED_NODE_TEST:
		"This path node test is not executable by JavaRosa.",
	XPATH_UNSUPPORTED_PATH: "This path shape is not executable by JavaRosa.",
	XPATH_CARRIER_CONTEXT_UNAVAILABLE:
		"The owning carrier does not provide the main evaluation context this expression needs.",
	XPATH_FUNCTION_UNAVAILABLE:
		"The owning runtime does not implement this function.",
	XPATH_FUNCTION_SIGNATURE_UNAVAILABLE:
		"The owning runtime does not implement this function signature.",
	XPATH_FUNCTION_CONTEXT_UNAVAILABLE:
		"The owning runtime cannot execute this function in this context.",
	XPATH_INSTANCE_UNAVAILABLE:
		"This carrier does not declare the referenced secondary instance.",
};

function registrySignatureIsInvalid(
	name: string,
	argumentCount: number,
): boolean {
	const spec = FUNCTION_REGISTRY.get(name);
	if (spec === undefined) return false;
	if (spec.validate?.(argumentCount) !== undefined) return true;
	return (
		argumentCount < spec.minArgs ||
		(spec.maxArgs !== -1 && argumentCount > spec.maxArgs)
	);
}

const STRUCTURAL_TOKENS = new Set([
	"(",
	")",
	"[",
	"]",
	"/",
	"//",
	"@",
	"::",
	",",
]);

function firstSemanticChild(node: SyntaxNode): SyntaxNode | null {
	let child = node.firstChild;
	while (child && STRUCTURAL_TOKENS.has(child.name)) child = child.nextSibling;
	return child;
}

function semanticChildren(node: SyntaxNode): SyntaxNode[] {
	const children: SyntaxNode[] = [];
	let child = node.firstChild;
	while (child) {
		if (!STRUCTURAL_TOKENS.has(child.name)) children.push(child);
		child = child.nextSibling;
	}
	return children;
}

function isNameOrWildcard(node: SyntaxNode | null): boolean {
	if (node?.name !== "NameTest") return false;
	return node.getChild("QualifiedWildcard") === null;
}

function isNamedAttribute(node: SyntaxNode | null): boolean {
	if (node?.name !== "NameTest") return false;
	return (
		node.getChild("Wildcard") === null &&
		node.getChild("QualifiedWildcard") === null
	);
}

function functionName(node: SyntaxNode, source: string): string | undefined {
	const name = node.getChild("FunctionName");
	return name ? source.slice(name.from, name.to) : undefined;
}

function isNodeTest(node: SyntaxNode | null, source: string): boolean {
	if (node?.name !== "Invoke" || functionName(node, source) !== "node") {
		return false;
	}
	const args = node.getChild("ArgumentList");
	return args !== null && semanticChildren(args).length === 0;
}

function specifiedAxisName(
	node: SyntaxNode,
	source: string,
): string | undefined {
	if (node.name !== "AxisSpecified") return undefined;
	const axis = node.getChild("AxisName");
	return axis === null ? undefined : source.slice(axis.from, axis.to);
}

function isParentStep(node: SyntaxNode, source: string): boolean {
	return (
		node.name === "ParentStep" || specifiedAxisName(node, source) === "parent"
	);
}

function preservesParentAccess(
	node: SyntaxNode,
	index: number,
	source: string,
): boolean {
	if (node.name === "ParentStep" || node.name === "SelfStep") return true;
	const axisName = specifiedAxisName(node, source);
	if (axisName === "parent" || axisName === "self") {
		return true;
	}
	return (
		index === 0 &&
		node.name === "Invoke" &&
		(functionName(node, source) === "current" ||
			functionName(node, source) === "instance")
	);
}

function isLocationPathBase(node: SyntaxNode | null): boolean {
	return (
		node !== null &&
		[
			"NameTest",
			"SelfStep",
			"ParentStep",
			"AttrSpecified",
			"AxisSpecified",
			"Child",
			"Descendant",
			"Filtered",
			"HashtagRef",
			"RootPath",
		].includes(node.name)
	);
}

/** A filter predicate supplies its own row context even when the carrier's
 * outer evaluation context has no main instance. */
function isInsidePredicateContext(node: SyntaxNode): boolean {
	let parent = node.parent;
	while (parent !== null) {
		if (parent.name === "Filtered") {
			const base = firstSemanticChild(parent);
			if (base !== null && node.from >= base.to) return true;
		}
		parent = parent.parent;
	}
	return false;
}

function isNestedPathStep(node: SyntaxNode): boolean {
	return (
		node.parent?.name === "Child" ||
		node.parent?.name === "AttrSpecified" ||
		node.parent?.name === "AxisSpecified" ||
		node.parent?.name === "HashtagRef"
	);
}

function hasExplicitInstanceRoot(node: SyntaxNode, source: string): boolean {
	if (node.name === "Invoke") return functionName(node, source) === "instance";
	if (node.name === "Filtered") {
		const base = firstSemanticChild(node);
		return base !== null && hasExplicitInstanceRoot(base, source);
	}
	if (node.name !== "Child") return false;
	const path = flattenedChildSteps(node, source);
	return path !== null && hasExplicitInstanceRoot(path.steps[0], source);
}

function sessionPathNeedsMainContext(
	node: SyntaxNode,
	source: string,
): boolean {
	if (node.name === "HashtagRef") {
		return source.slice(node.from, node.to).startsWith("#form/");
	}
	if (node.name === "Child") {
		if (node.parent?.name === "Child") return false;
		const path = flattenedChildSteps(node, source);
		if (path === null || path.absolute) return true;
		if (isInsidePredicateContext(node)) return false;
		const root = path.steps[0];
		if (root.name === "HashtagRef") {
			return source.slice(root.from, root.to).startsWith("#form/");
		}
		return !hasExplicitInstanceRoot(root, source);
	}
	if (node.name === "RootPath") return true;
	if (isInsidePredicateContext(node)) return false;
	return (
		!isNestedPathStep(node) &&
		[
			"NameTest",
			"SelfStep",
			"ParentStep",
			"AttrSpecified",
			"AxisSpecified",
		].includes(node.name)
	);
}

interface FlatPath {
	readonly absolute: boolean;
	readonly steps: readonly SyntaxNode[];
}

function flattenedChildSteps(
	node: SyntaxNode,
	source: string,
): FlatPath | null {
	if (node.name !== "Child") return { absolute: false, steps: [node] };
	const parts = semanticChildren(node);
	if (
		parts.length === 1 &&
		source.slice(node.from, parts[0].from).includes("/")
	) {
		return { absolute: true, steps: [parts[0]] };
	}
	if (parts.length !== 2) return null;
	const left = flattenedChildSteps(parts[0], source);
	if (!left) return null;
	return { absolute: left.absolute, steps: [...left.steps, parts[1]] };
}

/**
 * Classify syntax that JavaRosa's parser accepts but its executable reference
 * model cannot evaluate. This is deliberately a source-only check: it does not
 * inspect authored values, the document, or runtime data.
 */
export function analyzeXPathCompatibility(
	source: string,
	profile: XPathCarrierProfile,
): readonly XPathCompatibilityFinding[] {
	if (!source) return [];

	const findings: XPathCompatibilityFinding[] = [];
	const seen = new Set<string>();
	const add = (
		code: XPathCompatibilityCode,
		position: number,
		owner: XPathCompatibilityOwner = "java-rosa",
	): void => {
		const key = `${code}:${owner}:${position}`;
		if (seen.has(key)) return;
		seen.add(key);
		findings.push({
			code,
			severity: "error",
			owner,
			detail: DETAILS[code],
			position,
		});
	};

	const tree = parser.parse(source);
	tree.iterate({
		enter(cursor) {
			const node = cursor.node;
			if (
				profile === "preview-session" &&
				sessionPathNeedsMainContext(node, source)
			) {
				add("XPATH_CARRIER_CONTEXT_UNAVAILABLE", node.from);
			}
			switch (node.name) {
				case "⚠":
					add("XPATH_PARSE_ERROR", node.from);
					break;
				case "VariableReference":
					add(
						"XPATH_UNBOUND_VARIABLE",
						node.from,
						profile.startsWith("preview-") ? "preview" : "java-rosa",
					);
					break;
				case "UnionExpr":
					add("XPATH_UNSUPPORTED_UNION", node.from);
					break;
				case "Descendant":
					add("XPATH_UNSUPPORTED_DESCENDANT", node.from);
					break;
				case "Filtered": {
					if (
						source.charCodeAt(node.from) === 40 ||
						!isLocationPathBase(firstSemanticChild(node))
					) {
						add("XPATH_UNSUPPORTED_FILTER", node.from);
					}
					break;
				}
				case "AttrSpecified": {
					if (!isNamedAttribute(firstSemanticChild(node))) {
						add("XPATH_UNSUPPORTED_NODE_TEST", node.from);
					}
					break;
				}
				case "NameTest": {
					if (
						node.getChild("QualifiedWildcard") &&
						node.parent?.name !== "AxisSpecified" &&
						node.parent?.name !== "AttrSpecified"
					) {
						add("XPATH_UNSUPPORTED_NODE_TEST", node.from);
					}
					break;
				}
				case "AxisSpecified": {
					const test =
						node.getChild("NameTest") ?? node.getChild("Invoke") ?? null;
					const axisName = specifiedAxisName(node, source) ?? "";
					const supported =
						(axisName === "child" && isNameOrWildcard(test)) ||
						(axisName === "attribute" && isNamedAttribute(test)) ||
						((axisName === "self" || axisName === "parent") &&
							isNodeTest(test, source));
					if (!supported) {
						const supportedAxis = [
							"child",
							"attribute",
							"self",
							"parent",
						].includes(axisName);
						add(
							supportedAxis
								? "XPATH_UNSUPPORTED_NODE_TEST"
								: "XPATH_UNSUPPORTED_AXIS",
							node.from,
						);
					}
					break;
				}
				case "Child": {
					const path = flattenedChildSteps(node, source);
					if (!path) break;
					const root = path.steps[0];
					const initializer = functionName(root, source);
					if (
						root.name === "Invoke" &&
						initializer !== "current" &&
						initializer !== "instance"
					) {
						add("XPATH_UNSUPPORTED_PATH", node.from);
					}
					let parentAccessDisabled = path.absolute;
					for (const [index, step] of path.steps.entries()) {
						if (isParentStep(step, source)) {
							if (parentAccessDisabled) {
								add("XPATH_UNSUPPORTED_PATH", step.from);
								break;
							}
						} else if (!preservesParentAccess(step, index, source)) {
							parentAccessDisabled = true;
						}
					}
					break;
				}
			}
		},
	});

	const previewOwned = profile.startsWith("preview-");
	for (const call of inspectXPathFunctionCalls(source)) {
		if (
			profile === "preview-session" &&
			(call.name === "current" ||
				(call.name === "position" &&
					call.argumentCount === 0 &&
					!isInsidePredicateContext(tree.resolve(call.from, 1))))
		) {
			add("XPATH_CARRIER_CONTEXT_UNAVAILABLE", call.from);
		}
		const signatureInvalid = registrySignatureIsInvalid(
			call.name,
			call.argumentCount,
		);
		if (
			call.javaRosa === "unsupported" ||
			call.javaRosa === "context-handler"
		) {
			add("XPATH_FUNCTION_UNAVAILABLE", call.from, "java-rosa");
		} else if (
			call.javaRosa === "path-initializer" &&
			!call.validPathInitializer
		) {
			add("XPATH_FUNCTION_CONTEXT_UNAVAILABLE", call.from, "java-rosa");
		} else if (signatureInvalid) {
			add("XPATH_FUNCTION_SIGNATURE_UNAVAILABLE", call.from, "java-rosa");
		}

		if (!previewOwned) continue;
		const admitted = FUNCTION_REGISTRY.has(call.name);
		if (!admitted) {
			add("XPATH_FUNCTION_UNAVAILABLE", call.from, "preview");
		} else if (signatureInvalid) {
			add("XPATH_FUNCTION_SIGNATURE_UNAVAILABLE", call.from, "preview");
		} else if (
			call.javaRosa === "path-initializer" &&
			!call.validPathInitializer
		) {
			add("XPATH_FUNCTION_CONTEXT_UNAVAILABLE", call.from, "preview");
		}
	}

	return findings;
}

/** Document-aware secondary-instance admission. The source-only analyzer
 * cannot decide lookup fixture identities because those names come from the
 * Project's current lookup-definition snapshot. */
export function analyzeXPathInstanceCompatibility(
	source: string,
	profile: XPathCarrierProfile,
	allowedInstanceIds: ReadonlySet<string>,
): readonly XPathCompatibilityFinding[] {
	if (!source) return [];
	const findings: XPathCompatibilityFinding[] = [];
	const tree = parser.parse(source);
	tree.iterate({
		enter(cursor) {
			if (cursor.node.name !== "Invoke") return;
			const name = functionName(cursor.node, source);
			if (name !== "instance") return;
			const id = pathInitializerStringArgument(cursor.node, source);
			if (id === undefined || allowedInstanceIds.has(id)) return;
			findings.push({
				code: "XPATH_INSTANCE_UNAVAILABLE",
				severity: "error",
				owner: profile.startsWith("preview-") ? "preview" : "java-rosa",
				detail: DETAILS.XPATH_INSTANCE_UNAVAILABLE,
				position: cursor.node.from,
			});
		},
	});
	return findings;
}
