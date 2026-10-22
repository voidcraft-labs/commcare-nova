// lib/commcare/xpath/index.ts
//
// Public barrel for CommCare's XPath dialect: the form-expression parser,
// Lezer-generated parser, resolved wire tree and canonical serializer.
//
// Lives inside lib/commcare/ because XPath is the expression dialect
// that CommCare defines; the package's "one-way emission boundary" rule
// is scoped to wire-format emission (XForm XML, HqApplication JSON),
// not to shared parsing infrastructure that other layers legitimately
// need to read (validator, Preview evaluator, hashtag rewriter, etc.).
//
// Grammar source is compiled ahead-of-time into parser.ts +
// parser.terms.ts (committed; regenerate via
// scripts/build-xpath-parser.ts when the grammar changes). Consumers
// outside lib/commcare/ import from this barrel only.
//

export {
	type FormParseIssue,
	type FormParseIssueCode,
	type FormParseResult,
	type FormParseScope,
	parseFormExpression,
	type ResolveFieldPath,
} from "./expressionAst";
export { parser } from "./parser";
export * from "./parser.terms";
export { w } from "./wire/builders";
export {
	caseDbInstance,
	type InstanceDecl,
	InstanceSink,
	locationsInstance,
	lookupInstance,
	resultsInstance,
	searchInputInstance,
	selectedCasesInstance,
	sessionInstance,
} from "./wire/instances";
export { serializeWire } from "./wire/serialize";
export type {
	NonShadowWireMode,
	SerializedWire,
	WireArithmetic,
	WireComparison,
	WireExpr,
	WireFunction,
	WireMode,
	WirePath,
	WireRoot,
	WireStep,
} from "./wire/tree";
