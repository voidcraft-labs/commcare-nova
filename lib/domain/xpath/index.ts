// lib/domain/xpath — the stored XPath expression AST.
//
// Shape + printer + structural walks live here (the field/form schemas
// store this shape, and `lib/domain` cannot import `lib/commcare`).
// The parser half of the round-trip pair — which needs the Lezer
// grammar — is `lib/commcare/xpath/expressionAst.ts`.

export * from "./ast";
export * from "./print";
export * from "./resolve";
export * from "./walk";
