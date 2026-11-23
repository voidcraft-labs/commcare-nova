import { isValidCalendarDate } from "@/lib/domain/calendarDate";
import {
	type CaseSearchCriterion,
	type CaseSearchParameter,
	CaseSearchUnavailableError,
} from "./searchRequest";

export interface ResolvedSearchConfiguration {
	readonly revision: string;
	readonly timeZone: string | null;
	readonly maximum: 500 | 1500 | null;
	readonly projectSpace: string | undefined;
	matcherFor(key: string): SearchMatcherFacts | null;
}
export interface SearchMatcherFacts {
	readonly fuzzy: boolean;
	readonly ignoreLiterals: readonly string[];
}

/** Resolve native request keys after the authorized target's settings have
 * been loaded. Argument errors arise at HQ's request, even on an empty store.
 * Unknown index membership is decided per eligible row in SQL instead. */
export function resolveNativeSearchCriteria(
	parameters: readonly CaseSearchParameter[],
	matchers: (key: string) => SearchMatcherFacts | null,
	projectSpace: string | undefined,
): CaseSearchCriterion[] {
	const out: CaseSearchCriterion[] = [];
	for (const parameter of parameters) {
		const { field, key, target, values } = parameter;
		if (values.length === 0) continue;
		const invalid = () =>
			new CaseSearchUnavailableError({ kind: "query-value-invalid", field });
		const hasRange = values.some((value) => value.startsWith("__range__"));
		const rangePrefix = /^__range__(\d{4}-\d{2}-\d{2})__(\d{4}-\d{2}-\d{2})/;
		// SearchCriteria validates the shape before the special key handlers
		// see the original values. Only a property range interprets the dates.
		if (
			hasRange &&
			(values.length > 2 ||
				values.some((value) => value !== "" && !rangePrefix.test(value)))
		)
			throw invalid();
		if (target.kind === "owner" && values.length > 1) throw invalid();
		if (
			target.kind === "record-id" ||
			target.kind === "owner" ||
			target.kind === "project-space"
		) {
			out.push({ kind: "native", parameter, fuzzy: false, projectSpace });
			continue;
		}
		const multiBlank = values.length > 1 && values.includes("");
		const nonblank = multiBlank ? values.filter((v) => v !== "") : values;
		if (multiBlank && nonblank.length === 0) {
			out.push({ kind: "missing-property", key });
			continue;
		}
		if (target.kind === "link" && !nonblank.some(Boolean)) {
			out.push({
				kind: "index",
				field,
				identifier: target.identifier,
				values,
				...(multiBlank && { blankPropertyKey: key }),
			});
			continue;
		}
		if (hasRange) {
			const range = rangePrefix.exec(nonblank[0]);
			if (
				nonblank.length !== 1 ||
				!range ||
				range[0] !== nonblank[0] ||
				!isValidCalendarDate(range[1]) ||
				!isValidCalendarDate(range[2])
			)
				throw invalid();
			out.push({
				kind: "native-range",
				field,
				key,
				start: range[1],
				end: range[2],
				...(multiBlank && { blankTarget: target }),
			});
			continue;
		}
		const facts = nonblank.some(Boolean)
			? matchers(key)
			: { fuzzy: false, ignoreLiterals: [] };
		if (!facts) {
			out.push({
				kind: "unavailable",
				reason: { kind: "matcher-settings-unavailable", field },
			});
			continue;
		}
		if (facts.fuzzy && nonblank.length > 1) throw invalid();
		const stripped = nonblank.map((v) =>
			facts.ignoreLiterals.reduce(
				(text, literal) => text.replaceAll(literal, ""),
				v,
			),
		);
		// HQ constructs CSQL for the ancestor. A scalar is a double-quoted
		// string, while an array is JSON embedded in a single-quoted string.
		if (
			"ancestors" in target &&
			target.ancestors &&
			(stripped.length === 1
				? stripped[0]?.includes('"')
				: stripped.some((v) => v.includes("'")))
		)
			throw invalid();
		if (
			target.kind === "attribute" &&
			target.attribute === "id" &&
			target.ancestors
		) {
			// HQ's ancestor @case_id equality walks reverse links directly,
			// including cleared ids. It never looks up a case whose id is "".
			const path = target.ancestors.map((step) => step.identifier);
			out.push({
				kind: "index",
				field,
				identifier: path[path.length - 1],
				ancestors: path.slice(0, -1),
				values: multiBlank ? [...stripped, ""] : stripped,
			});
			continue;
		}
		if (target.kind === "link") {
			out.push({
				kind: "index",
				field,
				identifier: target.identifier,
				values: stripped,
				...(multiBlank && { blankPropertyKey: key }),
			});
			continue;
		}
		out.push({
			kind: "native",
			parameter: {
				...parameter,
				values: multiBlank ? [...stripped, ""] : stripped,
			},
			fuzzy: facts.fuzzy,
		});
	}
	return out;
}
