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
	kind: "primary" | "child";
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
		reason: "unknown-type" | "not-direct-child";
	}>;
}

export type CaseWriteInventoryIssue =
	| { kind: "no-case-action"; writer: CaseWriteField }
	| { kind: "destination-type-unknown"; writer: CaseWriteField }
	| { kind: "destination-not-direct-child"; writer: CaseWriteField }
	| { kind: "capture-standard-property"; writer: CaseWriteField }
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
	doc: Pick<BlueprintDoc, "fields" | "fieldOrder" | "caseTypes">,
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

	const moduleCaseType = module.caseType;
	if (formType === "survey" || !moduleCaseType) {
		return {
			writers,
			buckets: [],
			noActionWriters: writers,
			invalidDestinationWriters: [],
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
	const invalidDestinationWriters: CaseWriteInventory["invalidDestinationWriters"] =
		[];

	for (const writer of writers) {
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
		buckets: [primary, ...childByKey.values()],
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
					: "destination-not-direct-child",
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
