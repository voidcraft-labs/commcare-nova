/** App-scoped validity rules for human-applied HQ automations. */

import {
	type AutomationHqPropertySlot,
	projectAutomationPropertyForHq,
} from "@/lib/automations/hqCaseProperties";
import {
	type Automation,
	type AutomationContent,
	type AutomationMessageTemplate,
	type AutomationPropertyTarget,
	automationsOf,
	type BlueprintDoc,
	effectiveCaseTypes,
	isAutomationImplicitTextReadProperty,
	isAutomationMessageShadowedCaseProperty,
	orderedCaseOperations,
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
	readonly hostReadCanBeAmbiguous: boolean;
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
	semantics: "automation-property" | "message-template" = "automation-property",
): ReturnType<typeof effectiveCaseTypes>[number] | undefined {
	const source = ctx.caseTypes.get(ctx.automation.caseType);
	if (target.scope === "case") return source;
	if (source?.parent_type === undefined) return undefined;
	if (
		(semantics === "message-template" &&
			target.scope === "parent" &&
			source.relationship === "extension") ||
		(target.scope === "host" && source.relationship !== "extension")
	) {
		return undefined;
	}
	return ctx.caseTypes.get(source.parent_type);
}

/**
 * A canonical extension case uses the `parent` index. An advanced case
 * operation can add a second extension index to the same case type, after
 * which HQ's `get_host()` has no defined ordering. A `parent` link replaces
 * the canonical index rather than adding another one, and a null target removes
 * an index, so neither creates the ambiguity this guard owns.
 */
function canAuthorAdditionalExtensionHost(
	doc: BlueprintDoc,
	caseType: string,
): boolean {
	const declaredCaseType = doc.caseTypes?.find(
		(candidate) => candidate.name === caseType,
	);
	if (declaredCaseType?.relationship !== "extension") return false;
	for (const form of Object.values(doc.forms)) {
		for (const operation of orderedCaseOperations(form)) {
			const resultingCaseType = operation.retype ?? operation.caseType;
			if (resultingCaseType !== caseType) continue;
			if (
				(operation.links ?? []).some(
					(link) =>
						link.relationship === "extension" &&
						link.target !== null &&
						link.identifier !== "parent",
				)
			) {
				return true;
			}
		}
	}
	return false;
}

function validateHostReadScope(
	ctx: AutomationContext,
	target: AutomationPropertyTarget,
	path: string,
): boolean {
	if (target.scope !== "host" || !ctx.hostReadCanBeAmbiguous) return true;
	flag(
		ctx,
		"This host property read is ambiguous because an advanced case operation can add another extension relationship to this case type. CommCare HQ does not define which extension becomes the host. Remove the additional extension link or use a non-host scope.",
		path,
	);
	return false;
}

function automationReadProperty(
	caseType: ReturnType<typeof effectiveCaseTypes>[number],
	property: string,
): { readonly data_type?: string } | undefined {
	return (
		caseType.properties.find((candidate) => candidate.name === property) ??
		(isAutomationImplicitTextReadProperty(property)
			? { data_type: "text" }
			: undefined)
	);
}

function validatePropertyTarget(
	ctx: AutomationContext,
	target: AutomationPropertyTarget,
	path: string,
	slot: AutomationHqPropertySlot = "read",
	semantics: "automation-property" | "message-template" = "automation-property",
): void {
	if (slot === "read" && !validateHostReadScope(ctx, target, `${path}.scope`)) {
		return;
	}
	const caseType = scopedCaseType(ctx, target, semantics);
	if (caseType === undefined) {
		flag(
			ctx,
			`The ${target.scope} property target has no matching case relationship.`,
			path,
		);
		return;
	}
	const hasProperty =
		caseType.properties.some((property) => property.name === target.property) ||
		((slot === "read" || slot === "update-target") &&
			isAutomationImplicitTextReadProperty(target.property));
	if (!hasProperty) {
		flag(
			ctx,
			`Property “${target.property}” does not exist on ${caseType.name}.`,
			path,
		);
		return;
	}
	if (projectAutomationPropertyForHq(target.property, slot) === undefined) {
		const message =
			slot === "dynamic-only"
				? `CommCare HQ reads this field only from custom case data, so standard property “${target.property}” cannot be used here.`
				: target.property === "status"
					? "Case status cannot be represented by an HQ automation property: Nova stores open/closed text, HQ exposes a boolean, and automation matching already excludes closed cases."
					: `Standard property “${target.property}” cannot be changed by this representable automation action.`;
		flag(ctx, message, path);
	}
}

function validateTemplate(
	ctx: AutomationContext,
	template: AutomationMessageTemplate,
	path: string,
): void {
	for (const [index, part] of template.parts.entries()) {
		if (part.kind !== "case-property") continue;
		const partPath = `${path}.parts.${index}`;
		if (isAutomationMessageShadowedCaseProperty(part.property)) {
			flag(
				ctx,
				`Custom case property “${part.property}” is shadowed by CommCare HQ's message-template context and cannot be read from the ${part.scope} case in a message. Rename the custom property before inserting it into a message.`,
				`${partPath}.property`,
			);
			continue;
		}
		const scoped = scopedCaseType(ctx, part, "message-template");
		if (scoped !== undefined && scoped.name !== part.caseType) {
			flag(
				ctx,
				`The ${part.scope} message reference resolves to ${scoped.name}, not stored identity ${part.caseType}.`,
				`${partPath}.caseType`,
			);
			continue;
		}
		validatePropertyTarget(ctx, part, partPath, "read", "message-template");
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
	const templates: ReadonlyArray<readonly [string, AutomationMessageTemplate]> =
		content.kind === "email"
			? ([
					["subject", content.subject],
					content.body.kind === "plain-text"
						? ["body.message", content.body.message]
						: ["body.html", content.body.html],
				] as const)
			: content.kind === "sms" ||
					content.kind === "sms-callback" ||
					content.kind === "connect-message"
				? ([["message", content.message]] as const)
				: [];
	for (const [field, template] of templates) {
		validateTemplate(ctx, template, `${path}.${field}`);
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
			if (!validateHostReadScope(ctx, criterion, `${path}.scope`)) {
				continue;
			}
			const criterionCaseType = scopedCaseType(ctx, criterion);
			if (criterionCaseType === undefined) {
				flag(
					ctx,
					`The ${criterion.scope} property condition has no matching case relationship.`,
					`${path}.scope`,
				);
				continue;
			}
			const property = automationReadProperty(
				criterionCaseType,
				criterion.property,
			);
			if (property === undefined) {
				flag(
					ctx,
					`Criterion property “${criterion.property}” does not exist on ${criterionCaseType.name}.`,
					`${path}.property`,
				);
			} else if (
				criterion.matchType.startsWith("date-") &&
				property.data_type !== "date" &&
				property.data_type !== "datetime"
			) {
				flag(
					ctx,
					`Date criteria require a date or datetime property, but “${criterion.property}” is ${property.data_type ?? "untyped"}.`,
					`${path}.matchType`,
				);
			} else if (
				(criterion.property === "date_opened" ||
					criterion.property === "last_modified") &&
				(criterion.matchType === "equal" ||
					criterion.matchType === "not-equal" ||
					criterion.matchType === "regex")
			) {
				flag(
					ctx,
					`Standard datetime property “${criterion.property}” can use date or blankness comparisons, but HQ cannot compare its datetime object with an authored text value or regex.`,
					`${path}.matchType`,
				);
			} else if (
				projectAutomationPropertyForHq(criterion.property, "read") === undefined
			) {
				flag(
					ctx,
					"Case status cannot be represented by an HQ automation criterion because Nova's open/closed text differs from HQ's boolean field.",
					`${path}.property`,
				);
			}
		}
		// Location rows are external to the Blueprint. Their live existence is
		// checked transactionally when reference edges are replaced.
	}

	if (automation.kind === "case-update") {
		for (const [index, update] of automation.updates.entries()) {
			validatePropertyTarget(
				ctx,
				update.target,
				`updates.${index}.target`,
				"update-target",
			);
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
			if (automationReadProperty(caseType, recipient.property) === undefined) {
				flag(
					ctx,
					`Recipient property “${recipient.property}” does not exist on ${caseType.name}.`,
					`${path}.property`,
				);
			} else if (
				projectAutomationPropertyForHq(recipient.property, "read") === undefined
			) {
				flag(
					ctx,
					"Case status cannot provide an HQ automation recipient identity.",
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
			filter.values.some(
				(value) =>
					value.kind === "literal" &&
					value.value !== "" &&
					!property.choices?.includes(value.value),
			)
		) {
			flag(
				ctx,
				`A user-data filter contains a value outside “${property.label}”.`,
				`userDataFilters.${index}.values`,
			);
		}
		for (const [valueIndex, value] of filter.values.entries()) {
			if (value.kind !== "case-property") continue;
			const path = `userDataFilters.${index}.values.${valueIndex}`;
			if (value.caseType !== automation.caseType) {
				flag(
					ctx,
					`The recipient-filter case-property value belongs to ${value.caseType}, not ${automation.caseType}.`,
					`${path}.caseType`,
				);
				continue;
			}
			validatePropertyTarget(
				ctx,
				{ scope: "case", property: value.property },
				path,
				"dynamic-only",
			);
		}
	}

	if (automation.resetCaseProperty !== undefined) {
		validatePropertyTarget(
			ctx,
			{ scope: "case", property: automation.resetCaseProperty },
			"resetCaseProperty",
			"dynamic-only",
		);
	}
	if (automation.stopDateCaseProperty !== undefined) {
		const property = caseType.properties.find(
			(candidate) => candidate.name === automation.stopDateCaseProperty,
		);
		if (property?.data_type !== "date" && property?.data_type !== "datetime") {
			flag(
				ctx,
				"The stop-date property must be an existing date or datetime property on this case type.",
				"stopDateCaseProperty",
			);
		} else if (
			projectAutomationPropertyForHq(
				automation.stopDateCaseProperty,
				"read",
			) === undefined
		) {
			flag(
				ctx,
				"The stop-date property has no compatible HQ automation name.",
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
			if (
				property?.data_type !== "date" &&
				property?.data_type !== "datetime"
			) {
				flag(
					ctx,
					"A schedule start property must be an existing date property on this case type.",
					"schedule.start.property",
				);
			} else if (
				projectAutomationPropertyForHq(start.property, "read") === undefined
			) {
				flag(
					ctx,
					"The schedule start property has no compatible HQ automation name.",
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
				} else if (
					projectAutomationPropertyForHq(timing.property, "dynamic-only") ===
					undefined
				) {
					flag(
						ctx,
						"HQ event-time fields can read only a custom case property.",
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
		validateAutomation({
			doc,
			automation,
			caseTypes,
			hostReadCanBeAmbiguous: canAuthorAdditionalExtensionHost(
				doc,
				automation.caseType,
			),
			errors,
		});
	}
	return errors;
}

export const AUTOMATION_RULES = [validateAutomations];
