import type {
	Automation,
	AutomationContent,
	AutomationCriterion,
	AutomationRecipient,
	AutomationTimedEvent,
	BlueprintDoc,
} from "@/lib/domain";
import {
	automationTimedScheduleSetupForm,
	organizationLevelsOf,
	ownRecordValue,
	userPropertiesOf,
} from "@/lib/domain";
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

function describeCriterion(criterion: AutomationCriterion): string {
	if (criterion.kind === "closed-parent") {
		return "The case's parent case is closed.";
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
	const property =
		criterion.scope === "case"
			? `Case property ${criterion.property}`
			: `${criterion.scope === "parent" ? "Parent" : "Host"} case property ${criterion.property}`;
	return `${property} ${values[criterion.matchType]}.`;
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
			return `SMS message ${JSON.stringify(content.message)}`;
		case "email":
			return `Email subject ${JSON.stringify(content.subject)}; plain-text message ${JSON.stringify(content.message)}${content.htmlMessage === undefined ? "; leave HTML message blank" : `; HTML message ${JSON.stringify(content.htmlMessage)}`}`;
		case "sms-survey":
		case "connect-survey": {
			const form = ownRecordValue(doc.forms, content.formUuid);
			return `${content.kind}: choose Nova form “${form?.name ?? content.formUuid}” (${content.formUuid}); expire after ${content.expirationHours} hour(s); reminder intervals ${content.reminderIntervalsMinutes.length === 0 ? "none" : `${content.reminderIntervalsMinutes.join(", ")} minute(s)`}; submit partially completed forms ${content.submitPartiallyCompletedForms ? "on" : "off"}; include case updates in partial submissions ${content.includeCaseUpdatesInPartialSubmissions ? "on" : "off"}`;
		}
		case "ivr": {
			const form = ownRecordValue(doc.forms, content.formUuid);
			return `ivr: choose Nova form “${form?.name ?? content.formUuid}” (${content.formUuid}); reminder intervals ${content.reminderIntervalsMinutes.length === 0 ? "none" : `${content.reminderIntervalsMinutes.join(", ")} minute(s)`}; submit partially completed forms ${content.submitPartiallyCompletedForms ? "on" : "off"}; include case updates in partial submissions ${content.includeCaseUpdatesInPartialSubmissions ? "on" : "off"}; maximum attempts per question ${content.maxQuestionAttempts}`;
		}
		case "sms-callback":
			return `SMS/callback message ${JSON.stringify(content.message)}; retry after ${content.reminderIntervalsMinutes.join(", ")} minutes`;
		case "connect-message":
			return `Connect message ${JSON.stringify(content.message)}`;
		case "custom":
			return `Registered custom content ${content.registeredId}`;
	}
}

function describeTiming(timing: AutomationTimedEvent["timing"]): string {
	switch (timing.kind) {
		case "specific-time":
			return `at ${timing.time}`;
		case "random-window":
			return `at a random time in the ${timing.windowMinutes}-minute window starting at ${timing.time}`;
		case "case-property-time":
			return `at the time stored in case property ${timing.property}`;
	}
}

function commonSteps(automation: Automation): string[] {
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
					`Criterion ${index + 1}: ${describeCriterion(criterion)}`,
			),
		);
	}
	steps.push(
		...automation.setupOnlyCriteria.map(
			(criterion, index) =>
				`Setup-only criterion ${index + 1}: ${criterion.text}`,
		),
	);
	if (
		automation.kind === "case-update" &&
		automation.serverModifiedBoundaryDays !== undefined
	) {
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
	const steps = commonSteps(automation);
	const caveats = [
		"Nova does not run this automation in Preview and publishing the app does not install it. Save it manually in the target CommCare HQ project.",
		"CommCare HQ has no REST resource for rules, alerts, or schedules. The available editors are HTML pages; conditional alerts also have an Excel content upload.",
	];
	if (
		automation.kind === "case-update" &&
		automation.serverModifiedBoundaryDays !== undefined
	) {
		caveats.push(
			"Server-modified age is measured from the case’s latest server modification, not from a claimed-at or other business date.",
		);
	}

	if (automation.kind === "case-update") {
		steps.unshift(
			"In CommCare HQ, open /a/<domain>/data/edit/automatic_updates/ (Data → Edit Data → Automatic Case Update Rules), then add a rule.",
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
		caveats.push(
			"Case-update rules require the Data Cleanup privilege (Pro or higher). HQ’s hourly task runs each project once daily at auto_case_update_hour, midnight UTC by default.",
			"HQ processes at most 10,000 updates per project, case type, and database partition in one run unless the project’s auto_case_update_limit overrides it. Hitting the cap halts that run and the next daily sweep tries again.",
			"HQ’s deprecated RUN_AUTO_CASE_UPDATES_ON_SAVE setting is project-wide, not part of this rule. If enabled for the target project, saving a case evaluates every active automatic-update rule for that case type; review that global blast radius separately.",
		);
		return {
			title: `${automation.name}: Automatic Case Update Rule`,
			requiredPlan: "Data Cleanup (Pro or higher)",
			steps,
			caveats,
		};
	}

	steps.unshift(
		"In CommCare HQ, open /a/<domain>/messaging/conditional/ (Messaging → Conditional Alerts), then add an alert.",
	);
	steps.push(
		`Recipients: ${automation.recipients.map((recipient) => describeRecipient(recipient, locations)).join("; ")}.`,
		`${automation.includeDescendantLocations ? "Include" : "Do not include"} descendant locations when expanding location recipients.`,
	);
	const levels = organizationLevelsOf(doc);
	steps.push(
		automation.locationLevelUuids.length === 0
			? "Apply no location-level restriction to broadcast recipients."
			: `Restrict broadcast recipients to these location levels: ${automation.locationLevelUuids
					.map((uuid) => {
						const level = ownRecordValue(levels, uuid);
						return level === undefined
							? `Nova level ${uuid}`
							: `“${level.name}” (${level.code}; Nova id ${uuid})`;
					})
					.join("; ")}.`,
		automation.defaultLanguageCode === undefined
			? "Leave the default language blank to use the target CommCare HQ project's default language."
			: `Set the default language code to ${automation.defaultLanguageCode}.`,
	);
	if (automation.schedule.kind === "immediate") {
		steps.push(
			automation.schedule.events.length === 1 &&
				automation.schedule.events[0]?.minutesToWait === 0
				? "Choose Immediately."
				: "Choose Custom Immediate Schedule so CommCare HQ exposes the delayed event rows.",
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
		const iterations =
			automation.schedule.totalIterations === 1
				? "turn Repeat off"
				: automation.schedule.totalIterations === -1
					? "continue indefinitely"
					: `stop after ${automation.schedule.totalIterations} iteration(s)`;
		const setupForm = automationTimedScheduleSetupForm(automation.schedule);
		if (setupForm === "custom-daily") {
			steps.push(
				`Choose Custom Daily Schedule, starting from ${start}, with a ${automation.schedule.startOffsetDays}-day start offset; ${automation.schedule.totalIterations === 1 ? iterations : `repeat every ${automation.schedule.repeatEvery} day(s) and ${iterations}`}. Set the schedule-wide timing mode to match the events below.`,
				...automation.schedule.events.map(
					(event, index) =>
						`Custom event ${index + 1}, day ${event.day + 1} in the HQ editor, ${describeTiming(event.timing)}: send ${describeContent(event.content, doc)}.`,
				),
			);
		} else if (setupForm === "weekly") {
			const weekdayNames = [
				"Monday",
				"Tuesday",
				"Wednesday",
				"Thursday",
				"Friday",
				"Saturday",
				"Sunday",
			] as const;
			const startDayOfWeek = automation.schedule.startDayOfWeek;
			const firstEvent = automation.schedule.events[0];
			steps.push(
				`Choose Weekly, starting from ${start}; begin the schedule week on ${weekdayNames[startDayOfWeek] ?? "the selected weekday"}, ${automation.schedule.totalIterations === 1 ? iterations : `repeat every ${automation.schedule.repeatEvery / 7} week(s), and ${iterations}`}.`,
				`Select these weekdays: ${automation.schedule.events
					.map(
						(event) =>
							weekdayNames[(startDayOfWeek + event.day) % 7] ??
							`offset ${event.day}`,
					)
					.join(", ")}.`,
			);
			if (firstEvent !== undefined) {
				steps.push(
					`Use the shared timing ${describeTiming(firstEvent.timing)} and shared content ${describeContent(firstEvent.content, doc)}.`,
				);
			}
		} else {
			const firstEvent = automation.schedule.events[0];
			steps.push(
				`Choose Monthly, starting from ${start}; ${automation.schedule.totalIterations === 1 ? iterations : `repeat every ${Math.abs(automation.schedule.repeatEvery)} month(s), and ${iterations}`}; select days ${automation.schedule.events.map((event) => event.day).join(", ")} (negative values count from month end).`,
			);
			if (firstEvent !== undefined) {
				steps.push(
					`Use the shared timing ${describeTiming(firstEvent.timing)} and shared content ${describeContent(firstEvent.content, doc)}.`,
				);
			}
		}
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
	} else {
		steps.push(
			`Add no ${automation.useUserCaseForFilter ? "user-case" : "custom-user-data"} recipient filters.`,
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
