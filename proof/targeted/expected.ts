/**
 * A targeted document's hand-fixed intent values (`expected.json`), in the
 * shape the intent observation runs and its judge holds Core to
 * (`proof/observe/intent.py::expectations`, `proof/checks/intent.py::value_differences`).
 *
 * Each expectation names an export (`local`, or `A` or `B` for HQ's build
 * under a configuration, `minimum` unless it names one), a form of the
 * document by its Nova uuid, the request Core's `evaluate` op runs there
 * (`proof/core/src/nova/proof/core/Evaluate.java`), and the values Core must
 * give, each at a JSON Pointer into Core's result. Every value is fixed by
 * hand from what the document authors, never read from Nova's emitter or its
 * evaluator.
 */

import type { Uuid } from "@/lib/domain";

/** An answer or a constraint check: a data path in the form, and a value as Web Apps sends it. */
export interface PathValue {
	readonly path: string;
	readonly value: string;
}

/** What Core's evaluate runs (`proof/observe/intent.py::REQUEST_KEYS`). */
export interface EvaluateRequest {
	readonly answers?: readonly PathValue[];
	readonly constraintChecks?: readonly PathValue[];
	readonly expressions?: readonly string[];
	readonly instances?: readonly string[];
	/** Rows to add at each repeat, by its generic path. */
	readonly repeats?: Readonly<Record<string, number>>;
	readonly session?: {
		readonly command?: string;
		readonly data?: Readonly<Record<string, string>>;
	};
	/** A case list on the installed local archive: its search text and sort column. */
	readonly caseList?: {
		readonly searchText?: string;
		readonly sortIndex?: number;
		readonly fuzzy?: boolean;
	};
	readonly locale?: string;
	readonly clock?: string;
}

/** One value Core must give: where in its result, and what. */
export interface ExpectedValue {
	readonly pointer: string;
	readonly value: unknown;
}

export interface Expectation {
	readonly id: string;
	readonly export: "local" | "A" | "B";
	readonly configuration?: string;
	readonly form: Uuid;
	/** A file in the document's directory holding the restore Core runs over. */
	readonly restore?: string;
	readonly request: EvaluateRequest;
	readonly expect: readonly ExpectedValue[];
}

export interface Expected {
	readonly intent: readonly Expectation[];
}
