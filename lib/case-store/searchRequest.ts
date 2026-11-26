import type { Expression } from "@/lib/domain/expression";
import type { SearchFilterTarget } from "@/lib/domain/modules";

export interface SearchConfigurationSelection {
	readonly target?:
		| { kind: "local" }
		| {
				kind: "destination";
				server: "production" | "india" | "eu";
				domain: string;
		  };
	readonly revision?: string;
}

/** A submitted worker request. The ordinary record workspace and the
 * question about what is outside a worker's restore have no result cap. */
export interface CaseSearchRequest {
	readonly maximum: 500 | 1500 | null;
	readonly parameters?: readonly CaseSearchParameter[];
	/** The fields whose prompts a default search leaves out of the request:
	 *  Core skips every prompt answer on the menu's default search
	 *  (`RemoteQuerySessionManager.getRawQueryParams(skipDefaultPromptValues)`,
	 *  which Formplayer's `MenuSessionRunnerService.doQuery` calls with
	 *  `isDefaultSearch`), so no starting value narrows it by matching the
	 *  field's own property. The search-input instance still holds every
	 *  starting value, which a `_xpath_query` row and a hidden value read. */
	readonly unsentPrompts?: readonly string[];
	/** The relationship paths the requested types' Search details ask HQ to deliver. */
	readonly relatedPaths?: readonly (readonly string[])[];
	/** Additional types searched by the server, including request-only records. */
	readonly additionalRequestTypes?: readonly string[];
	readonly relatedRecordProperty?: string;
	readonly relatedChildTypes?: readonly string[];
	readonly includeRelatedHierarchy?: boolean;
	readonly configuration?: SearchConfigurationSelection;
	/** Independent of the detail's sort. Exact indexed strings use binary
	 * ordering, with missing first ascending and last descending. Each key is
	 * the name HQ's search index holds the value under (`@status` is the
	 * record's open or closed state, `status` a saved property). */
	readonly order?: readonly {
		readonly key: string;
		readonly type: "text" | "number" | "date";
		readonly direction: "asc" | "desc";
	}[];
	readonly criteria?: readonly CaseSearchCriterion[];
	readonly readsHitScore?: boolean;
	/** A consumer that observes the server's order (e.g. the first matching
	 * case) cannot substitute a local order, even below the result cap. */
	readonly readsHitOrder?: boolean;
	/** Inline selections read the result instance after the server cutoff. */
	readonly resultCondition?: Expression;
}

/** Values sent under the same request key are matched together, in source order. */
export interface CaseSearchParameter {
	readonly field: string;
	readonly target: Exclude<
		SearchFilterTarget,
		{ kind: "include-related-records" }
	>;
	readonly key: string;
	readonly readsAnswers?: boolean;
	readonly parentPathPrompt?: true;
	readonly values: readonly string[];
}

export type NativeSearchUnavailableReason =
	| {
			readonly kind:
				| "matcher-settings-unavailable"
				| "project-space-unavailable"
				| "indexed-value-unavailable"
				| "search-range-unavailable"
				| "query-value-invalid"
				| "parent-value-unavailable"
				| "parent-fuzzy-unavailable"
				| "parent-lookup-limit";
			readonly field: string;
	  }
	| {
			readonly kind:
				| "result-limit-unavailable"
				| "search-settings-changed"
				| "project-zone-unavailable";
	  };

export type CaseSearchCriterion =
	| {
			readonly kind: "search-condition";
			readonly expression: Expression;
			readonly reason: SearchUnavailableReason;
	  }
	| {
			readonly kind: "native-range";
			readonly field: string;
			readonly key: string;
			readonly start: string;
			readonly end: string;
			readonly blankTarget?: SearchFilterTarget;
	  }
	| { readonly kind: "missing-property"; readonly key: string }
	| {
			readonly kind: "native";
			readonly parameter: CaseSearchParameter;
			readonly fuzzy: boolean;
			readonly projectSpace?: string;
	  }
	| {
			readonly kind: "unavailable";
			readonly reason: NativeSearchUnavailableReason;
	  }
	| {
			readonly kind: "index";
			readonly field: string;
			readonly identifier: string;
			/** Earlier links on the path to the case carrying this index. */
			readonly ancestors?: readonly string[];
			/** A single blank is the retained clear. A blank in a multi-value
			 * request takes the native ordinary-property-missing branch. */
			readonly values: readonly string[];
			readonly blankInMultiple?: Expression;
			readonly blankPropertyKey?: string;
	  }
	| {
			readonly kind: "fuzzy";
			readonly field: string;
			/** Independently established exact-token matches survive expansion.
			 * Other potentially matching terms depend on the index vocabulary. */
			readonly definiteMatch?: Expression;
			readonly definiteMiss?: Expression;
	  };

export type SearchUnavailableReason =
	| NativeSearchUnavailableReason
	| {
			readonly kind: "link-history-unavailable";
			readonly field: string;
			readonly identifier: string;
	  }
	| {
			readonly kind: "fuzzy-expansion-unavailable" | "fuzzy-text-unavailable";
			readonly field: string;
	  }
	| {
			readonly kind:
				| "cutoff-order-unavailable"
				| "hit-score-unavailable"
				| "hit-order-unavailable";
	  };

export class CaseSearchUnavailableError extends Error {
	constructor(readonly reason: SearchUnavailableReason) {
		super(searchUnavailableMessage(reason));
		this.name = "CaseSearchUnavailableError";
	}
}

export function searchUnavailableMessage(
	reason: SearchUnavailableReason,
): string {
	switch (reason.kind) {
		case "matcher-settings-unavailable":
			return `Confirm how the project space matches “${reason.field}” in Preview search settings.`;
		case "project-space-unavailable":
			return "Choose the project space for this search in Preview search settings.";
		case "indexed-value-unavailable":
			return `This search needs the indexed value of “${reason.field}” from the project space.`;
		case "search-range-unavailable":
			return `This search needs the indexed date range for “${reason.field}”.`;
		case "parent-value-unavailable":
			return `Preview needs the records on the parent path to match “${reason.field}”.`;
		case "parent-fuzzy-unavailable":
			return `Only CommCare HQ can match similar words for the parent property “${reason.field}” in this search.`;
		case "parent-lookup-limit":
			return `“${reason.field}” matches too many related records. Try a more specific search.`;
		case "query-value-invalid":
			return `The project space cannot search with this combination of values for “${reason.field}”.`;
		case "project-zone-unavailable":
			return "Confirm the project space’s time zone in Preview search settings to run this search.";
		case "result-limit-unavailable":
			return "Confirm how many results this project space returns in Preview search settings.";
		case "search-settings-changed":
			return "Preview search settings changed. Run the search again to use the current settings.";
		case "link-history-unavailable":
			return "This search needs earlier record-link history that Nova doesn’t have.";
		case "fuzzy-expansion-unavailable":
			return `Over 100 saved words are close to what was typed for “${reason.field}”, and CommCare checks only 100 of them, so Preview can’t tell which records it would find. A longer or more exact search lets you preview it.`;
		case "fuzzy-text-unavailable":
			return `Preview can’t compare some letters in this search for “${reason.field}” the way CommCare does, so it can’t tell which records CommCare would find. Typing the search in lowercase often lets you preview it.`;
		case "cutoff-order-unavailable":
			return "Matching records share the last available result. A narrower search or a search order that separates those records lets you preview it.";
		case "hit-score-unavailable":
			return "These results show match scores that only the project space can supply.";
		case "hit-order-unavailable":
			return "This step uses the order of matching records. A search order that separates those records lets you preview it.";
	}
}
