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

export const AUTOMATION_CASE_UPDATE_PROPERTY_MATCH_TYPES = [
	"equal",
	"not-equal",
	"has-value",
	"has-no-value",
	"date-days-before",
	"date-days-lte",
	"date-days-gt",
	"date-days",
] as const;
export const AUTOMATION_ALERT_PROPERTY_MATCH_TYPES = [
	"equal",
	"not-equal",
	"has-value",
	"has-no-value",
	"regex",
] as const;
export const AUTOMATION_PROPERTY_MATCH_TYPES = [
	...AUTOMATION_CASE_UPDATE_PROPERTY_MATCH_TYPES,
	"regex",
] as const;
export type AutomationPropertyMatchType =
	(typeof AUTOMATION_PROPERTY_MATCH_TYPES)[number];

function isCanonicalHqCasePropertyValue(value: string): boolean {
	const trimmed = value.trim();
	const first = trimmed[0];
	const unquoted =
		trimmed.length >= 2 &&
		(first === "'" || first === '"') &&
		trimmed.at(-1) === first
			? trimmed.slice(1, -1).trim()
			: trimmed;
	return unquoted.length > 0 && value === unquoted;
}

/**
 * Conditional-alert regexes execute as Python `re.match` in HQ and PostgreSQL
 * ARE in Preview. Keep authored patterns inside their deliberately small,
 * shared syntax instead of accepting an engine-specific extension that would
 * silently mean something else on one surface.
 */
export function isPortableAutomationRegex(pattern: string): boolean {
	if (/\r|\n|\[\[(?:[:.=])/.test(pattern)) return false;
	let escaped = false;
	let inClass = false;
	let classHasContent = false;
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (escaped) {
			if (!".^$*+?{}[]\\|()-/".includes(character ?? "")) return false;
			if (inClass) classHasContent = true;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "[" && !inClass) {
			inClass = true;
			classHasContent = false;
			if (pattern[index + 1] === "^") index += 1;
			continue;
		}
		if (character === "]" && inClass) {
			if (!classHasContent) return false;
			inClass = false;
			continue;
		}
		if (inClass) classHasContent = true;
		if (!inClass && character === "(" && pattern[index + 1] === "?") {
			return false;
		}
		if (!inClass && character === "{") {
			const close = pattern.indexOf("}", index + 1);
			if (close === -1) return false;
			const bounds = pattern.slice(index + 1, close);
			const match = /^(\d+)(?:,(\d*))?$/.exec(bounds);
			if (match === null) return false;
			const lower = Number(match[1]);
			const upper =
				match[2] === undefined || match[2] === "" ? lower : Number(match[2]);
			// PostgreSQL ARE caps repetition bounds at 255. Canonicalize the
			// shared subset to explicit lower bounds; Python's `{,n}` extension
			// otherwise becomes literal text in PostgreSQL.
			if (lower > 255 || upper > 255 || lower > upper) return false;
			index = close;
			continue;
		}
		if (!inClass && character === "}") return false;
	}
	if (escaped || inClass) return false;
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

function validatePropertyMatchCriterion(
	criterion: {
		readonly matchType: AutomationPropertyMatchType;
		readonly value?: string;
		readonly days?: number;
	},
	ctx: z.RefinementCtx,
): void {
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
		(criterion.matchType === "equal" || criterion.matchType === "not-equal") &&
		criterion.value !== undefined &&
		!isCanonicalHqCasePropertyValue(criterion.value)
	) {
		ctx.addIssue({
			code: "custom",
			path: ["value"],
			message:
				"Use the exact nonblank value CommCare HQ stores, without surrounding whitespace or matching outer quotes.",
		});
	}
	if (
		criterion.matchType === "regex" &&
		criterion.value !== undefined &&
		(criterion.value.length === 0 ||
			!isPortableAutomationRegex(criterion.value))
	) {
		ctx.addIssue({
			code: "custom",
			path: ["value"],
			message:
				"Use a portable regular expression without lookarounds, named groups, shorthand classes, backreferences, or engine-specific escapes.",
		});
	}
}

const propertyMatchCriterionCommon = {
	uuid: uuidSchema,
	kind: z.literal("match-property"),
	property: z.string().min(1).max(126),
	/** Used by equality and regex matches; absent on blank/date matches. */
	value: z.string().max(126).optional(),
	/** The N in HQ's comparisons against `case_date + N`. */
	days: persistableJsonIntegerSchema.min(-36_500).max(36_500).optional(),
} as const;

export const caseUpdatePropertyMatchCriterionSchema = z
	.object({
		...propertyMatchCriterionCommon,
		scope: z.enum(["case", "parent", "host"]),
		matchType: z.enum(AUTOMATION_CASE_UPDATE_PROPERTY_MATCH_TYPES),
	})
	.strict()
	.superRefine(validatePropertyMatchCriterion);

export const alertPropertyMatchCriterionSchema = z
	.object({
		...propertyMatchCriterionCommon,
		scope: z.literal("case"),
		matchType: z.enum(AUTOMATION_ALERT_PROPERTY_MATCH_TYPES),
	})
	.strict()
	.superRefine(validatePropertyMatchCriterion);

export const closedParentCriterionSchema = z
	.object({
		uuid: uuidSchema,
		kind: z.literal("closed-parent"),
	})
	.strict();

/**
 * HQ evaluates a location criterion against either a location-owned case or
 * the primary location of the mobile worker who owns the case. Nova stores
 * the place identity, never the target HQ location id; setup guidance resolves
 * the current human/site-code projection and deployment owns the remote map.
 */
export const locationAutomationCriterionSchema = z
	.object({
		uuid: uuidSchema,
		kind: z.literal("location"),
		locationUuid: uuidSchema,
		includeDescendants: z.boolean(),
	})
	.strict();

export const automationCaseUpdateCriterionSchema = z.discriminatedUnion(
	"kind",
	[
		caseUpdatePropertyMatchCriterionSchema,
		closedParentCriterionSchema,
		locationAutomationCriterionSchema,
	],
);
export const automationAlertCriterionSchema = z.discriminatedUnion("kind", [
	alertPropertyMatchCriterionSchema,
	locationAutomationCriterionSchema,
]);

export type AutomationCriterion =
	| z.infer<typeof automationCaseUpdateCriterionSchema>
	| z.infer<typeof automationAlertCriterionSchema>;

export const automationPropertyTargetSchema = z
	.object({
		scope: z.enum(["case", "parent", "host"]),
		property: z.string().min(1).max(126),
	})
	.strict();
export type AutomationPropertyTarget = z.infer<
	typeof automationPropertyTargetSchema
>;

export const AUTOMATION_MESSAGE_CONTEXTS = ["case-owner", "recipient"] as const;
export type AutomationMessageContext =
	(typeof AUTOMATION_MESSAGE_CONTEXTS)[number];

export const AUTOMATION_MESSAGE_CONTEXT_PROPERTIES = [
	"name",
	"first_name",
	"last_name",
	"phone_number",
	"site_code",
] as const;
export type AutomationMessageContextProperty =
	(typeof AUTOMATION_MESSAGE_CONTEXT_PROPERTIES)[number];

export const automationMessagePartSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("text"),
			text: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("case-property"),
			scope: automationPropertyTargetSchema.shape.scope,
			caseType: z.string().min(1).max(126),
			property: automationPropertyTargetSchema.shape.property,
		})
		.strict(),
	z
		.object({
			kind: z.literal("context-property"),
			context: z.enum(AUTOMATION_MESSAGE_CONTEXTS),
			property: z.enum(AUTOMATION_MESSAGE_CONTEXT_PROPERTIES),
		})
		.strict(),
]);
export type AutomationMessagePart = z.infer<typeof automationMessagePartSchema>;

/**
 * Canonical reference-bearing content for HQ message fields.
 *
 * Text is always literal, including text that looks like `{case.foo}`. A case
 * property becomes identity-bearing only when an editor inserts the structural
 * `case-property` part. The HQ token spelling is a one-way setup projection.
 */
export const automationMessageTemplateSchema = z
	.object({
		parts: z.array(automationMessagePartSchema).min(1).max(1_000),
	})
	.strict()
	.superRefine((template, ctx) => {
		for (let index = 1; index < template.parts.length; index += 1) {
			if (
				template.parts[index - 1]?.kind === "text" &&
				template.parts[index]?.kind === "text"
			) {
				ctx.addIssue({
					code: "custom",
					path: ["parts", index],
					message:
						"Adjacent message text parts are not canonical; merge them into one part.",
				});
			}
		}
		const first = template.parts[0];
		const last = template.parts.at(-1);
		if (
			(first?.kind === "text" && first.text !== first.text.trimStart()) ||
			(last?.kind === "text" && last.text !== last.text.trimEnd())
		) {
			ctx.addIssue({
				code: "custom",
				path: ["parts"],
				message: "A message template must have no surrounding whitespace.",
			});
		}
		if (
			!template.parts.some(
				(part) => part.kind !== "text" || part.text.trim().length > 0,
			)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["parts"],
				message: "A message template must be nonblank.",
			});
		}
	});
export type AutomationMessageTemplate = z.infer<
	typeof automationMessageTemplateSchema
>;

export function automationMessageText(text: string): AutomationMessageTemplate {
	return { parts: [{ kind: "text", text }] };
}

/** Drop empty text and merge adjacent literal runs after an editor operation. */
export function canonicalAutomationMessageTemplate(
	parts: readonly AutomationMessagePart[],
): AutomationMessageTemplate {
	const normalized: AutomationMessagePart[] = [];
	for (const part of parts) {
		if (part.kind === "text") {
			if (part.text.length === 0) continue;
			const previous = normalized.at(-1);
			if (previous?.kind === "text") previous.text += part.text;
			else normalized.push({ ...part });
		} else {
			normalized.push({ ...part });
		}
	}
	return { parts: normalized };
}

function automationMessageTemplateWithLimit(maxLength: number, label: string) {
	return automationMessageTemplateSchema.superRefine((template, ctx) => {
		const projectedLength = template.parts.reduce((length, part) => {
			if (part.kind === "text") {
				// Python string.Formatter uses doubled braces for literal braces.
				return (
					length + part.text.replaceAll("{", "{{").replaceAll("}", "}}").length
				);
			}
			if (part.kind === "context-property") {
				return (
					length +
					(part.context === "case-owner"
						? `{case.owner.${part.property}}`
						: `{recipient.${part.property}}`
					).length
				);
			}
			return (
				length +
				`{case.${part.scope === "case" ? "" : `${part.scope}.`}${part.property}}`
					.length
			);
		}, 0);
		if (projectedLength > maxLength) {
			ctx.addIssue({
				code: "custom",
				path: ["parts"],
				message: `${label} must be at most ${maxLength} characters after projection.`,
			});
		}
	});
}

export const automationUpdateValueSchema = z.discriminatedUnion("kind", [
	z
		.object({ kind: z.literal("literal"), value: z.string().max(4_096) })
		.strict()
		.refine((value) => isCanonicalHqCasePropertyValue(value.value), {
			path: ["value"],
			message:
				"Use the exact nonblank value CommCare HQ stores, without surrounding whitespace or matching outer quotes.",
		}),
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

const automationHqRecipientIdSchema = z
	.string()
	.max(255)
	.refine((value) => value.trim().length > 0 && value === value.trim(), {
		message:
			"A CommCare HQ recipient ID must be nonblank and have no surrounding whitespace.",
	});

const automationRegisteredIdSchema = z
	.string()
	.max(126)
	.refine((value) => value.trim().length > 0 && value === value.trim(), {
		message:
			"A CommCare HQ registered ID must be nonblank and have no surrounding whitespace.",
	});

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
			kind: z.enum(["mobile-worker", "user-group", "case-group"]),
			hqId: automationHqRecipientIdSchema,
		})
		.strict(),
	z
		.object({
			uuid: uuidSchema,
			kind: z.literal("custom"),
			registeredId: automationRegisteredIdSchema,
		})
		.strict(),
]);
export type AutomationRecipient = z.infer<typeof automationRecipientSchema>;

const AUTOMATION_SINGLETON_RECIPIENT_KINDS = new Set<
	AutomationRecipient["kind"]
>([
	"self",
	"owner",
	"last-submitting-user",
	"parent-case",
	"all-child-cases",
	"case-property-username",
	"case-property-user-id",
	"case-property-email",
	"custom",
]);

/** HQ renders these recipient kinds as one checkbox plus one value control. */
export function automationRecipientKindIsSingleton(
	kind: AutomationRecipient["kind"],
): boolean {
	return AUTOMATION_SINGLETON_RECIPIENT_KINDS.has(kind);
}

function automationRecipientSetupKey(recipient: AutomationRecipient): string {
	if (automationRecipientKindIsSingleton(recipient.kind)) return recipient.kind;
	if (recipient.kind === "location") {
		return `${recipient.kind}:${recipient.locationUuid}`;
	}
	if ("hqId" in recipient) return `${recipient.kind}:${recipient.hqId}`;
	return recipient.kind;
}

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

interface PartialSubmissionSettings {
	readonly submitPartiallyCompletedForms: boolean;
	readonly includeCaseUpdatesInPartialSubmissions: boolean;
}

function validatePartialSubmissionSettings(
	content: PartialSubmissionSettings,
	ctx: z.RefinementCtx,
): void {
	if (
		content.includeCaseUpdatesInPartialSubmissions &&
		!content.submitPartiallyCompletedForms
	) {
		ctx.addIssue({
			code: "custom",
			path: ["includeCaseUpdatesInPartialSubmissions"],
			message:
				"Case updates can be included only when partial form submission is on.",
		});
	}
}

function validateSurveyContent(
	content: PartialSubmissionSettings & {
		readonly expirationHours: number;
		readonly reminderIntervalsMinutes: readonly number[];
	},
	ctx: z.RefinementCtx,
): void {
	validatePartialSubmissionSettings(content, ctx);
	const reminderTotal = content.reminderIntervalsMinutes.reduce(
		(sum, interval) => sum + interval,
		0,
	);
	if (reminderTotal >= content.expirationHours * 60) {
		ctx.addIssue({
			code: "custom",
			path: ["reminderIntervalsMinutes"],
			message:
				"Reminder intervals must add up to less than the survey expiration window.",
		});
	}
}

export const automationContentSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("sms"),
			message: automationMessageTemplateWithLimit(16_000, "An SMS message"),
		})
		.strict(),
	z
		.object({
			kind: z.literal("email"),
			subject: automationMessageTemplateWithLimit(1_000, "An email subject"),
			body: z.discriminatedUnion("kind", [
				z
					.object({
						kind: z.literal("plain-text"),
						message: automationMessageTemplateWithLimit(
							64_000,
							"A plain-text email message",
						),
					})
					.strict(),
				z
					.object({
						kind: z.literal("rich-text"),
						html: automationMessageTemplateWithLimit(
							256_000,
							"Rich-text email HTML",
						),
					})
					.strict(),
			]),
		})
		.strict(),
	z
		.object({ kind: z.literal("sms-survey"), ...surveyContentBase })
		.strict()
		.superRefine(validateSurveyContent),
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
		.strict()
		.superRefine(validatePartialSubmissionSettings),
	z
		.object({
			kind: z.literal("sms-callback"),
			message: automationMessageTemplateWithLimit(
				16_000,
				"An SMS callback message",
			),
			reminderIntervalsMinutes: z
				.array(persistableJsonPositiveIntegerSchema)
				.min(1)
				.max(100),
		})
		.strict(),
	z
		.object({
			kind: z.literal("connect-message"),
			message: automationMessageTemplateWithLimit(16_000, "A Connect message"),
		})
		.strict(),
	z
		.object({ kind: z.literal("connect-survey"), ...surveyContentBase })
		.strict()
		.superRefine(validateSurveyContent),
	z
		.object({
			kind: z.literal("custom"),
			registeredId: automationRegisteredIdSchema,
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
			windowMinutes: persistableJsonPositiveIntegerSchema.max(1_439),
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

export type TimedScheduleSetupForm = "custom-daily" | "weekly" | "monthly";

function timedScheduleSetupForm(schedule: {
	readonly repeatEvery: number;
	readonly startDayOfWeek: number;
}): TimedScheduleSetupForm {
	if (schedule.repeatEvery < 0) return "monthly";
	return schedule.startDayOfWeek >= 0 ? "weekly" : "custom-daily";
}

function timeInMinutes(time: string): number {
	const [hours = "0", minutes = "0"] = time.split(":");
	return Number(hours) * 60 + Number(minutes);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validateScheduleContentMode(
	events: readonly { readonly content: AutomationContent }[],
	ctx: z.RefinementCtx,
): void {
	const first = events[0];
	if (first === undefined) return;
	for (const [index, event] of events.entries()) {
		if (event.content.kind !== first.content.kind) {
			ctx.addIssue({
				code: "custom",
				path: ["events", index, "content", "kind"],
				message: "Every event must use the schedule's one content type.",
			});
			continue;
		}
		if (
			first.content.kind === "email" &&
			event.content.kind === "email" &&
			event.content.body.kind !== first.content.body.kind
		) {
			ctx.addIssue({
				code: "custom",
				path: ["events", index, "content", "body", "kind"],
				message:
					"Every email event must target the same plain-text or rich-text HQ form.",
			});
		}
		if (
			"submitPartiallyCompletedForms" in first.content &&
			"submitPartiallyCompletedForms" in event.content &&
			(event.content.submitPartiallyCompletedForms !==
				first.content.submitPartiallyCompletedForms ||
				event.content.includeCaseUpdatesInPartialSubmissions !==
					first.content.includeCaseUpdatesInPartialSubmissions)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["events", index, "content", "submitPartiallyCompletedForms"],
				message:
					"Every survey event must use the schedule's shared partial-submission settings.",
			});
		}
	}
}

function validateTimedSchedule(
	schedule: {
		readonly repeatEvery: number;
		readonly totalIterations: number;
		readonly startOffsetDays: number;
		readonly startDayOfWeek: number;
		readonly start:
			| { readonly kind: "rule-trigger" }
			| { readonly kind: "case-property"; readonly property: string }
			| { readonly kind: "specific-date"; readonly date: string };
		readonly events: readonly AutomationTimedEvent[];
	},
	ctx: z.RefinementCtx,
): void {
	const setupForm = timedScheduleSetupForm(schedule);
	const first = schedule.events[0];
	if (first === undefined) return;
	validateScheduleContentMode(schedule.events, ctx);
	if (schedule.totalIterations === 1) {
		const expectedRepeat =
			setupForm === "monthly"
				? -1
				: setupForm === "weekly"
					? 7
					: (schedule.events.at(-1)?.day ?? 0) + 1;
		if (schedule.repeatEvery !== expectedRepeat) {
			ctx.addIssue({
				code: "custom",
				path: ["repeatEvery"],
				message:
					"A one-iteration schedule must use the repeat value CommCare HQ derives when Repeat is off.",
			});
		}
	}

	for (const [index, event] of schedule.events.entries()) {
		const dayIsValid =
			setupForm === "monthly"
				? (event.day >= 1 && event.day <= 28) ||
					(event.day >= -3 && event.day <= -1)
				: setupForm === "weekly"
					? event.day >= 0 && event.day <= 6
					: event.day >= 0 && event.day < schedule.repeatEvery;
		if (!dayIsValid) {
			ctx.addIssue({
				code: "custom",
				path: ["events", index, "day"],
				message:
					setupForm === "monthly"
						? "A monthly event day must be 1–28 or -3–-1 from month end."
						: setupForm === "weekly"
							? "A weekly event day offset must be 0–6."
							: "A custom-daily event day must fit inside the repeat interval.",
			});
		}
		if (event.timing.kind !== first.timing.kind) {
			ctx.addIssue({
				code: "custom",
				path: ["events", index, "timing", "kind"],
				message: "Every timed event must use the schedule's one timing mode.",
			});
		}
	}

	if (setupForm === "monthly" || setupForm === "weekly") {
		if (schedule.startOffsetDays !== 0) {
			ctx.addIssue({
				code: "custom",
				path: ["startOffsetDays"],
				message: `${setupForm === "monthly" ? "Monthly" : "Weekly"} schedules do not accept a start offset in CommCare HQ.`,
			});
		}
		for (const [index, event] of schedule.events.entries()) {
			if (!sameJsonValue(event.timing, first.timing)) {
				ctx.addIssue({
					code: "custom",
					path: ["events", index, "timing"],
					message: `${setupForm === "monthly" ? "Monthly" : "Weekly"} schedules use one shared send timing.`,
				});
			}
			if (!sameJsonValue(event.content, first.content)) {
				ctx.addIssue({
					code: "custom",
					path: ["events", index, "content"],
					message: `${setupForm === "monthly" ? "Monthly" : "Weekly"} schedules use one shared content definition.`,
				});
			}
		}
		if (
			new Set(schedule.events.map((event) => event.day)).size !==
			schedule.events.length
		) {
			ctx.addIssue({
				code: "custom",
				path: ["events"],
				message: `${setupForm === "monthly" ? "Monthly" : "Weekly"} schedules can select each day only once.`,
			});
		}
	}

	if (setupForm === "monthly") {
		if (schedule.startDayOfWeek !== -1) {
			ctx.addIssue({
				code: "custom",
				path: ["startDayOfWeek"],
				message: "Monthly schedules do not accept a start weekday.",
			});
		}
		const expectedOrder = [...schedule.events]
			.sort((left, right) => {
				if (left.day > 0 && right.day < 0) return -1;
				if (left.day < 0 && right.day > 0) return 1;
				return left.day - right.day;
			})
			.map((event) => event.uuid);
		if (
			expectedOrder.some((uuid, index) => uuid !== schedule.events[index]?.uuid)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["events"],
				message:
					"Monthly events must list positive days first, then month-end days, each in ascending order.",
			});
		}
		return;
	}

	if (setupForm === "weekly") {
		if (schedule.repeatEvery % 7 !== 0) {
			ctx.addIssue({
				code: "custom",
				path: ["repeatEvery"],
				message:
					"A weekly repeat interval must contain a whole number of weeks.",
			});
		}
		if (
			schedule.start.kind === "specific-date" &&
			(new Date(`${schedule.start.date}T00:00:00Z`).getUTCDay() + 6) % 7 !==
				schedule.startDayOfWeek
		) {
			ctx.addIssue({
				code: "custom",
				path: ["startDayOfWeek"],
				message:
					"For a specific start date, the weekly start weekday must be that date's weekday.",
			});
		}
	}

	if (
		setupForm === "custom-daily" &&
		((schedule.start.kind === "specific-date" &&
			schedule.startOffsetDays !== 0) ||
			(schedule.start.kind === "rule-trigger" && schedule.startOffsetDays < 0))
	) {
		ctx.addIssue({
			code: "custom",
			path: ["startOffsetDays"],
			message:
				schedule.start.kind === "specific-date"
					? "A specific start date does not accept a separate start offset."
					: "A rule-triggered schedule cannot start before the rule matches.",
		});
	}

	for (let index = 1; index < schedule.events.length; index += 1) {
		const previous = schedule.events[index - 1];
		const current = schedule.events[index];
		if (previous === undefined || current === undefined) continue;
		if (first.timing.kind === "case-property-time") {
			if (current.day < previous.day) {
				ctx.addIssue({
					code: "custom",
					path: ["events", index, "day"],
					message: "Timed events must be in day order.",
				});
			}
			continue;
		}
		if (
			previous.timing.kind === "case-property-time" ||
			current.timing.kind === "case-property-time"
		) {
			continue;
		}
		const previousStart =
			previous.day * 1_440 + timeInMinutes(previous.timing.time);
		const currentStart =
			current.day * 1_440 + timeInMinutes(current.timing.time);
		if (currentStart < previousStart) {
			ctx.addIssue({
				code: "custom",
				path: ["events", index, "timing", "time"],
				message: "Timed events must be in chronological order.",
			});
		} else if (currentStart - previousStart < 5) {
			ctx.addIssue({
				code: "custom",
				path: ["events", index, "timing", "time"],
				message:
					"Fixed and random event starts must be at least 5 minutes apart.",
			});
		}
		if (
			previous.timing.kind === "random-window" &&
			current.timing.kind === "random-window" &&
			previousStart + previous.timing.windowMinutes > currentStart
		) {
			ctx.addIssue({
				code: "custom",
				path: ["events", index - 1, "timing", "windowMinutes"],
				message: "A random window cannot overlap the next event's window.",
			});
		}
	}
}

export const automationScheduleSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("immediate"),
			events: z.array(automationImmediateEventSchema).min(1).max(100),
		})
		.strict()
		.superRefine((schedule, ctx) => {
			validateScheduleContentMode(schedule.events, ctx);
			for (const [index, event] of schedule.events.entries()) {
				if (index > 0 && event.minutesToWait < 5) {
					ctx.addIssue({
						code: "custom",
						path: ["events", index, "minutesToWait"],
						message:
							"Every immediate event after the first must wait at least 5 minutes.",
					});
				}
			}
		}),
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
		.superRefine(validateTimedSchedule),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

export function automationTimedScheduleSetupForm(
	schedule: Extract<AutomationSchedule, { kind: "timed" }>,
): TimedScheduleSetupForm {
	return timedScheduleSetupForm(schedule);
}

function isHqUserFilterPropertyReference(value: string): boolean {
	return value.startsWith("{") && value.endsWith("}");
}

/**
 * One accepted value for HQ's worker-data recipient filter.
 *
 * HQ overloads a brace-wrapped string as a live lookup in the triggering
 * case's dynamic data and treats the empty string as missing/unset worker
 * data. Keep that distinction structural so literal prose cannot begin
 * executing after projection and property renames retain identity.
 */
export const automationUserDataFilterValueSchema = z.discriminatedUnion(
	"kind",
	[
		z
			.object({
				kind: z.literal("literal"),
				value: z
					.string()
					.max(4_096)
					.refine((candidate) => !isHqUserFilterPropertyReference(candidate), {
						message:
							"A brace-wrapped HQ filter value is a live case-property lookup. Insert a case-property value instead, or change the literal text.",
					}),
			})
			.strict(),
		z
			.object({
				kind: z.literal("case-property"),
				caseType: z.string().min(1).max(126),
				property: z.string().min(1).max(126),
			})
			.strict(),
	],
);
export type AutomationUserDataFilterValue = z.infer<
	typeof automationUserDataFilterValueSchema
>;

export const automationUserDataFilterSchema = z
	.object({
		uuid: uuidSchema,
		userPropertyUuid: uuidSchema,
		values: z.array(automationUserDataFilterValueSchema).min(1).max(250),
	})
	.strict()
	.superRefine((filter, ctx) => {
		const seen = new Set<string>();
		for (const [index, value] of filter.values.entries()) {
			const key = JSON.stringify(value);
			if (seen.has(key)) {
				ctx.addIssue({
					code: "custom",
					path: ["values", index],
					message:
						"Each accepted recipient-filter value must be unique within its worker property.",
				});
			}
			seen.add(key);
		}
	});
export type AutomationUserDataFilter = z.infer<
	typeof automationUserDataFilterSchema
>;

export const AUTOMATION_SETUP_ONLY_CRITERION_KINDS = [
	"ucr-filter",
	"registered-custom",
] as const;

const automationSetupOnlyCriterionCommon = {
	uuid: uuidSchema,
	text: z
		.string()
		.max(AUTOMATION_SETUP_NOTE_MAX_LENGTH)
		.refine((value) => value.trim().length > 0 && value === value.trim(), {
			message:
				"An HQ-only condition must be nonblank and have no surrounding whitespace.",
		}),
} as const;

export const automationSetupOnlyCriterionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...automationSetupOnlyCriterionCommon,
			kind: z.literal("ucr-filter"),
		})
		.strict(),
	z
		.object({
			...automationSetupOnlyCriterionCommon,
			kind: z.literal("registered-custom"),
		})
		.strict(),
]);

const automationCommon = {
	uuid: uuidSchema,
	name: z
		.string()
		.min(1, "Enter an automation name.")
		.max(
			AUTOMATION_NAME_MAX_LENGTH,
			`Keep the automation name under ${AUTOMATION_NAME_MAX_LENGTH + 1} characters.`,
		)
		.refine((name) => name === name.trim() && name.length > 0, {
			message:
				"Enter a nonblank automation name without surrounding whitespace.",
		}),
	caseType: z.string().min(1).max(126),
	criteriaOperator: z.enum(AUTOMATION_CRITERIA_OPERATORS),
	/**
	 * UCR and instance-registered custom criteria have no portable schema. Their
	 * family is structural while their exact configuration remains explicit
	 * setup-artifact prose, always named as omitted from Nova's current-match
	 * count.
	 */
	setupOnlyCriteria: z.array(automationSetupOnlyCriterionSchema).max(100),
} as const;

function validateHtmlCriteriaShape(
	automation: { readonly criteria: readonly AutomationCriterion[] },
	ctx: z.RefinementCtx,
): void {
	const closedParents = automation.criteria.filter(
		(criterion) => criterion.kind === "closed-parent",
	);
	if (closedParents.length > 1) {
		ctx.addIssue({
			code: "custom",
			path: ["criteria"],
			message:
				"CommCare HQ's setup form accepts only one closed-parent condition.",
		});
	}
	const locations = automation.criteria.filter(
		(criterion) => criterion.kind === "location",
	);
	if (locations.length > 1) {
		ctx.addIssue({
			code: "custom",
			path: ["criteria"],
			message:
				"CommCare HQ accepts only one location condition per automation.",
		});
	}
}

const CONNECT_INCOMPATIBLE_RECIPIENT_KINDS = new Set<
	AutomationRecipient["kind"]
>([
	"self",
	"parent-case",
	"all-child-cases",
	"case-property-email",
	"case-group",
]);

export function automationRecipientSupportsConnect(
	kind: AutomationRecipient["kind"],
): boolean {
	return !CONNECT_INCOMPATIBLE_RECIPIENT_KINDS.has(kind);
}

function validateConditionalAlert(
	automation: {
		readonly criteria: readonly AutomationCriterion[];
		readonly recipients: readonly AutomationRecipient[];
		readonly schedule: AutomationSchedule;
		readonly includeDescendantLocations: boolean;
		readonly locationLevelUuids: readonly Uuid[];
		readonly userDataFilters: readonly AutomationUserDataFilter[];
		readonly resetCaseProperty?: string;
	},
	ctx: z.RefinementCtx,
): void {
	validateHtmlCriteriaShape(automation, ctx);
	const recipientKeys = new Set<string>();
	for (const [index, recipient] of automation.recipients.entries()) {
		const key = automationRecipientSetupKey(recipient);
		if (recipientKeys.has(key)) {
			ctx.addIssue({
				code: "custom",
				path: ["recipients", index],
				message:
					"CommCare HQ's setup form accepts each singleton recipient or concrete recipient target only once.",
			});
		} else {
			recipientKeys.add(key);
		}
	}

	const hasLocationRecipient = automation.recipients.some(
		(recipient) => recipient.kind === "location",
	);
	if (automation.includeDescendantLocations && !hasLocationRecipient) {
		ctx.addIssue({
			code: "custom",
			path: ["includeDescendantLocations"],
			message:
				"CommCare HQ enables descendant locations only for a location recipient.",
		});
	}
	if (
		automation.locationLevelUuids.length > 0 &&
		(!hasLocationRecipient || !automation.includeDescendantLocations)
	) {
		ctx.addIssue({
			code: "custom",
			path: ["locationLevelUuids"],
			message:
				"CommCare HQ enables location-level filters only when a location recipient includes descendants.",
		});
	}
	const seenLocationLevels = new Set<Uuid>();
	for (const [index, levelUuid] of automation.locationLevelUuids.entries()) {
		if (seenLocationLevels.has(levelUuid)) {
			ctx.addIssue({
				code: "custom",
				path: ["locationLevelUuids", index],
				message:
					"CommCare HQ's location-level picker accepts each level only once.",
			});
		} else {
			seenLocationLevels.add(levelUuid);
		}
	}

	const seenUserProperties = new Set<Uuid>();
	for (const [index, filter] of automation.userDataFilters.entries()) {
		if (seenUserProperties.has(filter.userPropertyUuid)) {
			ctx.addIssue({
				code: "custom",
				path: ["userDataFilters", index, "userPropertyUuid"],
				message:
					"CommCare HQ's user-data filter accepts one value list per worker property.",
			});
		} else {
			seenUserProperties.add(filter.userPropertyUuid);
		}
	}

	const usesConnect = automation.schedule.events.some(
		(event) =>
			event.content.kind === "connect-message" ||
			event.content.kind === "connect-survey",
	);
	if (usesConnect) {
		for (const [index, recipient] of automation.recipients.entries()) {
			if (!automationRecipientSupportsConnect(recipient.kind)) {
				ctx.addIssue({
					code: "custom",
					path: ["recipients", index, "kind"],
					message: `${recipient.kind} recipients cannot receive Connect messages or surveys in CommCare HQ.`,
				});
			}
		}
	}
	if (
		automation.resetCaseProperty !== undefined &&
		automation.schedule.kind === "timed" &&
		automation.schedule.start.kind !== "rule-trigger"
	) {
		ctx.addIssue({
			code: "custom",
			path: ["resetCaseProperty"],
			message:
				"CommCare HQ can restart a timed schedule only when it starts from the rule trigger.",
		});
	}
}

export const automationSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...automationCommon,
			kind: z.literal("case-update"),
			criteria: z.array(automationCaseUpdateCriterionSchema).max(100),
			/** HQ-only server-modified age, deliberately outside `criteria`. */
			serverModifiedBoundaryDays: persistableJsonNonnegativeIntegerSchema
				.max(36_500)
				.optional(),
			updates: z.array(automationCaseUpdateSchema).max(250),
			closeCase: z.boolean(),
		})
		.strict()
		.superRefine(validateHtmlCriteriaShape)
		.refine((rule) => rule.closeCase || rule.updates.length > 0, {
			message:
				"A case-update rule must close the case or write at least one property.",
		}),
	z
		.object({
			...automationCommon,
			kind: z.literal("conditional-alert"),
			criteria: z.array(automationAlertCriterionSchema).max(100),
			recipients: z.array(automationRecipientSchema).min(1).max(250),
			schedule: automationScheduleSchema,
			includeDescendantLocations: z.boolean(),
			locationLevelUuids: z.array(uuidSchema).max(100),
			defaultLanguageCode: z
				.string()
				.max(126)
				.refine((value) => value.trim().length > 0 && value === value.trim(), {
					message:
						"A default language code must be nonblank and have no surrounding whitespace.",
				})
				.optional(),
			userDataFilters: z.array(automationUserDataFilterSchema).max(100),
			useUserCaseForFilter: z.boolean(),
			resetCaseProperty: z.string().min(1).max(126).optional(),
			stopDateCaseProperty: z.string().min(1).max(126).optional(),
		})
		.strict()
		.superRefine(validateConditionalAlert),
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
