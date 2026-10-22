export type FormParseIssueCode =
	| "syntax"
	| "unknown-function"
	| "arity"
	| "union"
	| "filter-root"
	| "axis"
	| "parent-after-name"
	| "wildcard"
	| "variable"
	| "instance-unknown"
	| "instance-argument"
	| "groups-held"
	| "form-root"
	| "unknown-field"
	| "ambiguous-field"
	| "relative-unknown"
	| "relative-above-form"
	| "relative-no-context"
	| "case-alias-unbound"
	| "case-query-untyped"
	| "case-row-attribute"
	| "row-step-after-value"
	| "row-leaves-record"
	| "unknown-hashtag"
	| "unknown-search-input"
	| "search-results-unexcluded"
	| "search-results-remote"
	| "unknown-table"
	| "table-path-mismatch"
	| "unknown-column"
	| "lookup-unavailable"
	| "unknown-level"
	| "unknown-location-property"
	| "unknown-datum"
	| "placeholder-datum"
	| "multi-select-datum-value"
	| "unknown-itext"
	| "choice-name-not-a-select";

export interface FormParseIssue {
	readonly code: FormParseIssueCode;
	readonly message: string;
	readonly from: number;
	readonly to: number;
	readonly suggestion?: string;
}
export class FormParseRefusal extends Error {
	constructor(readonly issues: readonly FormParseIssue[]) {
		super(issues.map((issue) => issue.message).join("\n"));
	}
}
export function refuse(
	code: FormParseIssueCode,
	node: { readonly from: number; readonly to: number },
	message: string,
	suggestion?: string,
): never {
	throw new FormParseRefusal([
		{
			code,
			from: node.from,
			to: node.to,
			message,
			...(suggestion === undefined ? {} : { suggestion }),
		},
	]);
}
