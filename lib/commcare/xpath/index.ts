// lib/commcare/xpath/index.ts
//
// Public barrel for CommCare's XPath dialect: the Lezer-generated parser,
// proven production JavaRosa lowering.
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
	analyzeXPathCompatibility,
	analyzeXPathInstanceCompatibility,
	type XPathCompatibilityCode,
	type XPathCompatibilityFinding,
	type XPathCompatibilityOwner,
} from "./compatibility";
export { detectUnquotedStringLiteral } from "./detectUnquotedStringLiteral";
export {
	parseXPathExpression,
	parseXPathExpressionWithIssues,
	type ResolveFieldPath,
	type ResolveSearchInputName,
	type ResolveUserPropertySlug,
	type XPathParseIssue,
	type XPathParseResult,
} from "./expressionAst";
export { lowerXPathForJavaRosa } from "./javaRosaLowering";
export { parser } from "./parser";
export * from "./parser.terms";
export { xpathStringLiteral } from "./stringLiteral";
