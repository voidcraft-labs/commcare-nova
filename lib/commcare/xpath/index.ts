// lib/commcare/xpath/index.ts
//
// XPath grammar + Lezer-generated parser for CommCare's XPath dialect.
// Lives inside lib/commcare/ because XPath is the expression dialect
// that CommCare defines; the package's "one-way emission boundary" rule
// is scoped to wire-format emission (XForm XML, HqApplication JSON),
// not to shared parsing infrastructure that other layers legitimately
// need to read (transpiler, preview evaluator, hashtag rewriter, etc.).
//
// Grammar source is compiled ahead-of-time into parser.ts +
// parser.terms.ts (committed; regenerate via
// scripts/build-xpath-parser.ts when the grammar changes). Consumers
// outside lib/commcare/ import from this barrel only.

export { parser } from "./parser";
export * from "./parser.terms";
