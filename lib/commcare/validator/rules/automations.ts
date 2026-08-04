/** App-scoped validity rules for human-applied HQ automations. */

import {
	type Automation,
	type AutomationContent,
	type AutomationPropertyTarget,
	automationsOf,
	type BlueprintDoc,
	effectiveCaseTypes,
	organizationLevelsOf,
	userPropertiesOf,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";

interface AutomationContext {
	readonly doc: BlueprintDoc;
	readonly automation: Automation;
	readonly caseTypes: ReadonlyMap<
		string,
		ReturnType<typeof effectiveCaseTypes>[number]
	>;
	readonly errors: ValidationError[];
}

function flag(ctx: AutomationContext, message: string, path: string): void {
	ctx.errors.push(
		validationError(
			"AUTOMATION_INVALID",
			"app",
			`Automation “${ctx.automation.name}” is not valid. ${message}`,
			{},
			{ automationUuid: ctx.automation.uuid, path },
		),
	);
}

function scopedCaseType(
	ctx: AutomationContext,
	target: AutomationPropertyTarget,
): ReturnType<typeof effectiveCaseTypes>[number] | undefined {
	const source = ctx.caseTypes.get(ctx.automation.caseType);
	if (target.scope === "case") return source;
	if (source?.parent_type === undefined) return undefined;
	if (
		(target.scope === "parent" && source.relationship === "extension") ||
		(target.scope === "host" && source.relationship !== "extension")
	) {
		return undefined;
	}
	return ctx.caseTypes.get(source.parent_type);
}

function validatePropertyTarget(
	ctx: AutomationContext,
	target: AutomationPropertyTarget,
	path: string,
): void {
	const caseType = scopedCaseType(ctx, target);
	if (caseType === undefined) {
		flag(
			ctx,
			`The ${target.scope} property target has no matching case relationship.`,
			path,
		);
		return;
	}
	if (
		!caseType.properties.some((property) => property.name === target.property)
	) {
		flag(
			ctx,
			`Property “${target.property}” does not exist on ${caseType.name}.`,
			path,
		);
	}
}

function validateContent(
	ctx: AutomationContext,
	content: AutomationContent,
	path: string,
): void {
	if (
		(content.kind === "sms-survey" ||
			content.kind === "ivr" ||
			content.kind === "connect-survey") &&
		ctx.doc.forms[content.formUuid] === undefined
	) {
		flag(ctx, "The scheduled form no longer exists.", `${path}.formUuid`);
	}
}

function validateAutomation(ctx: AutomationContext): void {
	const { automation } = ctx;
	const caseType = ctx.caseTypes.get(automation.caseType);
	if (caseType === undefined) {
		flag(ctx, `Case type “${automation.caseType}” does not exist.`, "caseType");
		return;
	}

	for (const [index, criterion] of automation.criteria.entries()) {
		const path = `criteria.${index}`;
		if (criterion.kind === "match-property") {
			const property = caseType.properties.find(
				(candidate) => candidate.name === criterion.property,
			);
			if (property === undefined) {
				flag(
					ctx,
					`Criterion property “${criterion.property}” does not exist on ${caseType.name}.`,
					`${path}.property`,
				);
			} else if (
				criterion.matchType.startsWith("date-") &&
				property.data_type !== "date"
			) {
				flag(
					ctx,
					`Date criteria require a date property, but “${criterion.property}” is ${property.data_type ?? "untyped"}.`,
					`${path}.matchType`,
				);
			}
		}
		// Location rows are external to the Blueprint. Their live existence is
		// checked transactionally when reference edges are replaced.
	}

	if (automation.kind === "case-update") {
		for (const [index, update] of automation.updates.entries()) {
			validatePropertyTarget(ctx, update.target, `updates.${index}.target`);
			if (update.value.kind === "case-property") {
				validatePropertyTarget(
					ctx,
					update.value.source,
					`updates.${index}.value.source`,
				);
			}
		}
		return;
	}

	const userProperties = userPropertiesOf(ctx.doc);
	const levels = organizationLevelsOf(ctx.doc);
	for (const [index, recipient] of automation.recipients.entries()) {
		const path = `recipients.${index}`;
		if (
			recipient.kind === "case-property-username" ||
			recipient.kind === "case-property-user-id" ||
			recipient.kind === "case-property-email"
		) {
			if (
				!caseType.properties.some(
					(property) => property.name === recipient.property,
				)
			) {
				flag(
					ctx,
					`Recipient property “${recipient.property}” does not exist on ${caseType.name}.`,
					`${path}.property`,
				);
			}
			if (
				recipient.kind === "case-property-email" &&
				automation.schedule.events.some(
					(event) => event.content.kind !== "email",
				)
			) {
				flag(
					ctx,
					"A case-property email recipient can only be used when every event sends email.",
					path,
				);
			}
		}
	}

	for (const [index, uuid] of automation.locationLevelUuids.entries()) {
		if (levels[uuid] === undefined) {
			flag(
				ctx,
				"A recipient location level no longer exists.",
				`locationLevelUuids.${index}`,
			);
		}
	}
	for (const [index, filter] of automation.userDataFilters.entries()) {
		const property = userProperties[filter.userPropertyUuid];
		if (property === undefined) {
			flag(
				ctx,
				"A user-data filter property no longer exists.",
				`userDataFilters.${index}.userPropertyUuid`,
			);
			continue;
		}
		if (
			property.choices !== undefined &&
			filter.allowedValues.some((value) => !property.choices?.includes(value))
		) {
			flag(
				ctx,
				`A user-data filter contains a value outside “${property.label}”.`,
				`userDataFilters.${index}.allowedValues`,
			);
		}
	}

	if (automation.resetCaseProperty !== undefined) {
		validatePropertyTarget(
			ctx,
			{ scope: "case", property: automation.resetCaseProperty },
			"resetCaseProperty",
		);
	}
	if (automation.stopDateCaseProperty !== undefined) {
		const property = caseType.properties.find(
			(candidate) => candidate.name === automation.stopDateCaseProperty,
		);
		if (property?.data_type !== "date") {
			flag(
				ctx,
				"The stop-date property must be an existing date property on this case type.",
				"stopDateCaseProperty",
			);
		}
	}

	const schedule = automation.schedule;
	if (schedule.kind === "timed") {
		if (schedule.start.kind === "case-property") {
			const start = schedule.start;
			const property = caseType.properties.find(
				(candidate) => candidate.name === start.property,
			);
			if (property?.data_type !== "date") {
				flag(
					ctx,
					"A schedule start property must be an existing date property on this case type.",
					"schedule.start.property",
				);
			}
		}
		for (const [index, event] of schedule.events.entries()) {
			if (event.timing.kind === "case-property-time") {
				const timing = event.timing;
				const property = caseType.properties.find(
					(candidate) => candidate.name === timing.property,
				);
				if (property?.data_type !== "time") {
					flag(
						ctx,
						"An event-time property must be an existing time property on this case type.",
						`schedule.events.${index}.timing.property`,
					);
				}
			}
			validateContent(ctx, event.content, `schedule.events.${index}.content`);
		}
	} else {
		for (const [index, event] of schedule.events.entries()) {
			validateContent(ctx, event.content, `schedule.events.${index}.content`);
		}
	}
}

export function validateAutomations(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const names = new Set<string>();
	const caseTypes = new Map(
		effectiveCaseTypes(doc).map((caseType) => [caseType.name, caseType]),
	);
	for (const automation of Object.values(automationsOf(doc))) {
		const nameKey = automation.name.trim().toLocaleLowerCase();
		if (names.has(nameKey)) {
			errors.push(
				validationError(
					"AUTOMATION_INVALID",
					"app",
					`Two automations are both named “${automation.name}”. Give each rule or alert a distinct name so the setup steps identify the right HQ record.`,
					{},
					{ automationUuid: automation.uuid, path: "name" },
				),
			);
		}
		names.add(nameKey);
		validateAutomation({ doc, automation, caseTypes, errors });
	}
	return errors;
}

export const AUTOMATION_RULES = [validateAutomations];
