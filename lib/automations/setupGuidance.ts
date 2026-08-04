import type {
	Automation,
	AutomationContent,
	AutomationCriterion,
	AutomationRecipient,
	BlueprintDoc,
} from "@/lib/domain";
import { ownRecordValue, userPropertiesOf } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";

export interface AutomationSetupGuide {
	readonly title: string;
	readonly requiredPlan: string;
	readonly steps: readonly string[];
	readonly caveats: readonly string[];
}

function locationName(
	locations: readonly StoredLocation[],
	uuid: string,
): string {
	const location = locations.find((candidate) => candidate.id === uuid);
	return location === undefined
		? `the location with Nova id ${uuid}`
		: `“${location.name}” (site code ${location.siteCode}; Nova id ${uuid})`;
}

function describeCriterion(
	criterion: AutomationCriterion,
	locations: readonly StoredLocation[],
): string {
	if (criterion.kind === "closed-parent") {
		return `The ${criterion.identifier} ${criterion.relationship} index points to a closed ${criterion.parentCaseType} case.`;
	}
	if (criterion.kind === "location") {
		return `The case owner belongs to ${locationName(locations, criterion.locationUuid)}${criterion.includeDescendants ? " or one of its descendants" : ""}.`;
	}
	const values: Record<typeof criterion.matchType, string> = {
		equal: `equals “${criterion.value ?? ""}”`,
		"not-equal": `does not equal “${criterion.value ?? ""}”`,
		"has-value": "has a value",
		"has-no-value": "has no value",
		regex: `matches the regular expression ${criterion.value ?? ""}`,
		"date-days-before": `is later than today plus ${criterion.days ?? 0} days`,
		"date-days-lte": `is today plus ${criterion.days ?? 0} days or later`,
		"date-days-gt": `is earlier than today plus ${criterion.days ?? 0} days`,
		"date-days": `is today plus ${criterion.days ?? 0} days or earlier`,
	};
	return `Case property ${criterion.property} ${values[criterion.matchType]}.`;
}

function describeRecipient(
	recipient: AutomationRecipient,
	locations: readonly StoredLocation[],
): string {
	switch (recipient.kind) {
		case "self":
			return "The case";
		case "owner":
			return "The case’s owner";
		case "last-submitting-user":
			return "The case’s last submitting user";
		case "parent-case":
			return "The case’s parent case";
		case "all-child-cases":
			return "All child cases";
		case "case-property-username":
			return `Username in case property ${recipient.property}`;
		case "case-property-user-id":
			return `User id in case property ${recipient.property}`;
		case "case-property-email":
			return `Email address in case property ${recipient.property}`;
		case "location":
			return `Location ${locationName(locations, recipient.locationUuid)}`;
		case "mobile-worker":
			return `Mobile worker ${recipient.hqId}`;
		case "web-user":
			return `Web user ${recipient.hqId}`;
		case "user-group":
			return `User group ${recipient.hqId}`;
		case "case-group":
			return `Case group ${recipient.hqId}`;
		case "custom":
			return `Registered custom recipient ${recipient.registeredId}`;
	}
}

function describeContent(
	content: AutomationContent,
	doc: BlueprintDoc,
): string {
	switch (content.kind) {
		case "sms":
			return `SMS: ${content.message}`;
		case "email":
			return `Email subject “${content.subject}”; plain message “${content.message}”${content.htmlMessage === undefined ? "" : "; HTML message supplied"}`;
		case "sms-survey":
		case "ivr":
		case "connect-survey": {
			const form = ownRecordValue(doc.forms, content.formUuid);
			return `${content.kind}: choose Nova form “${form?.name ?? content.formUuid}” (${content.formUuid})`;
		}
		case "sms-callback":
			return `SMS/callback: ${content.message}; retry after ${content.reminderIntervalsMinutes.join(", ")} minutes`;
		case "connect-message":
			return `Connect message: ${content.message}`;
		case "custom":
			return `Registered custom content ${content.registeredId}`;
	}
}

function commonSteps(
	automation: Automation,
	locations: readonly StoredLocation[],
): string[] {
	const steps = [
		`Name the rule “${automation.name}” and choose case type ${automation.caseType}.`,
		`Set criteria matching to ${automation.criteriaOperator === "all" ? "ALL" : "ANY"}.`,
	];
	if (automation.criteria.length === 0) {
		steps.push("Add no ordinary criteria rows.");
	} else {
		steps.push(
			...automation.criteria.map(
				(criterion, index) =>
					`Criterion ${index + 1}: ${describeCriterion(criterion, locations)}`,
			),
		);
	}
	steps.push(
		...automation.setupOnlyCriteria.map(
			(criterion, index) =>
				`Setup-only criterion ${index + 1}: ${criterion.text}`,
		),
	);
	if (automation.serverModifiedBoundaryDays !== undefined) {
		steps.push(
			`Turn on “filter on server modified” and set the boundary to ${automation.serverModifiedBoundaryDays} days.`,
		);
	}
	return steps;
}

export function buildAutomationSetupGuide(
	doc: BlueprintDoc,
	automation: Automation,
	locations: readonly StoredLocation[],
): AutomationSetupGuide {
	const steps = commonSteps(automation, locations);
	const caveats = [
		"Nova does not run this automation in Preview and publishing the app does not install it. Save it manually in the target CommCare HQ project.",
		"CommCare HQ has no REST resource for rules, alerts, or schedules. The available editors are HTML pages; conditional alerts also have an Excel content upload.",
	];
	if (automation.serverModifiedBoundaryDays !== undefined) {
		caveats.push(
			"Server-modified age is measured from the case’s latest server modification, not from a claimed-at or other business date.",
		);
	}

	if (automation.kind === "case-update") {
		steps.unshift(
			"In CommCare HQ, open Data → Edit Data → Automatic Case Update Rules, then add a rule.",
		);
		for (const update of automation.updates) {
			const target =
				update.target.scope === "case"
					? update.target.property
					: `${update.target.scope}/${update.target.property}`;
			const value =
				update.value.kind === "literal"
					? `the literal “${update.value.value}”`
					: `the value of ${update.value.source.scope === "case" ? "" : `${update.value.source.scope}/`}${update.value.source.property}`;
			steps.push(`Update ${target} to ${value}.`);
		}
		if (automation.closeCase) steps.push("Turn on Close case.");
		steps.push(
			automation.runOnSave
				? "Turn on the run-on-save option. Keep the daily sweep enabled as recovery for cases changed outside that path."
				: "Leave the run-on-save option off unless the target project explicitly needs immediate processing.",
		);
		caveats.push(
			"Case-update rules require the Data Cleanup privilege (Pro or higher). HQ’s hourly task runs each project once daily at auto_case_update_hour, midnight UTC by default.",
			"HQ processes at most 10,000 updates per project, case type, and database partition in one run unless the project’s auto_case_update_limit overrides it. Hitting the cap halts that run and the next daily sweep tries again.",
		);
		return {
			title: `${automation.name}: Automatic Case Update Rule`,
			requiredPlan: "Data Cleanup (Pro or higher)",
			steps,
			caveats,
		};
	}

	steps.unshift(
		"In CommCare HQ, open Messaging → Conditional Alerts, then add an alert.",
	);
	steps.push(
		`Recipients: ${automation.recipients.map((recipient) => describeRecipient(recipient, locations)).join("; ")}.`,
	);
	if (automation.schedule.kind === "immediate") {
		steps.push(
			...automation.schedule.events.map(
				(event, index) =>
					`Immediate event ${index + 1}: wait ${event.minutesToWait} minutes after the previous event, then send ${describeContent(event.content, doc)}.`,
			),
		);
	} else {
		const start =
			automation.schedule.start.kind === "rule-trigger"
				? "the day the rule first matches"
				: automation.schedule.start.kind === "specific-date"
					? automation.schedule.start.date
					: `the date in case property ${automation.schedule.start.property}`;
		steps.push(
			`Use a timed schedule starting from ${start}: repeat every ${Math.abs(automation.schedule.repeatEvery)} ${automation.schedule.repeatEvery < 0 ? "month(s)" : "day(s)"}, ${automation.schedule.totalIterations === -1 ? "indefinitely" : `${automation.schedule.totalIterations} iteration(s)`}, with start offset ${automation.schedule.startOffsetDays} days and start weekday ${automation.schedule.startDayOfWeek}.`,
			...automation.schedule.events.map(
				(event, index) =>
					`Timed event ${index + 1}, day ${event.day}, ${JSON.stringify(event.timing)}: send ${describeContent(event.content, doc)}.`,
			),
		);
	}
	if (automation.userDataFilters.length > 0) {
		const properties = userPropertiesOf(doc);
		steps.push(
			`Filter recipients using ${automation.useUserCaseForFilter ? "user-case properties" : "custom user data"}: ${automation.userDataFilters
				.map((filter) => {
					const property = ownRecordValue(properties, filter.userPropertyUuid);
					return `${property?.slug ?? filter.userPropertyUuid} in [${filter.allowedValues.join(", ")}]`;
				})
				.join("; ")}.`,
		);
	}
	if (automation.resetCaseProperty !== undefined) {
		steps.push(
			`Restart the schedule when case property ${automation.resetCaseProperty} changes.`,
		);
	}
	if (automation.stopDateCaseProperty !== undefined) {
		steps.push(
			`Stop the schedule after the date in case property ${automation.stopDateCaseProperty}.`,
		);
	}
	caveats.push(
		"Conditional alerts require Reminders Framework (Standard or higher). SMS delivery additionally requires Outbound SMS at send time; an email-only alert does not.",
		"Message templates may read {case.<property>}, case owner/parent/host fields, and {recipient.*}. Custom recipients and custom content must already be registered on the target HQ instance.",
	);
	if (
		automation.schedule.events.some(
			(event) =>
				event.content.kind === "ivr" || event.content.kind === "sms-callback",
		)
	) {
		caveats.push(
			"Current CommCare HQ keeps IVR and SMS/callback only to display historical configurations and refuses new activation. Choose a supported content type for a new alert.",
		);
	}
	return {
		title: `${automation.name}: Conditional Alert`,
		requiredPlan: "Reminders Framework (Standard or higher)",
		steps,
		caveats,
	};
}

export function renderAutomationSetupGuide(
	guide: AutomationSetupGuide,
): string {
	return [
		guide.title,
		`Required plan: ${guide.requiredPlan}`,
		"",
		"Setup steps",
		...guide.steps.map((step, index) => `${index + 1}. ${step}`),
		"",
		"Before you save",
		...guide.caveats.map((caveat) => `- ${caveat}`),
	].join("\n");
}
