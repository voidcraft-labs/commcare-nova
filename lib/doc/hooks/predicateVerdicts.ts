/**
 * Client-safe predicate authoring verdicts exposed at the document boundary.
 * Builder code asks whether a case-search edit is admissible without importing
 * validator or wire-emission internals directly.
 */
export {
	caseSearchPredicateEditVerdict,
	caseSearchPredicateVerdict,
	type PredicateEditVerdict,
} from "../commitVerdicts";
