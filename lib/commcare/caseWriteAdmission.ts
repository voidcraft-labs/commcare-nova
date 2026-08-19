/**
 * CommCare projection and wire-specific admission over Nova's canonical
 * case-write inventory.
 *
 * Field walking, UUID bucket identity, direct-child membership, repeat scope,
 * and create/update cardinality live in `lib/domain/caseWriteInventory`.
 * This module adds only the CommCare-reserved-name rule and projects the
 * inventory's authored path segments to `FormPath`.
 */

import {
	type CaseWriteBucket,
	type CaseWriteField,
	type CaseWriteInventory,
	type CaseWriteInventoryIssue,
	type CaseWritePathSegment,
	caseWriteInventoryIssues,
	FORBIDDEN_CASE_WRITE_PROPERTIES,
} from "@/lib/domain";
import { FormPath } from "./xform/formPath";

export type CaseWriteAdmissionIssue =
	| CaseWriteInventoryIssue
	| { kind: "reserved-property"; writer: CaseWriteField };

export interface ProjectedCaseWriteField {
	readonly writer: CaseWriteField;
	readonly bucket: CaseWriteBucket;
	readonly path: FormPath;
}

export interface ProjectedCaseWriteBucket {
	readonly bucket: CaseWriteBucket;
	readonly writers: readonly ProjectedCaseWriteField[];
	readonly repeatPath?: FormPath;
}

/**
 * One admitted inventory with its CommCare structural paths projected once.
 *
 * `writerByUuid` carries canonical bucket identity into runtime
 * materialization. Consumers must use `projected.bucket.kind` and
 * `projected.bucket.repeatUuid`; reclassifying a writer from its case-type
 * text or rendered path would create a second, drifting action model.
 */
export interface ProjectedCaseWriteInventory {
	readonly inventory: CaseWriteInventory;
	readonly buckets: readonly ProjectedCaseWriteBucket[];
	readonly writerByUuid: ReadonlyMap<
		CaseWriteField["fieldUuid"],
		ProjectedCaseWriteField
	>;
}

/** Project Nova-authored path segments to the private XForm path type. */
export function caseWriteFormPath(
	segments: readonly CaseWritePathSegment[],
): FormPath {
	let path = FormPath.root();
	for (const segment of segments) {
		path = path.child(segment.fieldId);
		if (segment.queryBoundIteration) path = path.queryBoundIteration();
	}
	return path;
}

/**
 * The one admission decision consumed by validation, wire emission, Preview,
 * and authoring gates. No field walk occurs here.
 */
export function caseWriteAdmissionIssues(
	inventory: CaseWriteInventory,
): readonly CaseWriteAdmissionIssue[] {
	const issues: CaseWriteAdmissionIssue[] = [
		...caseWriteInventoryIssues(inventory),
	];
	for (const writer of inventory.writers) {
		if (FORBIDDEN_CASE_WRITE_PROPERTIES.has(writer.property)) {
			issues.push({ kind: "reserved-property", writer });
		}
	}
	return issues;
}

/** Fail closed at lowering/runtime boundaries. */
export function assertCaseWriteAdmission(inventory: CaseWriteInventory): void {
	const issue = caseWriteAdmissionIssues(inventory)[0];
	if (issue === undefined) return;
	switch (issue.kind) {
		case "no-case-action":
			throw new Error(
				`Field '${issue.writer.fieldUuid}' has caseWrite but its form emits no case action.`,
			);
		case "destination-type-unknown":
			throw new Error(
				`Field '${issue.writer.fieldUuid}' writes unknown case type '${issue.writer.caseType}'.`,
			);
		case "destination-not-direct-child":
			throw new Error(
				`Field '${issue.writer.fieldUuid}' writes case type '${issue.writer.caseType}', which is not the module's own type or an exact direct child.`,
			);
		case "capture-standard-property":
			throw new Error(
				`Attachment field '${issue.writer.fieldUuid}' cannot write standard case property '${issue.writer.property}'.`,
			);
		case "reserved-property":
			throw new Error(
				`Field '${issue.writer.fieldUuid}' writes reserved case property '${issue.writer.property}'.`,
			);
		case "primary-writer-in-repeat":
			throw new Error(
				`Primary-case field '${issue.writer.fieldUuid}' is inside repeat '${issue.writer.repeatUuid}'.`,
			);
		case "duplicate-property":
			throw new Error(
				`Case action for '${issue.bucket.caseType}' has ${issue.writers.length} field writers for property '${issue.property}'.`,
			);
		case "create-name-missing":
			throw new Error(
				`Case-create action for '${issue.bucket.caseType}' has no case_name writer; exactly one is required.`,
			);
		case "create-name-duplicate":
			throw new Error(
				`Case-create action for '${issue.bucket.caseType}' has ${issue.writers.length} case_name writers; exactly one is required.`,
			);
	}
}

/**
 * Admit semantic case-write rules, then project every structural writer and
 * repeat path exactly once.
 *
 * Invalid XML field ids remain the single `INVALID_FIELD_ID` authoring
 * finding. If a caller bypasses validation, `FormPath.child` throws here at
 * both lowering and Preview boundaries instead of creating a second public
 * validation vocabulary.
 */
export function assertAndProjectCaseWriteInventory(
	inventory: CaseWriteInventory,
): ProjectedCaseWriteInventory {
	assertCaseWriteAdmission(inventory);
	const writerByUuid = new Map<
		CaseWriteField["fieldUuid"],
		ProjectedCaseWriteField
	>();
	const buckets = inventory.buckets.map((bucket): ProjectedCaseWriteBucket => {
		const writers = bucket.writers.map((writer): ProjectedCaseWriteField => {
			const projected = {
				writer,
				bucket,
				path: caseWriteFormPath(writer.path),
			};
			writerByUuid.set(writer.fieldUuid, projected);
			return projected;
		});
		return {
			bucket,
			writers,
			...(bucket.repeatPath !== undefined && {
				repeatPath: caseWriteFormPath(bucket.repeatPath),
			}),
		};
	});
	return { inventory, buckets, writerByUuid };
}
