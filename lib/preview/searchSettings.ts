import { z } from "zod";
import { deploymentServerSchema } from "@/lib/deployment/types";
import {
	DEFAULT_SEARCH_RESULT_LIMIT,
	INCREASED_SEARCH_RESULT_LIMIT,
} from "@/lib/domain/searchLimits";

export const previewSearchTargetSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("local") }),
	z.strictObject({
		kind: z.literal("destination"),
		server: deploymentServerSchema,
		domain: z.string().min(1).max(255),
	}),
]);

export type PreviewSearchTarget = z.infer<typeof previewSearchTargetSchema>;

export function previewSearchTargetKey(target: PreviewSearchTarget): string {
	return target.kind === "local"
		? "local"
		: JSON.stringify([target.server, target.domain]);
}

export const searchTimeZoneSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((name) => {
		if (/^[+-]/.test(name)) return false;
		try {
			new Intl.DateTimeFormat("en", { timeZone: name });
			return true;
		} catch {
			return false;
		}
	}, "Choose an IANA time zone such as America/New_York.");

const propertyAddress = {
	caseType: z.string().min(1).max(256),
	property: z.string().min(1).max(256),
};

const propertyMatchingSchema = z.strictObject({
	fuzzyProperties: z
		.array(z.strictObject({ ...propertyAddress, fuzzy: z.boolean() }))
		.max(256)
		.refine(
			(rows) =>
				new Set(rows.map((row) => JSON.stringify([row.caseType, row.property])))
					.size === rows.length,
			"Choose one matching method for each record type and property.",
		),
	// HQ processes each literal in the order its configuration supplies it,
	// including repeated properties on types interleaved through that order.
	ignoredText: z
		.array(
			z.strictObject({
				...propertyAddress,
				literal: z.string().min(1).max(256),
			}),
		)
		.max(16384),
});

export const previewSearchValuesSchema = z.strictObject({
	maximum: z
		.union([
			z.literal(DEFAULT_SEARCH_RESULT_LIMIT),
			z.literal(INCREASED_SEARCH_RESULT_LIMIT),
		])
		.nullable(),
	timeZone: searchTimeZoneSchema.nullable(),
	propertyMatchers: propertyMatchingSchema.nullable(),
});
export type PreviewSearchValues = z.infer<typeof previewSearchValuesSchema>;

/** Null is an unobserved fact; an empty matcher list confirms exact matching. */
export interface PreviewSearchFacts {
	readonly maximum: PreviewSearchValues["maximum"];
	readonly timeZone: string | null;
	readonly propertyMatchers: PreviewSearchValues["propertyMatchers"];
	/** Present only when destinations disagree on their complete matcher lists.
	 * A criterion can still have the same rules on all of them. */
	readonly matcherAlternatives?: readonly PreviewSearchFacts["propertyMatchers"][];
	readonly projectSpace: string | undefined;
	readonly revision: string;
}

export const unconfirmedSearchValues: PreviewSearchValues = {
	maximum: null,
	timeZone: null,
	propertyMatchers: null,
};
export const localSearchDefaults: PreviewSearchValues = {
	maximum: DEFAULT_SEARCH_RESULT_LIMIT,
	timeZone: "UTC",
	propertyMatchers: { fuzzyProperties: [], ignoredText: [] },
};

export const previewSearchProfileSchema = z.strictObject({
	target: previewSearchTargetSchema,
	revision: z.string().regex(/^(0|[1-9][0-9]*)$/),
	values: previewSearchValuesSchema,
});
export type PreviewSearchProfile = z.infer<typeof previewSearchProfileSchema>;
export const previewSearchCatalogSchema = z.strictObject({
	projectId: z.string().min(1),
	profiles: z.array(previewSearchProfileSchema).min(1),
});
export type PreviewSearchCatalog = z.infer<typeof previewSearchCatalogSchema>;

/** The team can confirm the facts independently; an unselected destination
 * supplies only a fact all applicable destinations actually agree on. */
export function resolvePreviewSearchFacts(
	catalog: PreviewSearchCatalog | null,
	target?: PreviewSearchTarget,
): PreviewSearchFacts {
	const key = target && previewSearchTargetKey(target);
	const profiles = (catalog?.profiles ?? []).filter((profile) =>
		key === undefined
			? profile.target.kind !== "local"
			: previewSearchTargetKey(profile.target) === key,
	);
	const first = profiles[0];
	const values = first?.values ?? unconfirmedSearchValues;
	const projectSpace =
		first?.target.kind === "destination" ? first.target.domain : undefined;
	const matcherLists = profiles.map((p) => p.values.propertyMatchers);
	const sameMatchers = matcherLists.every(
		(list) => JSON.stringify(list) === JSON.stringify(values.propertyMatchers),
	);
	return {
		maximum: profiles.every((p) => p.values.maximum === values.maximum)
			? values.maximum
			: null,
		timeZone: profiles.every((p) => p.values.timeZone === values.timeZone)
			? values.timeZone
			: null,
		propertyMatchers: sameMatchers ? values.propertyMatchers : null,
		...(sameMatchers ? {} : { matcherAlternatives: matcherLists }),
		projectSpace: profiles.every(
			(p) =>
				p.target.kind === "destination" && p.target.domain === projectSpace,
		)
			? projectSpace
			: undefined,
		revision: JSON.stringify([
			catalog?.projectId ?? null,
			key ?? null,
			profiles.map((p) => [previewSearchTargetKey(p.target), p.revision]),
		]),
	};
}

/** The HQ query uses the rules for this request's property across the
 * REQUESTED types. Differences elsewhere do not change this criterion. */
export function previewSearchPropertyMatchers(
	facts: PreviewSearchFacts,
	requestedCaseTypes: readonly string[],
	property: string,
): {
	readonly fuzzy: boolean;
	readonly ignoreLiterals: readonly string[];
} | null {
	const candidates = facts.matcherAlternatives ?? [facts.propertyMatchers];
	const applies = (row: { caseType: string; property: string }) =>
		row.property === property && requestedCaseTypes.includes(row.caseType);
	const effective = candidates.map(
		(config) =>
			config && {
				fuzzy: config.fuzzyProperties.some((row) => row.fuzzy && applies(row)),
				ignoreLiterals: config.ignoredText
					.filter(applies)
					.map((row) => row.literal),
			},
	);
	const [first] = effective;
	return first &&
		effective.every(
			(matcher) =>
				matcher !== null &&
				matcher.fuzzy === first.fuzzy &&
				matcher.ignoreLiterals.length === first.ignoreLiterals.length &&
				matcher.ignoreLiterals.every(
					(literal, index) => literal === first.ignoreLiterals[index],
				),
		)
		? first
		: null;
}
