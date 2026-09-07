import { current, type Draft, isDraft, type WritableDraft } from "immer";
import type { AutomationFormChoice } from "@/lib/automations/formChoices";
import {
	type Automation,
	type AutomationContent,
	type AutomationRecipient,
	type AutomationSchedule,
	type AutomationTimedEvent,
	asUuid,
	automationAlertCriterionSchema,
	automationCaseUpdateCriterionSchema,
	automationMessageText,
	automationRecipientKindIsSingleton,
	automationRecipientSupportsConnect,
	automationRecipientSupportsUserDataFilter,
	type CaseType,
	type Uuid,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { formatClockTime } from "@/lib/ui/clockTime";

type ChoiceOption = readonly [value: string, label: string, disabled?: boolean];

export function cloneEditableValue<T>(value: T): T {
	return structuredClone(isDraft(value) ? current(value as Draft<T>) : value);
}

export function timedEventComparator(
	setupForm: "custom-daily" | "weekly" | "monthly",
	left: AutomationTimedEvent,
	right: AutomationTimedEvent,
): number {
	if (setupForm === "monthly") {
		const rank = (day: number) => (day > 0 ? day : 32 + day);
		return rank(left.day) - rank(right.day);
	}
	if (left.day !== right.day) return left.day - right.day;
	const minute = (event: AutomationTimedEvent) => {
		if (event.timing.kind === "case-property-time") return 0;
		const [hours = 0, minutes = 0] = event.timing.time.split(":").map(Number);
		return hours * 60 + minutes;
	};
	return minute(left) - minute(right);
}

export function localIsoDate(date = new Date()): string {
	return `${String(date.getFullYear()).padStart(4, "0")}-${String(
		date.getMonth() + 1,
	).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function weekdayIndexForIsoDate(date: string): number {
	return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function remapWeeklyEventOffsets(
	schedule: WritableDraft<Extract<AutomationSchedule, { kind: "timed" }>>,
	startDayOfWeek: number,
): void {
	const previousStart = schedule.startDayOfWeek;
	for (const event of schedule.events) {
		const absoluteWeekday = (previousStart + event.day) % 7;
		event.day = (absoluteWeekday - startDayOfWeek + 7) % 7;
	}
	schedule.startDayOfWeek = startDayOfWeek;
	schedule.events.sort((left, right) =>
		timedEventComparator("weekly", left, right),
	);
}

export function automationTimeText(value: string): string {
	if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
	return formatClockTime(`${value}:00.000Z`) ?? value;
}

export function uuid(): Uuid {
	return asUuid(crypto.randomUUID());
}

export function newCaseUpdate(
	caseType: string,
): Extract<Automation, { kind: "case-update" }> {
	return {
		uuid: uuid(),
		kind: "case-update",
		name: "New case update",
		caseType,
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		updates: [],
		closeCase: true,
	};
}

export function newAlert(
	caseType: string,
): Extract<Automation, { kind: "conditional-alert" }> {
	return {
		uuid: uuid(),
		kind: "conditional-alert",
		name: "New conditional alert",
		caseType,
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: uuid(), kind: "self" }],
		schedule: {
			kind: "immediate",
			events: [
				{
					uuid: uuid(),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Message") },
				},
			],
		},
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [],
		useUserCaseForFilter: false,
	};
}

export function changeNewAutomationKind(
	automation: Automation,
	kind: Automation["kind"],
): Automation {
	if (automation.kind === kind) return automation;
	const defaultName =
		automation.kind === "case-update"
			? "New case update"
			: "New conditional alert";
	const preservedName =
		automation.name === defaultName ? undefined : automation.name;
	const shared = {
		uuid: automation.uuid,
		criteriaOperator: automation.criteriaOperator,
		setupOnlyCriteria: automation.setupOnlyCriteria,
	};
	if (kind === "case-update") {
		const next = newCaseUpdate(automation.caseType);
		return {
			...next,
			...shared,
			name: preservedName ?? next.name,
			criteria: automation.criteria.flatMap((criterion) => {
				const result = automationCaseUpdateCriterionSchema.safeParse(criterion);
				return result.success ? [result.data] : [];
			}),
		};
	}
	const next = newAlert(automation.caseType);
	return {
		...next,
		...shared,
		name: preservedName ?? next.name,
		criteria: automation.criteria.flatMap((criterion) => {
			const result = automationAlertCriterionSchema.safeParse(criterion);
			return result.success ? [result.data] : [];
		}),
	};
}

export function pathStartsWith(
	path: readonly PropertyKey[],
	prefix: readonly PropertyKey[],
): boolean {
	return (
		prefix.length <= path.length &&
		prefix.every((segment, index) => path[index] === segment)
	);
}

export function automationCommitErrorPath(
	result: {
		readonly findings?: readonly {
			readonly details?: Readonly<Record<string, string>>;
		}[];
	},
	automationUuid: Uuid,
): readonly PropertyKey[] {
	const findings = result.findings ?? [];
	const finding =
		findings.find(
			(candidate) => candidate.details?.automationUuid === automationUuid,
		) ?? findings.find((candidate) => candidate.details?.path === "name");
	const path = finding?.details?.path;
	if (path === undefined) return [];
	return path
		.split(".")
		.filter((segment) => segment.length > 0)
		.map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

export function parseReminderIntervalDraft(
	value: string,
):
	| { readonly ok: true; readonly intervals: readonly number[] }
	| { readonly ok: false } {
	if (value.trim() === "") return { ok: true, intervals: [] };
	const parts = value.split(",");
	const intervals: number[] = [];
	for (const [index, part] of parts.entries()) {
		const token = part.trim();
		if (token === "" && index === parts.length - 1) continue;
		if (!/^[1-9]\d*$/.test(token)) return { ok: false };
		const interval = Number(token);
		if (!Number.isSafeInteger(interval)) return { ok: false };
		intervals.push(interval);
	}
	return intervals.length <= 100 ? { ok: true, intervals } : { ok: false };
}

export function automationLocationOptions(
	locations: readonly StoredLocation[],
	selectedUuid?: Uuid,
): readonly ChoiceOption[] {
	const options: ChoiceOption[] = locations.map((location) => [
		location.id,
		`${location.name} (${location.siteCode})`,
	]);
	if (
		selectedUuid !== undefined &&
		!locations.some((location) => location.id === selectedUuid)
	) {
		options.unshift([selectedUuid, "Saved place unavailable", true]);
	}
	return options;
}

export function automationMessageReferenceCaseType(
	caseTypes: readonly CaseType[],
	automationCaseType: string,
	scope: "case" | "parent" | "host",
): string {
	if (scope === "case") return automationCaseType;
	const source = caseTypes.find(
		(caseType) => caseType.name === automationCaseType,
	);
	if (source?.parent_type === undefined) return "";
	if (
		(scope === "host" && source.relationship === "extension") ||
		(scope === "parent" && source.relationship !== "extension")
	) {
		return source.parent_type;
	}
	return "";
}

export function updateAutomationContextReferenceCaseTypes(
	automation: WritableDraft<Automation>,
	caseTypes: readonly CaseType[],
	automationCaseType: string,
): void {
	if (automation.kind !== "conditional-alert") return;
	for (const filter of automation.userDataFilters) {
		for (const value of filter.values) {
			if (value.kind === "case-property") value.caseType = automationCaseType;
		}
	}
	for (const event of automation.schedule.events) {
		const templates =
			event.content.kind === "email"
				? [
						event.content.subject,
						event.content.body.kind === "plain-text"
							? event.content.body.message
							: event.content.body.html,
					]
				: event.content.kind === "sms" ||
						event.content.kind === "sms-callback" ||
						event.content.kind === "connect-message"
					? [event.content.message]
					: [];
		for (const template of templates) {
			for (const part of template.parts) {
				if (part.kind !== "case-property") continue;
				part.caseType = automationMessageReferenceCaseType(
					caseTypes,
					automationCaseType,
					part.scope,
				);
			}
		}
	}
}

export function recipientFor(
	kind: AutomationRecipient["kind"],
	locations: readonly StoredLocation[],
	existingRecipients: readonly AutomationRecipient[],
): AutomationRecipient | undefined {
	const id = uuid();
	if (
		[
			"self",
			"owner",
			"last-submitting-user",
			"parent-case",
			"all-child-cases",
		].includes(kind)
	)
		return { uuid: id, kind } as AutomationRecipient;
	if (
		[
			"case-property-username",
			"case-property-user-id",
			"case-property-email",
		].includes(kind)
	)
		return { uuid: id, kind, property: "case_name" } as AutomationRecipient;
	if (kind === "location") {
		const availableLocation = locations.find(
			(location) =>
				!existingRecipients.some(
					(recipient) =>
						recipient.kind === "location" &&
						recipient.locationUuid === location.id,
				),
		);
		return availableLocation
			? { uuid: id, kind, locationUuid: asUuid(availableLocation.id) }
			: undefined;
	}
	if (["mobile-worker", "user-group", "case-group"].includes(kind)) {
		return {
			uuid: id,
			kind,
			hqId: "",
		} as AutomationRecipient;
	}
	return { uuid: id, kind: "custom", registeredId: "" };
}

export function recipientKindAvailable(
	kind: AutomationRecipient["kind"],
	recipients: readonly AutomationRecipient[],
	locations: readonly StoredLocation[],
	usesConnect: boolean,
	usesUserDataFilters: boolean,
	excludeUuid?: Uuid,
): boolean {
	if (usesConnect && !automationRecipientSupportsConnect(kind)) return false;
	if (usesUserDataFilters && !automationRecipientSupportsUserDataFilter(kind))
		return false;
	const peers = recipients.filter(
		(recipient) => recipient.uuid !== excludeUuid,
	);
	if (
		automationRecipientKindIsSingleton(kind) &&
		peers.some((recipient) => recipient.kind === kind)
	) {
		return false;
	}
	if (kind === "location") {
		return locations.some(
			(location) =>
				!peers.some(
					(recipient) =>
						recipient.kind === "location" &&
						recipient.locationUuid === location.id,
				),
		);
	}
	return true;
}

export function clearLocationSettingsWithoutRecipient(
	draft: WritableDraft<Automation>,
): void {
	if (
		draft.kind === "conditional-alert" &&
		!draft.recipients.some((recipient) => recipient.kind === "location")
	) {
		draft.includeDescendantLocations = false;
		draft.locationLevelUuids = [];
	}
}

export function contentFor(
	kind: AutomationContent["kind"],
	forms: readonly AutomationFormChoice[],
): AutomationContent | undefined {
	if (kind === "sms")
		return { kind, message: automationMessageText("Message") };
	if (kind === "email")
		return {
			kind,
			subject: automationMessageText("Subject"),
			body: {
				kind: "plain-text",
				message: automationMessageText("Message"),
			},
		};
	if (kind === "connect-message")
		return { kind, message: automationMessageText("Message") };
	if (kind === "custom") return { kind, registeredId: "" };
	if (kind === "sms-callback")
		return {
			kind,
			message: automationMessageText("Message"),
			reminderIntervalsMinutes: [5],
		};
	const formUuid = forms[0]?.uuid;
	if (formUuid === undefined) return undefined;
	if (kind === "ivr")
		return {
			kind,
			formUuid,
			reminderIntervalsMinutes: [5],
			submitPartiallyCompletedForms: false,
			includeCaseUpdatesInPartialSubmissions: false,
			maxQuestionAttempts: 3,
		};
	return {
		kind,
		formUuid,
		expirationHours: 24,
		reminderIntervalsMinutes: [],
		submitPartiallyCompletedForms: false,
		includeCaseUpdatesInPartialSubmissions: false,
	} as AutomationContent;
}
