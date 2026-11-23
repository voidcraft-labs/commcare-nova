import { z } from "zod";
import { deploymentServerSchema } from "@/lib/deployment/types";
import {
	DEFAULT_SEARCH_RESULT_LIMIT,
	INCREASED_SEARCH_RESULT_LIMIT,
} from "@/lib/domain/searchLimits";
import {
	searchTimeZoneIdentity,
	searchTimeZonePrimary,
} from "./searchTimeZone";

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

const namedZone =
	"Choose a named time zone such as Asia/Kolkata, America/New_York or UTC. A local abbreviation can refer to more than one place.";
/** A recorded calendar: a name in the pinned IANA table. Reading never asks
 * this runtime's Intl, whose data can be older than the saving runtime's;
 * `resolvePreviewSearchFacts` leaves only the time zone unconfirmed then. */
export const searchTimeZoneSchema = z
	.string()
	.min(1, namedZone)
	.max(128, namedZone)
	.refine((name) => searchTimeZonePrimary(name) !== undefined, namedZone);
/** A calendar being saved must also play where it is saved. */
export const playableSearchTimeZoneSchema = searchTimeZoneSchema.refine(
	(name) => searchTimeZoneIdentity(name) !== undefined,
	"Nova can't use that time zone on this device yet. Choose another name for the same place, such as its nearest major city.",
);

// PostgreSQL jsonb must be able to store every admitted rule.
function ruleText(missing: string, name: string) {
	return z
		.string()
		.min(1, `Add ${missing} to this rule.`)
		.max(256, `Keep each ${name} to 256 characters or fewer.`)
		.refine(
			(value) => !value.includes("\0") && value.isWellFormed(),
			"Use text without a null character or an incomplete Unicode character.",
		);
}
const propertyAddress = {
	caseType: ruleText("a record type", "record type"),
	property: ruleText("a property name", "property name"),
};

export const fuzzySearchPropertySchema = z.strictObject({
	...propertyAddress,
	fuzzy: z.boolean(),
});
export const ignoredSearchTextSchema = z.strictObject({
	...propertyAddress,
	literal: ruleText("the text to ignore", "text to ignore"),
});

const propertyMatchingSchema = z.strictObject({
	fuzzyProperties: z
		.array(fuzzySearchPropertySchema)
		.max(256, "Keep matching rules to 256 or fewer.")
		.refine(
			(rows) =>
				new Set(rows.map((row) => JSON.stringify([row.caseType, row.property])))
					.size === rows.length,
			"Choose one matching method for each record type and property.",
		),
	// HQ processes each literal in the order its configuration supplies it,
	// including repeated properties on types interleaved through that order.
	ignoredText: z
		.array(ignoredSearchTextSchema)
		.max(16384, "Keep text to ignore to 16,384 entries or fewer."),
});

export const previewSearchValuesSchema = z.strictObject({
	maximum: z
		.union([
			z.literal(DEFAULT_SEARCH_RESULT_LIMIT),
			z.literal(INCREASED_SEARCH_RESULT_LIMIT),
		])
		.nullable(),
	timeZone: searchTimeZoneSchema.nullable(),
	caseListMap: z.boolean().nullable().optional(),
	propertyMatchers: propertyMatchingSchema.nullable(),
});
export type PreviewSearchValues = z.infer<typeof previewSearchValuesSchema>;

/** Null is an unobserved fact; an empty matcher list confirms exact matching. */
export interface PreviewSearchFacts {
	readonly maximum: PreviewSearchValues["maximum"];
	readonly timeZone: string | null;
	/** Team confirmation of the Web Apps record map at this destination. */
	readonly caseListMap: boolean | null;
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
	const zoneIdentity =
		values.timeZone && searchTimeZoneIdentity(values.timeZone);
	const caseListMap = values.caseListMap ?? null;
	const matcherLists = profiles.map((p) => p.values.propertyMatchers);
	const sameMatchers = matcherLists.every(
		(list) => JSON.stringify(list) === JSON.stringify(values.propertyMatchers),
	);
	return {
		caseListMap: profiles.every(
			(p) => (p.values.caseListMap ?? null) === caseListMap,
		)
			? caseListMap
			: null,
		maximum: profiles.every((p) => p.values.maximum === values.maximum)
			? values.maximum
			: null,
		timeZone:
			zoneIdentity &&
			profiles.every(
				(p) =>
					p.values.timeZone !== null &&
					searchTimeZoneIdentity(p.values.timeZone) === zoneIdentity,
			)
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

/** Name the rule a refused value belongs to, numbered as the settings list
 * shows each kind of rule. */
export function previewSearchIssueText(
	issue: z.core.$ZodIssue | undefined,
): string {
	if (!issue) return "Review the search settings.";
	const [group, list, index] = issue.path;
	if (group !== "propertyMatchers" || typeof index !== "number")
		return issue.message;
	if (list === "fuzzyProperties")
		return `Matching rule ${index + 1}: ${issue.message}`;
	if (list === "ignoredText")
		return `Ignored text ${index + 1}: ${issue.message}`;
	return issue.message;
}
