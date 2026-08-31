import type {
	Automation,
	AutomationContent,
	AutomationCriterion,
	AutomationMessageTemplate,
	AutomationRecipient,
	AutomationTimedEvent,
	AutomationUserDataFilterValue,
	BlueprintDoc,
	Uuid,
} from "@/lib/domain";
import {
	automationTimedScheduleSetupForm,
	organizationLevelsOf,
	ownRecordValue,
	userPropertiesOf,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { automationFormChoice } from "./formChoices";
import {
	describeAutomationPropertyForHq,
	projectAutomationPropertyForHq,
	projectAutomationTemplateForHq,
} from "./hqCaseProperties";
import { automationUsesHostScope } from "./matching";

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
		? `the location with app ID ${uuid}`
		: `“${location.name}” (site code ${location.siteCode}; app ID ${uuid})`;
}

function describeCriterion(
	criterion: AutomationCriterion,
	locations: readonly StoredLocation[],
): string {
	if (criterion.kind === "closed-parent") {
		return "The case's parent case is closed.";
	}
	if (criterion.kind === "location") {
		return `Case ownership resolves to ${locationName(locations, criterion.locationUuid)}${criterion.includeDescendants ? " or one of its descendant locations" : " only"}.`;
	}
	const property =
		criterion.scope === "case"
			? `Case property ${describeAutomationPropertyForHq(criterion.property, "read")}`
			: `${criterion.scope === "parent" ? "Parent" : "Host"} case property ${describeAutomationPropertyForHq(criterion.property, "read")}`;
	if (
		criterion.matchType === "date-days-before" ||
		criterion.matchType === "date-days-lte" ||
		criterion.matchType === "date-days-gt" ||
		criterion.matchType === "date-days"
	) {
		const comparison = {
			"date-days-before": "less than",
			"date-days-lte": "less than or equal to",
			"date-days-gt": "greater than",
			"date-days": "greater than or equal to",
		}[criterion.matchType];
		const days = criterion.days ?? 0;
		const offset =
			days === 0
				? ""
				: ` ${days < 0 ? "minus" : "plus"} ${Math.abs(days)} days`;
		const lowerProperty = `${property.slice(0, 1).toLowerCase()}${property.slice(1)}`;
		return `Current date is ${comparison} the date in ${lowerProperty}${offset}.`;
	}
	const values = {
		equal: `equals “${criterion.value ?? ""}”`,
		"not-equal": `does not equal “${criterion.value ?? ""}”`,
		"has-value": "has a value",
		"has-no-value": "has no value",
		regex: `matches the regular expression ${criterion.value ?? ""}`,
	} as const;
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
			return `Username in case property ${describeAutomationPropertyForHq(recipient.property, "read")}`;
		case "case-property-user-id":
			return `User id in case property ${describeAutomationPropertyForHq(recipient.property, "read")}`;
		case "case-property-email":
			return `Email address in case property ${describeAutomationPropertyForHq(recipient.property, "read")}`;
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
	const project = (template: AutomationMessageTemplate): string =>
		projectAutomationTemplateForHq(template);
	switch (content.kind) {
		case "sms":
			return `SMS message ${JSON.stringify(project(content.message))}`;
		case "email":
			return content.body.kind === "plain-text"
				? `Email subject ${JSON.stringify(project(content.subject))}; choose the plain-text Message form (the target project must not have Rich text emails enabled); message ${JSON.stringify(project(content.body.message))}`
				: `Email subject ${JSON.stringify(project(content.subject))}; choose the Rich Text Message form (the target project must have Rich text emails enabled); HTML source ${JSON.stringify(project(content.body.html))}`;
		case "sms-survey":
		case "connect-survey": {
			return `${content.kind}: ${describePublishedFormChoice(doc, content.formUuid)}; expire after ${content.expirationHours} hour(s); reminder intervals ${content.reminderIntervalsMinutes.length === 0 ? "none" : `${content.reminderIntervalsMinutes.join(", ")} minute(s)`}; submit partially completed forms ${content.submitPartiallyCompletedForms ? "on" : "off"}; include case updates in partial submissions ${content.includeCaseUpdatesInPartialSubmissions ? "on" : "off"}`;
		}
		case "ivr": {
			return `ivr: ${describePublishedFormChoice(doc, content.formUuid)}; reminder intervals ${content.reminderIntervalsMinutes.length === 0 ? "none" : `${content.reminderIntervalsMinutes.join(", ")} minute(s)`}; submit partially completed forms ${content.submitPartiallyCompletedForms ? "on" : "off"}; include case updates in partial submissions ${content.includeCaseUpdatesInPartialSubmissions ? "on" : "off"}; maximum attempts per question ${content.maxQuestionAttempts}`;
		}
		case "sms-callback":
			return `SMS/callback message ${JSON.stringify(project(content.message))}; retry after ${content.reminderIntervalsMinutes.join(", ")} minutes`;
		case "connect-message":
			return `Connect message ${JSON.stringify(project(content.message))}`;
		case "custom":
			return `Registered custom content ${content.registeredId}`;
	}
}

function describePublishedFormChoice(
	doc: BlueprintDoc,
	formUuid: Uuid,
): string {
	const choice = automationFormChoice(doc, formUuid);
	if (choice === undefined) {
		return "repair the missing app form reference before choosing a published form in HQ";
	}
	return `choose the published form path “${choice.label}” in HQ’s form picker`;
}

function describeTiming(timing: AutomationTimedEvent["timing"]): string {
	switch (timing.kind) {
		case "specific-time":
			return `at ${timing.time}`;
		case "random-window":
			return `at a random time in the ${timing.windowMinutes}-minute window starting at ${timing.time}`;
		case "case-property-time":
			return `at the time stored in custom case property ${describeAutomationPropertyForHq(timing.property, "dynamic-only")}; after trimming spaces, the value must start with H:MM or HH:MM and contain a complete time; AM, PM, and seconds are accepted, while blank or unrecognized values use 12:00 PM`;
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
		steps.push("Leave the standard condition list empty.");
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
				`${criterion.kind === "ucr-filter" ? "User-configurable report (UCR) filter" : "Registered custom criterion"} ${index + 1}: ${criterion.text}`,
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

function projectUserDataFilterValue(
	value: AutomationUserDataFilterValue,
): string {
	if (value.kind === "literal") return value.value;
	return `{${projectAutomationPropertyForHq(value.property, "dynamic-only") ?? "[reference needs repair]"}}`;
}

function requiresJsonUserDataFilter(
	automation: Extract<Automation, { kind: "conditional-alert" }>,
): boolean {
	if (automation.userDataFilters.length !== 1) return true;
	const values = automation.userDataFilters[0]?.values ?? [];
	if (values.length !== 1) return true;
	const only = values[0];
	return (
		only?.kind === "literal" &&
		(only.value.length === 0 || only.value !== only.value.trim())
	);
}

export function buildAutomationSetupGuide(
	doc: BlueprintDoc,
	automation: Automation,
	locations: readonly StoredLocation[],
): AutomationSetupGuide {
	const steps = commonSteps(automation, locations);
	const caveats = [
		"commcare nova does not run this automation in Preview, and publishing the app does not install it. Save it manually in the target CommCare HQ project.",
		"CommCare HQ does not expose rules, alerts, or schedules through its API. Set them up in the available web pages; conditional alerts also support an Excel content upload.",
	];
	if (automation.criteria.some((criterion) => criterion.kind === "location")) {
		caveats.push(
			"HQ executes LocationFilterDefinition and its HTML form accepts the hidden location_filter_definition payload, but the current visible rule and alert editors do not expose that picker. Have an HQ administrator apply the named location and descendant flag through that exact form payload or another supported administrator path; do not save a rule with this step omitted.",
		);
	}
	if (automationUsesHostScope(automation)) {
		caveats.push(
			"Every host-scoped reference requires exactly one live extension at runtime. Retained extra extension indices leave CommCare HQ's host choice undefined. When a condition reads the host, those extra indices also make the case count unavailable.",
		);
	}
	if (
		automation.kind === "case-update" &&
		automation.serverModifiedBoundaryDays !== undefined
	) {
		caveats.push(
			"Server-modified age is measured from the case’s latest server modification, not from a claimed-at or other business date.",
		);
	}
	if (
		automation.setupOnlyCriteria.some(
			(criterion) => criterion.kind === "ucr-filter",
		)
	) {
		caveats.push(
			"The target CommCare HQ project must support user-configurable report (UCR) filter conditions before its automation editor offers them. Ask a project-space administrator or Dimagi Support to make that support available.",
		);
	}
	if (
		automation.setupOnlyCriteria.some(
			(criterion) => criterion.kind === "registered-custom",
		)
	) {
		caveats.push(
			"CommCare HQ requires a system administrator to save an automation with a registered custom criterion. A project administrator cannot complete this setup alone.",
		);
	}

	if (automation.kind === "case-update") {
		steps.unshift(
			"In CommCare HQ, open /a/<domain>/data/edit/automatic_updates/ (Data → Edit Data → Automatic Case Update Rules), then add a rule.",
		);
		for (const update of automation.updates) {
			const target =
				update.target.scope === "case"
					? describeAutomationPropertyForHq(
							update.target.property,
							"update-target",
						)
					: `${update.target.scope}/${describeAutomationPropertyForHq(update.target.property, "update-target")}`;
			const value =
				update.value.kind === "literal"
					? `the literal “${update.value.value}”`
					: `the value of ${update.value.source.scope === "case" ? "" : `${update.value.source.scope}/`}${describeAutomationPropertyForHq(update.value.source.property, "read")}`;
			steps.push(`Update ${target} to ${value}.`);
		}
		if (automation.closeCase) steps.push("Turn on Close case.");
		caveats.push(
			"Case-update rules require the Data Cleanup privilege (Pro or higher). HQ’s hourly task runs each project once daily at auto_case_update_hour, midnight UTC by default.",
			"HQ’s default halt threshold is 10,000 updates per project, case type, and database partition unless the project’s auto_case_update_limit overrides it. HQ checks the threshold between cases; one case can apply several updates, so the final total can exceed the threshold before HQ stops. The next daily sweep tries again.",
			"CommCare HQ can be configured to run automatic case updates whenever a case is saved. That behavior is project-wide, not part of this rule; if it is active on the target project, review the effect separately.",
		);
		return {
			title: `${automation.name}: automatic case update rule`,
			requiredPlan: "Data Cleanup (Pro or higher)",
			steps,
			caveats,
		};
	}

	steps.unshift(
		"In CommCare HQ, open /a/<domain>/messaging/conditional/ (Messaging → Conditional Alerts), then add an alert.",
	);
	steps.push(
		"Set Status to Active.",
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
							? `app location level ${uuid}`
							: `“${level.name}” (${level.code}; app ID ${uuid})`;
					})
					.join("; ")}.`,
		automation.defaultLanguageCode === undefined
			? "Choose Project Default in the required Default language field."
			: `Choose ${automation.defaultLanguageCode} in the required Default language field. Configure ${automation.defaultLanguageCode} as a language in the target CommCare HQ project first if it is not already available; HQ accepts only Project Default or a configured project language.`,
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
		const usesSpecificDate = automation.schedule.start.kind === "specific-date";
		const start =
			automation.schedule.start.kind === "rule-trigger"
				? "the day the rule first matches"
				: automation.schedule.start.kind === "specific-date"
					? `the specific date ${automation.schedule.start.date}`
					: `the date in case property ${describeAutomationPropertyForHq(automation.schedule.start.property, "read")}`;
		const iterations =
			automation.schedule.totalIterations === 1
				? "turn Repeat off"
				: automation.schedule.totalIterations === -1
					? "continue indefinitely"
					: `stop after ${automation.schedule.totalIterations} iteration(s)`;
		const setupForm = automationTimedScheduleSetupForm(automation.schedule);
		if (setupForm === "custom-daily") {
			const startInstruction = usesSpecificDate
				? `starting from ${start}; HQ uses that date directly and does not show a separate Begin/start-offset control`
				: `starting from ${start}, with a ${automation.schedule.startOffsetDays}-day start offset`;
			steps.push(
				`Choose Custom Daily Schedule, ${startInstruction}; ${automation.schedule.totalIterations === 1 ? iterations : `repeat every ${automation.schedule.repeatEvery} day(s) and ${iterations}`}. Set the schedule-wide timing mode to match the events below.`,
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
			const startInstruction = usesSpecificDate
				? `starting from ${start}; HQ derives the schedule week's first weekday from that date as ${weekdayNames[startDayOfWeek] ?? "the matching weekday"}`
				: `starting from ${start}; begin the schedule week on ${weekdayNames[startDayOfWeek] ?? "the selected weekday"}`;
			steps.push(
				`Choose Weekly, ${startInstruction}; ${automation.schedule.totalIterations === 1 ? iterations : `repeat every ${automation.schedule.repeatEvery / 7} week(s), and ${iterations}`}.`,
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
		const projected = Object.fromEntries(
			automation.userDataFilters.map((filter) => {
				const property = ownRecordValue(properties, filter.userPropertyUuid);
				return [
					property?.slug ?? filter.userPropertyUuid,
					filter.values.map(projectUserDataFilterValue),
				] as const;
			}),
		);
		const source = automation.useUserCaseForFilter
			? "User Case Properties"
			: "User Properties";
		if (requiresJsonUserDataFilter(automation)) {
			steps.push(
				`Under recipient filters, choose “${source}”, select “JSON”, and paste this exact object:\n${JSON.stringify(projected, null, 2)}`,
			);
		} else {
			const [name, values] = Object.entries(projected)[0] ?? ["", []];
			steps.push(
				`Under recipient filters, choose “${source}” and “Yes”; set property name to ${JSON.stringify(name)} and property value to ${JSON.stringify(values[0] ?? "")}.`,
			);
		}
		caveats.push(
			"CommCare HQ evaluates recipient filters only for contacts that resolve to CommCare user accounts. commcare nova therefore allows these filters only with known user-account recipients; case, parent or child case, case email, case group, and registered custom recipients are excluded because they bypass the filter or do not guarantee a user account.",
		);
		const casePropertyFilterValues = automation.userDataFilters.flatMap(
			(filter) =>
				filter.values.flatMap((value) =>
					value.kind === "case-property"
						? [describeAutomationPropertyForHq(value.property, "dynamic-only")]
						: [],
				),
		);
		if (casePropertyFilterValues.length > 0) {
			caveats.push(
				`Every triggering case must contain ${casePropertyFilterValues.map((property) => `case property ${property}`).join(", ")}. HQ reads each referenced property while expanding recipients, so it cannot run the filter when a property is missing.`,
			);
		}
	} else {
		steps.push(
			`Add no ${automation.useUserCaseForFilter ? "user-case" : "custom-user-data"} recipient filters.`,
		);
	}
	if (automation.resetCaseProperty !== undefined) {
		steps.push(
			`Restart the schedule when custom case property ${describeAutomationPropertyForHq(automation.resetCaseProperty, "dynamic-only")} changes.`,
		);
	}
	if (automation.stopDateCaseProperty !== undefined) {
		steps.push(
			`Stop the schedule after the date in case property ${describeAutomationPropertyForHq(automation.stopDateCaseProperty, "read")}.`,
		);
	}
	const emailBodies = automation.schedule.events.flatMap((event) =>
		event.content.kind === "email" ? [event.content.body.kind] : [],
	);
	if (emailBodies.includes("plain-text")) {
		caveats.push(
			"This email definition targets a project where the domain-level Rich text emails toggle is not enabled. If that toggle is enabled, HQ hides and ignores the plain-text email field and requires rich HTML instead.",
		);
	}
	if (emailBodies.includes("rich-text")) {
		caveats.push(
			"This email definition requires the domain-level Rich text emails toggle. HQ sanitizes the submitted HTML, removes unsupported markup and CSS, wraps the result in its own html/body shell, and derives the plain-text alternative from that HTML. Review the saved rendering; the HTML source is not a byte-exact output and there is no separately authored plain-text body.",
		);
	}
	const contentKinds = automation.schedule.events.map(
		(event) => event.content.kind,
	);
	if (contentKinds.includes("sms-survey")) {
		caveats.push(
			"SMS Survey content requires Inbound SMS access on the target CommCare HQ project. HQ hides the content type and refuses setup without that access; Outbound SMS is still required when messages are sent.",
		);
	}
	if (
		contentKinds.includes("connect-message") ||
		contentKinds.includes("connect-survey")
	) {
		caveats.push(
			"Connect content requires CommCare Connect support in the target project space, which Nova checks before publishing. Every recipient the rule resolves at run time must be a CommCare mobile worker (CommCareUser) with an active PersonalID link; HQ refuses an explicitly selected worker without that link, and unresolved or non-mobile-worker recipients cannot receive the content.",
		);
	}
	caveats.push(
		"Conditional alerts require Reminders Framework (Standard or higher). SMS delivery additionally requires Outbound SMS at send time; an email-only alert does not.",
		"Message templates may read {case.<property>}, case owner/parent/host fields, and {recipient.*}. Custom recipients and custom content must already be registered on the target HQ instance.",
	);
	if (
		automation.recipients.some((recipient) => recipient.kind === "custom") ||
		automation.schedule.events.some((event) => event.content.kind === "custom")
	) {
		caveats.push(
			"CommCare HQ requires a system administrator to save an alert that uses a registered custom recipient or custom content handler. A project administrator cannot complete this setup alone.",
		);
	}
	if (
		automation.userDataFilters.length > 0 &&
		requiresJsonUserDataFilter(automation)
	) {
		caveats.push(
			"A new CommCare HQ alert exposes the JSON recipient-filter mode only to system administrators. The JSON mode is required here to preserve multiple keys, multiple accepted values, empty values, or exact surrounding whitespace.",
		);
	}
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
		title: `${automation.name}: conditional alert`,
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
