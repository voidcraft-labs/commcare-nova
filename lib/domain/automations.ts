// lib/domain/automations.ts
//
// Human-applied CommCare HQ automations authored as part of one Blueprint.
// Nova can count the subset of each rule's criteria that its own case store can
// evaluate, but it never executes a schedule in Preview. The setup projection
// in `lib/automations` is the only deployment artifact for these objects until
// an audited HQ driver exists.

import { z } from "zod";
import {
	persistableJsonIntegerSchema,
	persistableJsonNonnegativeIntegerSchema,
	persistableJsonPositiveIntegerSchema,
} from "./jsonNumber";
import { ownRecordValue, recordFromEntries } from "./records";
import { type Uuid, uuidSchema } from "./uuid";

export const AUTOMATION_NAME_MAX_LENGTH = 126;
export const AUTOMATION_SETUP_NOTE_MAX_LENGTH = 2_000;

export const AUTOMATION_CRITERIA_OPERATORS = ["all", "any"] as const;
export type AutomationCriteriaOperator =
	(typeof AUTOMATION_CRITERIA_OPERATORS)[number];

export const AUTOMATION_PROPERTY_MATCH_TYPES = [
	"equal",
	"not-equal",
	"has-value",
	"has-no-value",
	"regex",
	"date-days-before",
	"date-days-lte",
	"date-days-gt",
	"date-days",
] as const;
export type AutomationPropertyMatchType =
	(typeof AUTOMATION_PROPERTY_MATCH_TYPES)[number];

export interface AutomationTemplateCasePropertyToken {
	readonly start: number;
	readonly end: number;
	readonly scope: "case" | "parent" | "host";
	readonly property: string;
}

/** Parse only HQ's exact `{case...}` template property spellings. */
export function automationTemplateCasePropertyTokens(
	template: string,
): AutomationTemplateCasePropertyToken[] {
	const tokens: AutomationTemplateCasePropertyToken[] = [];
	const prefix = "{case.";
	let cursor = 0;
	while (cursor < template.length) {
		const start = template.indexOf(prefix, cursor);
		if (start < 0) break;
		const close = template.indexOf("}", start + prefix.length);
		if (close < 0) break;
		const parts = template.slice(start + prefix.length, close).split(".");
		if (parts.length === 1 && parts[0]) {
			tokens.push({
				start,
				end: close + 1,
				scope: "case",
				property: parts[0],
			});
		} else if (
			parts.length === 2 &&
			(parts[0] === "parent" || parts[0] === "host") &&
			parts[1]
		) {
			tokens.push({
				start,
				end: close + 1,
				scope: parts[0],
				property: parts[1],
			});
		}
		cursor = close + 1;
	}
	return tokens;
}

/**
 * Conditional-alert regexes execute as Python `re.match` in HQ and PostgreSQL
 * ARE in Preview. Keep authored patterns inside their deliberately small,
 * shared syntax instead of accepting an engine-specific extension that would
 * silently mean something else on one surface.
 */
export function isPortableAutomationRegex(pattern: string): boolean {
	if (/\r|\n|\[\[:/.test(pattern)) return false;
	let escaped = false;
	let inClass = false;
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (escaped) {
			if (!".^$*+?{}[]\\|()-/".includes(character ?? "")) return false;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "[") inClass = true;
		if (character === "]") inClass = false;
		if (!inClass && character === "(" && pattern[index + 1] === "?") {
			return false;
		}
	}
	if (escaped) return false;
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

export const propertyMatchCriterionSchema = z
	.object({
		uuid: uuidSchema,
		kind: z.literal("match-property"),
		property: z.string().min(1).max(126),
		matchType: z.enum(AUTOMATION_PROPERTY_MATCH_TYPES),
		/** Used by equality and regex matches; absent on blank/date matches. */
		value: z.string().max(126).optional(),
		/** The N in HQ's comparisons against `case_date + N`. */
		days: persistableJsonIntegerSchema.min(-36_500).max(36_500).optional(),
	})
	.strict()
	.superRefine((criterion, ctx) => {
		const needsValue = ["equal", "not-equal", "regex"].includes(
			criterion.matchType,
		);
		const needsDays = criterion.matchType.startsWith("date-");
		if (needsValue !== (criterion.value !== undefined)) {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message: needsValue
					? "This match needs one comparison value."
					: "This match does not accept a comparison value.",
			});
		}
		if (needsDays !== (criterion.days !== undefined)) {
			ctx.addIssue({
				code: "custom",
				path: ["days"],
				message: needsDays
					? "This date match needs a day offset."
					: "This match does not accept a day offset.",
			});
		}
		if (
			criterion.matchType === "regex" &&
			criterion.value !== undefined &&
			!isPortableAutomationRegex(criterion.value)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["value"],
				message:
					"Use a portable regular expression without lookarounds, named groups, shorthand classes, backreferences, or engine-specific escapes.",
			});
		}
	});

export const closedParentCriterionSchema = z
	.object({
		uuid: uuidSchema,
		kind: z.literal("closed-parent"),
		/** HQ's case-index identifier, normally `parent` or `host`. */
		identifier: z.string().min(1).max(126),
		relationship: z.enum(["child", "extension"]),
	})
	.strict();

export const locationCriterionSchema = z
	.object({
		uuid: uuidSchema,
		kind: z.literal("location"),
		locationUuid: uuidSchema,
		includeDescendants: z.boolean(),
	})
	.strict();

/** Exactly the HQ criteria Nova can lower into its local Predicate compiler. */
export const automationCriterionSchema = z.discriminatedUnion("kind", [
	propertyMatchCriterionSchema,
	closedParentCriterionSchema,
	locationCriterionSchema,
]);
export type AutomationCriterion = z.infer<typeof automationCriterionSchema>;

export const automationPropertyTargetSchema = z
	.object({
		scope: z.enum(["case", "parent", "host"]),
		property: z.string().min(1).max(126),
	})
	.strict();
export type AutomationPropertyTarget = z.infer<
	typeof automationPropertyTargetSchema
>;

export const automationUpdateValueSchema = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("literal"), value: z.string().max(4_096) })
		.strict(),
	z
		.object({
			kind: z.literal("case-property"),
			source: automationPropertyTargetSchema,
		})
		.strict(),
]);
export type AutomationUpdateValue = z.infer<typeof automationUpdateValueSchema>;

export const automationCaseUpdateSchema = z
	.object({
		uuid: uuidSchema,
		target: automationPropertyTargetSchema,
		value: automationUpdateValueSchema,
	})
	.strict();
export type AutomationCaseUpdate = z.infer<typeof automationCaseUpdateSchema>;

export const automationRecipientSchema = z.discriminatedUnion("kind", [
	z.object({ uuid: uuidSchema, kind: z.literal("self") }).strict(),
	z.object({ uuid: uuidSchema, kind: z.literal("owner") }).strict(),
	z
		.object({ uuid: uuidSchema, kind: z.literal("last-submitting-user") })
		.strict(),
	z.object({ uuid: uuidSchema, kind: z.literal("parent-case") }).strict(),
	z.object({ uuid: uuidSchema, kind: z.literal("all-child-cases") }).strict(),
	z
		.object({
			uuid: uuidSchema,
			kind: z.enum([
				"case-property-username",
				"case-property-user-id",
				"case-property-email",
			]),
			property: z.string().min(1).max(126),
		})
		.strict(),
	z
		.object({
			uuid: uuidSchema,
			kind: z.literal("location"),
			locationUuid: uuidSchema,
		})
		.strict(),
	z
		.object({
			uuid: uuidSchema,
			kind: z.enum(["mobile-worker", "web-user", "user-group", "case-group"]),
			hqId: z.string().min(1).max(255),
		})
		.strict(),
	z
		.object({
			uuid: uuidSchema,
			kind: z.literal("custom"),
			registeredId: z.string().min(1).max(126),
		})
		.strict(),
]);
export type AutomationRecipient = z.infer<typeof automationRecipientSchema>;

const formContentBase = { formUuid: uuidSchema } as const;
const surveyContentBase = {
	...formContentBase,
	expirationHours: persistableJsonPositiveIntegerSchema.max(168),
	reminderIntervalsMinutes: z
		.array(persistableJsonPositiveIntegerSchema)
		.max(100),
	submitPartiallyCompletedForms: z.boolean(),
	includeCaseUpdatesInPartialSubmissions: z.boolean(),
} as const;
export const automationContentSchema = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("sms"), message: z.string().min(1).max(16_000) })
		.strict(),
	z
		.object({
			kind: z.literal("email"),
			subject: z.string().min(1).max(1_000),
			message: z.string().max(64_000),
			htmlMessage: z.string().max(256_000).optional(),
		})
		.strict()
		.refine((content) => content.message.length > 0 || content.htmlMessage, {
			message: "An email needs a plain-text or HTML message.",
		}),
	z.object({ kind: z.literal("sms-survey"), ...surveyContentBase }).strict(),
	z
		.object({
			kind: z.literal("ivr"),
			...formContentBase,
			reminderIntervalsMinutes: z
				.array(persistableJsonPositiveIntegerSchema)
				.max(100),
			submitPartiallyCompletedForms: z.boolean(),
			includeCaseUpdatesInPartialSubmissions: z.boolean(),
			maxQuestionAttempts: persistableJsonPositiveIntegerSchema.max(5),
		})
		.strict(),
	z
		.object({
			kind: z.literal("sms-callback"),
			message: z.string().min(1).max(16_000),
			reminderIntervalsMinutes: z
				.array(persistableJsonPositiveIntegerSchema)
				.min(1)
				.max(100),
		})
		.strict(),
	z
		.object({
			kind: z.literal("connect-message"),
			message: z.string().min(1).max(16_000),
		})
		.strict(),
	z
		.object({ kind: z.literal("connect-survey"), ...surveyContentBase })
		.strict(),
	z
		.object({
			kind: z.literal("custom"),
			registeredId: z.string().min(1).max(126),
		})
		.strict(),
]);
export type AutomationContent = z.infer<typeof automationContentSchema>;

export const timedEventTimingSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("specific-time"),
			time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
		})
		.strict(),
	z
		.object({
			kind: z.literal("random-window"),
			time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
			windowMinutes: persistableJsonPositiveIntegerSchema.max(1_440),
		})
		.strict(),
	z
		.object({
			kind: z.literal("case-property-time"),
			property: z.string().min(1).max(126),
		})
		.strict(),
]);

export const automationImmediateEventSchema = z
	.object({
		uuid: uuidSchema,
		minutesToWait: persistableJsonNonnegativeIntegerSchema.max(5_256_000),
		content: automationContentSchema,
	})
	.strict();
export type AutomationImmediateEvent = z.infer<
	typeof automationImmediateEventSchema
>;

export const automationTimedEventSchema = z
	.object({
		uuid: uuidSchema,
		day: persistableJsonIntegerSchema.min(-28).max(3_649),
		timing: timedEventTimingSchema,
		content: automationContentSchema,
	})
	.strict();
export type AutomationTimedEvent = z.infer<typeof automationTimedEventSchema>;

export const automationScheduleSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("immediate"),
			events: z.array(automationImmediateEventSchema).min(1).max(100),
		})
		.strict(),
	z
		.object({
			kind: z.literal("timed"),
			/** Positive means days; negative means months. Zero is not legal. */
			repeatEvery: persistableJsonIntegerSchema
				.min(-120)
				.max(3_650)
				.refine((v) => v !== 0),
			totalIterations: persistableJsonIntegerSchema
				.min(-1)
				.max(100_000)
				.refine((v) => v !== 0),
			startOffsetDays: persistableJsonIntegerSchema.min(-36_500).max(36_500),
			startDayOfWeek: persistableJsonIntegerSchema.min(-1).max(6),
			start: z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("rule-trigger") }).strict(),
				z
					.object({
						kind: z.literal("case-property"),
						property: z.string().min(1).max(126),
					})
					.strict(),
				z
					.object({
						kind: z.literal("specific-date"),
						date: z.iso.date(),
					})
					.strict(),
			]),
			events: z.array(automationTimedEventSchema).min(1).max(366),
		})
		.strict()
		.superRefine((schedule, ctx) => {
			for (const [index, event] of schedule.events.entries()) {
				const valid =
					schedule.repeatEvery < 0
						? event.day !== 0 && event.day <= 31
						: event.day >= 0 && event.day < schedule.repeatEvery;
				if (!valid) {
					ctx.addIssue({
						code: "custom",
						path: ["events", index, "day"],
						message:
							schedule.repeatEvery < 0
								? "A monthly event day is 1–31 or -1–-28 from month end."
								: "A daily event day must fit inside the repeat interval.",
					});
				}
			}
		}),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

export const automationUserDataFilterSchema = z
	.object({
		uuid: uuidSchema,
		userPropertyUuid: uuidSchema,
		allowedValues: z.array(z.string().max(4_096)).min(1).max(250),
	})
	.strict();
export type AutomationUserDataFilter = z.infer<
	typeof automationUserDataFilterSchema
>;

export const automationSetupOnlyCriterionSchema = z
	.object({
		uuid: uuidSchema,
		text: z.string().min(1).max(AUTOMATION_SETUP_NOTE_MAX_LENGTH),
	})
	.strict();

const automationCommon = {
	uuid: uuidSchema,
	name: z
		.string()
		.min(1, "Enter an automation name.")
		.max(
			AUTOMATION_NAME_MAX_LENGTH,
			`Keep the automation name under ${AUTOMATION_NAME_MAX_LENGTH + 1} characters.`,
		),
	caseType: z.string().min(1).max(126),
	criteriaOperator: z.enum(AUTOMATION_CRITERIA_OPERATORS),
	criteria: z.array(automationCriterionSchema).max(100),
	/**
	 * UCR and instance-registered custom criteria have no portable schema. They
	 * remain explicit setup-artifact prose and are always named as omitted from
	 * Nova's current-match count.
	 */
	setupOnlyCriteria: z.array(automationSetupOnlyCriterionSchema).max(100),
	/** HQ-only server-modified age, deliberately outside `criteria`. */
	serverModifiedBoundaryDays: persistableJsonNonnegativeIntegerSchema
		.max(36_500)
		.optional(),
} as const;

export const automationSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...automationCommon,
			kind: z.literal("case-update"),
			runOnSave: z.boolean(),
			updates: z.array(automationCaseUpdateSchema).max(250),
			closeCase: z.boolean(),
		})
		.strict()
		.refine((rule) => rule.closeCase || rule.updates.length > 0, {
			message:
				"A case-update rule must close the case or write at least one property.",
		}),
	z
		.object({
			...automationCommon,
			kind: z.literal("conditional-alert"),
			recipients: z.array(automationRecipientSchema).min(1).max(250),
			schedule: automationScheduleSchema,
			includeDescendantLocations: z.boolean(),
			locationLevelUuids: z.array(uuidSchema).max(100),
			defaultLanguageCode: z.string().min(1).max(126).optional(),
			userDataFilters: z.array(automationUserDataFilterSchema).max(100),
			useUserCaseForFilter: z.boolean(),
			resetCaseProperty: z.string().min(1).max(126).optional(),
			stopDateCaseProperty: z.string().min(1).max(126).optional(),
		})
		.strict(),
]);
export type Automation = z.infer<typeof automationSchema>;

export interface AutomationCollections {
	readonly automations?: Record<string, Automation>;
	readonly automationOrder?: readonly Uuid[];
}

export function automationsOf(
	doc: AutomationCollections,
): Record<string, Automation> {
	return doc.automations ?? recordFromEntries([]);
}

export function orderedAutomations(doc: AutomationCollections): Automation[] {
	return (doc.automationOrder ?? []).flatMap((uuid) => {
		const automation = ownRecordValue(doc.automations, uuid);
		return automation === undefined ? [] : [automation];
	});
}

/** Every nested identity owned by an automation, in its saved sequence. */
export function automationNestedUuids(automation: Automation): Uuid[] {
	const uuids = [
		...automation.criteria.map((criterion) => criterion.uuid),
		...automation.setupOnlyCriteria.map((criterion) => criterion.uuid),
	];
	if (automation.kind === "case-update") {
		return [...uuids, ...automation.updates.map((update) => update.uuid)];
	}
	return [
		...uuids,
		...automation.recipients.map((recipient) => recipient.uuid),
		...automation.schedule.events.map((event) => event.uuid),
		...automation.userDataFilters.map((filter) => filter.uuid),
	];
}
