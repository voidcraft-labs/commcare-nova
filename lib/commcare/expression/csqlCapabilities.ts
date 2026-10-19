/**
 * Pure CSQL value-expression capability classification: the values CCHQ's
 * search language evaluates itself. The one predicate lives beside the walk
 * the checker shares (`lib/domain/expression/searchRuntimeValues.ts`), a
 * dependency-light leaf, so client-side authoring validation loads no wire
 * emitter it never executes.
 */
export { isServerSearchValue as isNativeCsqlValueExpression } from "@/lib/domain/expression/searchRuntimeValues";
