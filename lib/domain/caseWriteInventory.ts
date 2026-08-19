/**
 * Canonical field-to-case-action inventory.
 *
 * This is Nova domain state: stable field/repeat identities, explicit
 * `{caseType, property}` destinations, and ordered authoring-path segments.
 * It does not contain CommCare XPath or FormActions vocabulary. Wire consumers
 * project `path` to their private representation; doc, validator, Preview,
 * builder, SA, and MCP consumers all use these exact buckets and issues.
 */

import type { BlueprintDoc } from "./blueprint";
import { fieldCaseWrite } from "./caseTypes";
import { type Field, isCaptureFieldKind } from "./fields";
import type { FormType } from "./forms";
import type { Module } from "./modules";
import { isWritableStandardCaseProperty } from "./standardCaseProperties";
import { USERCASE_BUILT_IN_KEYS, USERCASE_CASE_TYPE } from "./usercase";
import { userPropertiesOf } from "./users";
import type { Uuid } from "./uuid";

/** One authored field path step, including query-bound repeat iteration. */
export interface CaseWritePathSegment {
	fieldUuid: Uuid;
	fieldId: string;
	/**
	 * The step names a query-bound repeat whose descendants live below its
	 * model-iteration item. Projection inserts that private runtime step after
	 * this authored segment.
	 */
	queryBoundIteration: boolean;
}

export interface CaseWriteField {
	fieldUuid: Uuid;
	fieldId: string;
	fieldKind: Field["kind"];
	caseType: string;
	property: string;
	path: readonly CaseWritePathSegment[];
	repeatUuid?: Uuid;
	repeatId?: string;
	repeatPath?: readonly CaseWritePathSegment[];
}

export interface CaseWriteBucket {
	/**
	 * `usercase` is the worker's OWN record. It is a fixed destination rather
	 * than a repeated one — one form writes one worker record — so unlike
	 * `child` it never keys on a repeat.
	 */
	kind: "primary" | "child" | "usercase";
	action: "create" | "update";
	caseType: string;
	repeatUuid?: Uuid;
	repeatId?: string;
	repeatPath?: readonly CaseWritePathSegment[];
	writers: CaseWriteField[];
}

export interface CaseWriteInventory {
	/** Every authored writer, including no-action and invalid destinations. */
	writers: CaseWriteField[];
	/** Only writers assigned to an actual eligible emitted action. */
	buckets: CaseWriteBucket[];
	noActionWriters: CaseWriteField[];
	invalidDestinationWriters: Array<{
		writer: CaseWriteField;
		reason:
			| "unknown-type"
			| "not-direct-child"
			| "usercase-property-undeclared"
			| "usercase-property-managed";
	}>;
}

export type CaseWriteInventoryIssue =
	| { kind: "no-case-action"; writer: CaseWriteField }
	| { kind: "destination-type-unknown"; writer: CaseWriteField }
	| { kind: "destination-not-direct-child"; writer: CaseWriteField }
	| { kind: "capture-standard-property"; writer: CaseWriteField }
	| { kind: "usercase-property-undeclared"; writer: CaseWriteField }
	| { kind: "usercase-property-managed"; writer: CaseWriteField }
	| { kind: "usercase-writer-in-repeat"; writer: CaseWriteField }
	| {
			kind: "primary-writer-in-repeat";
			writer: CaseWriteField;
			bucket: CaseWriteBucket;
	  }
	| {
			kind: "duplicate-property";
			bucket: CaseWriteBucket;
			property: string;
			writers: readonly CaseWriteField[];
	  }
	| { kind: "create-name-missing"; bucket: CaseWriteBucket }
	| {
			kind: "create-name-duplicate";
			bucket: CaseWriteBucket;
			writers: readonly CaseWriteField[];
	  };

function childBucketKey(
	caseType: string,
	repeatUuid: Uuid | undefined,
): string {
	return JSON.stringify([caseType, repeatUuid ?? null]);
}

/** Derive every case writer and emitted-action bucket under one form. */
export function deriveCaseWriteInventory(
	doc: Pick<
		BlueprintDoc,
		"fields" | "fieldOrder" | "caseTypes" | "userProperties"
	>,
	formUuid: Uuid,
	module: Pick<Module, "caseType">,
	formType: FormType,
): CaseWriteInventory {
	const writers: CaseWriteField[] = [];
	const walk = (
		parentUuid: Uuid,
		parentPath: readonly CaseWritePathSegment[],
		repeatUuid: Uuid | undefined,
		repeatId: string | undefined,
		repeatPath: readonly CaseWritePathSegment[] | undefined,
	): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (field === undefined) continue;
			const ownStep: CaseWritePathSegment = {
				fieldUuid,
				fieldId: field.id,
				queryBoundIteration:
					field.kind === "repeat" && field.repeat_mode === "query_bound",
			};
			const path = [...parentPath, ownStep];
			const nextRepeatUuid = field.kind === "repeat" ? field.uuid : repeatUuid;
			const nextRepeatId = field.kind === "repeat" ? field.id : repeatId;
			const nextRepeatPath = field.kind === "repeat" ? path : repeatPath;
			const write = fieldCaseWrite(field);
			if (write !== undefined) {
				writers.push({
					fieldUuid,
					fieldId: field.id,
					fieldKind: field.kind,
					caseType: write.caseType,
					property: write.property,
					path,
					...(nextRepeatUuid !== undefined && {
						repeatUuid: nextRepeatUuid,
						repeatId: nextRepeatId,
						repeatPath: nextRepeatPath,
					}),
				});
			}
			if (doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, path, nextRepeatUuid, nextRepeatId, nextRepeatPath);
			}
		}
	};
	walk(formUuid, [], undefined, undefined, undefined);

	// The worker's own record is split off BEFORE the module's case type is
	// consulted, because it does not depend on one. HQ's `usercase_update` is a
	// form action like any other on a module form, so a form with no case type
	// of its own can still save into the worker's record — and a survey form is
	// exactly that. Leaving it below the early return would refuse the write on
	// the one form type where it is often the only write there is.
	const declaredSlugs = new Set(
		Object.values(userPropertiesOf(doc)).map((property) => property.slug),
	);
	const managedNames = new Set(USERCASE_BUILT_IN_KEYS);
	const usercase: CaseWriteBucket = {
		kind: "usercase",
		action: "update",
		caseType: USERCASE_CASE_TYPE,
		writers: [],
	};
	const invalidDestinationWriters: CaseWriteInventory["invalidDestinationWriters"] =
		[];
	const caseWriters: CaseWriteField[] = [];
	for (const writer of writers) {
		if (writer.caseType !== USERCASE_CASE_TYPE) {
			caseWriters.push(writer);
			continue;
		}
		if (managedNames.has(writer.property)) {
			invalidDestinationWriters.push({
				writer,
				reason: "usercase-property-managed",
			});
			continue;
		}
		if (!declaredSlugs.has(writer.property)) {
			invalidDestinationWriters.push({
				writer,
				reason: "usercase-property-undeclared",
			});
			continue;
		}
		usercase.writers.push(writer);
	}

	const moduleCaseType = module.caseType;
	if (formType === "survey" || !moduleCaseType) {
		return {
			writers,
			buckets: usercase.writers.length > 0 ? [usercase] : [],
			noActionWriters: caseWriters,
			invalidDestinationWriters,
		};
	}

	const declaredByName = new Map(
		(doc.caseTypes ?? []).map((caseType) => [caseType.name, caseType]),
	);
	const primary: CaseWriteBucket = {
		kind: "primary",
		action: formType === "registration" ? "create" : "update",
		caseType: moduleCaseType,
		writers: [],
	};
	const childByKey = new Map<string, CaseWriteBucket>();

	for (const writer of caseWriters) {
		if (writer.caseType === moduleCaseType) {
			primary.writers.push(writer);
			continue;
		}
		const destination = declaredByName.get(writer.caseType);
		if (destination === undefined) {
			invalidDestinationWriters.push({ writer, reason: "unknown-type" });
			continue;
		}
		if (destination.parent_type !== moduleCaseType) {
			invalidDestinationWriters.push({
				writer,
				reason: "not-direct-child",
			});
			continue;
		}
		const key = childBucketKey(writer.caseType, writer.repeatUuid);
		let bucket = childByKey.get(key);
		if (bucket === undefined) {
			bucket = {
				kind: "child",
				action: "create",
				caseType: writer.caseType,
				...(writer.repeatUuid !== undefined && {
					repeatUuid: writer.repeatUuid,
					repeatId: writer.repeatId,
					repeatPath: writer.repeatPath,
				}),
				writers: [],
			};
			childByKey.set(key, bucket);
		}
		bucket.writers.push(writer);
	}

	return {
		writers,
		buckets: [
			primary,
			...childByKey.values(),
			...(usercase.writers.length > 0 ? [usercase] : []),
		],
		noActionWriters: [],
		invalidDestinationWriters,
	};
}

/** Group one emitted bucket's writers by exact destination property. */
export function caseWritersByProperty(
	bucket: CaseWriteBucket,
): ReadonlyMap<string, readonly CaseWriteField[]> {
	const grouped = new Map<string, CaseWriteField[]>();
	for (const writer of bucket.writers) {
		const existing = grouped.get(writer.property);
		if (existing === undefined) grouped.set(writer.property, [writer]);
		else existing.push(writer);
	}
	return grouped;
}

/**
 * Nova-domain admission issues over one inventory.
 *
 * CommCare-specific reserved-property admission extends this list without
 * walking fields again.
 */
export function caseWriteInventoryIssues(
	inventory: CaseWriteInventory,
): readonly CaseWriteInventoryIssue[] {
	const issues: CaseWriteInventoryIssue[] = inventory.noActionWriters.map(
		(writer) => ({ kind: "no-case-action", writer }),
	);
	for (const { writer, reason } of inventory.invalidDestinationWriters) {
		issues.push({
			kind:
				reason === "unknown-type"
					? "destination-type-unknown"
					: reason === "not-direct-child"
						? "destination-not-direct-child"
						: reason,
			writer,
		});
	}
	for (const bucket of inventory.buckets) {
		for (const writer of bucket.writers) {
			if (bucket.kind === "primary" && writer.repeatUuid !== undefined) {
				issues.push({
					kind: "primary-writer-in-repeat",
					writer,
					bucket,
				});
			}
			// One form writes ONE worker record. A repeat would ask which
			// iteration's answer the worker's record should end up holding,
			// and there is no answer — the block binds to a single
			// `usercase_id` datum, so the last iteration would silently win.
			if (bucket.kind === "usercase" && writer.repeatUuid !== undefined) {
				issues.push({ kind: "usercase-writer-in-repeat", writer });
			}
			// A capture's answer is a server-minted file name, and in URL
			// mode the property carries an address built from it. Neither is
			// a case's name or its external id: those two are dedicated
			// scalar slots CommCare trims and caps at 255, and they are
			// emitted through their own FormActions members rather than the
			// update map, so a capture there would bypass the node the URL
			// actually lives on.
			if (
				isCaptureFieldKind(writer.fieldKind) &&
				isWritableStandardCaseProperty(writer.property)
			) {
				issues.push({ kind: "capture-standard-property", writer });
			}
		}
		for (const [property, propertyWriters] of caseWritersByProperty(bucket)) {
			if (propertyWriters.length < 2) continue;
			if (bucket.action === "create" && property === "case_name") continue;
			issues.push({
				kind: "duplicate-property",
				bucket,
				property,
				writers: propertyWriters,
			});
		}
		if (bucket.action !== "create") continue;
		const names = bucket.writers.filter(
			(writer) => writer.property === "case_name",
		);
		if (names.length === 0) {
			issues.push({ kind: "create-name-missing", bucket });
		} else if (names.length > 1) {
			issues.push({
				kind: "create-name-duplicate",
				bucket,
				writers: names,
			});
		}
	}
	return issues;
}
