/**
 * Private CommCare FormActions projection over the canonical case-write
 * inventory.
 *
 * Field walking, action assignment, bucket identity, repeat scope, and current
 * authoring paths all belong to `deriveCaseWriteInventory`. This module
 * performs no second walk or grouping pass: it only projects those exact
 * buckets into the shape consumed by HQ FormActions lowering.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type {
	ProjectedCaseWriteField,
	ProjectedCaseWriteInventory,
} from "./caseWriteAdmission";
import type { FormPath } from "./xform/formPath";

/** One identity-backed field-to-case-property binding. */
export interface DerivedCasePropertyBinding {
	fieldUuid: Uuid;
	property: string;
	path: FormPath;
}

/** One derived child-case config (one-to-one with an HQ OpenSubCaseAction). */
export interface DerivedChildCase {
	caseType: string;
	/** Exact create-name candidates; admission requires exactly one. */
	caseNames: DerivedCasePropertyBinding[];
	caseProperties: DerivedCasePropertyBinding[];
	relationship: "child" | "extension";
	/** Resolved repeat splice path, including `/item` for query-bound repeats. */
	repeatContext?: string;
	/** Friendly nearest-repeat id for author-facing messages. */
	repeatAncestorId?: string;
}

export interface DerivedCaseConfig {
	/** Primary-create name candidates. Existing-case names stay ordinary writes. */
	caseNames?: DerivedCasePropertyBinding[];
	caseProperties?: DerivedCasePropertyBinding[];
	casePreload?: DerivedCasePropertyBinding[];
	childCases?: DerivedChildCase[];
}

function bindingOf(
	projected: ProjectedCaseWriteField,
): DerivedCasePropertyBinding {
	return {
		fieldUuid: projected.writer.fieldUuid,
		property: projected.writer.property,
		path: projected.path,
	};
}

/**
 * Project one already-derived inventory into HQ's private action model.
 *
 * Each caller derives one inventory, admits it, and passes that same instance
 * into this projection. No lowering step independently re-buckets by rendered
 * path.
 */
export function deriveCaseConfig(
	doc: BlueprintDoc,
	projectedInventory: ProjectedCaseWriteInventory,
): DerivedCaseConfig {
	const result: DerivedCaseConfig = {};
	const primary = projectedInventory.buckets.find(
		({ bucket }) => bucket.kind === "primary",
	);

	if (primary !== undefined) {
		if (primary.bucket.action === "create") {
			const caseNames = primary.writers
				.filter(({ writer }) => writer.property === "case_name")
				.map(bindingOf);
			const properties = primary.writers
				.filter(({ writer }) => writer.property !== "case_name")
				.map(bindingOf);
			if (caseNames.length > 0) result.caseNames = caseNames;
			if (properties.length > 0) result.caseProperties = properties;
		} else {
			const properties = primary.writers.map(bindingOf);
			if (properties.length > 0) {
				result.caseProperties = properties;
				result.casePreload = properties;
			}
		}
	}

	const children: DerivedChildCase[] = projectedInventory.buckets
		.filter(({ bucket }) => bucket.kind === "child")
		.map((projectedBucket) => {
			const { bucket } = projectedBucket;
			const declared = doc.caseTypes?.find(
				(caseType) => caseType.name === bucket.caseType,
			);
			if (declared === undefined) {
				throw new Error(
					`Admitted child-case bucket '${bucket.caseType}' is absent from the case-type catalog.`,
				);
			}
			return {
				caseType: bucket.caseType,
				caseNames: projectedBucket.writers
					.filter(({ writer }) => writer.property === "case_name")
					.map(bindingOf),
				caseProperties: projectedBucket.writers
					.filter(({ writer }) => writer.property !== "case_name")
					.map(bindingOf),
				relationship: declared.relationship ?? "child",
				...(projectedBucket.repeatPath !== undefined && {
					repeatContext: projectedBucket.repeatPath.toXPath(),
				}),
				...(bucket.repeatId !== undefined && {
					repeatAncestorId: bucket.repeatId,
				}),
			};
		});
	if (children.length > 0) result.childCases = children;

	return result;
}
