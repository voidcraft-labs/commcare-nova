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

const matcherSchema = z.strictObject({
	caseType: z.string().min(1).max(256),
	property: z.string().min(1).max(256),
	fuzzy: z.boolean(),
	ignoreLiterals: z.array(z.string().min(1).max(256)).max(64),
});

export const previewSearchValuesSchema = z
	.strictObject({
		maximum: z
			.union([
				z.literal(DEFAULT_SEARCH_RESULT_LIMIT),
				z.literal(INCREASED_SEARCH_RESULT_LIMIT),
			])
			.nullable(),
		timeZone: searchTimeZoneSchema.nullable(),
		propertyMatchers: z.array(matcherSchema).max(256).nullable(),
	})
	.refine(({ propertyMatchers }) => {
		const keys =
			propertyMatchers?.map((row) =>
				JSON.stringify([row.caseType, row.property]),
			) ?? [];
		return new Set(keys).size === keys.length;
	}, "Give each record type and property one matching rule.");

export type PreviewSearchValues = z.infer<typeof previewSearchValuesSchema>;

/** Null is an unobserved fact; an empty matcher list confirms exact matching. */
export interface PreviewSearchFacts {
	readonly maximum: PreviewSearchValues["maximum"];
	readonly timeZone: string | null;
	readonly propertyMatchers:
		| readonly {
				readonly caseType: string;
				readonly property: string;
				readonly fuzzy: boolean;
				readonly ignoreLiterals: readonly string[];
		  }[]
		| null;
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
	propertyMatchers: [],
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
): PreviewSearchFacts["propertyMatchers"] {
	const candidates = facts.matcherAlternatives ?? [facts.propertyMatchers];
	const applicable = candidates.map(
		(list) =>
			list?.filter(
				(r) =>
					r.property === property && requestedCaseTypes.includes(r.caseType),
			) ?? null,
	);
	const [first] = applicable;
	return first &&
		applicable.every((rules) => JSON.stringify(rules) === JSON.stringify(first))
		? first
		: null;
}
