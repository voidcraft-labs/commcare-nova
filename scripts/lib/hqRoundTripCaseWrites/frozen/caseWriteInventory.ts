/**
 * `main`'s field-write buckets, frozen: a copy of
 * `2f985ed6:lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`'s
 * bucket rules over a `RawDocument`, with the relationship
 * `2f985ed6:lib/commcare/deriveCaseConfig.ts::deriveCaseConfig` read from the
 * case-type catalog for each child bucket.
 *
 * Every field's `caseWrite` is one writer, in data-tree order. A write to the
 * worker's record joins the usercase bucket where its property is a declared
 * worker property and no built-in key; a form with no case type of its own,
 * and every survey, keeps only that bucket. Otherwise a write to the
 * module's case type joins the own bucket (a create on a registration, an
 * update elsewhere), and a write to a declared child of the module's case
 * type joins the bucket of its `(case type, nearest repeat)`, in the order
 * the buckets were first met. Writes to an undeclared type or to a type that
 * is not a direct child join no bucket, as at `main`, whose gate refused the
 * form that held one.
 *
 * Step 5 replaces field writes with case operations, so the head has no
 * such inventory; the cutover reads this one to make the operations
 * (`lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites` takes the
 * writes in this order) and to give each bucket its unit and today's
 * placement (`todaysPlacements.ts`).
 */

import {
	USERCASE_BUILT_IN_KEYS,
	USERCASE_CASE_TYPE,
} from "@/lib/domain/usercase";
import type { JsonRecord, RawDocument } from "../oldShape";
import {
	isRecord,
	rawDataPaths,
	rawFieldCaseWrite,
	rawFieldsInDataOrder,
	rawFormInMenu,
	rawModuleCaseType,
	stringAt,
} from "./rawForms";

/** One field's write. */
export interface FrozenCaseWriter {
	readonly fieldUuid: string;
	readonly fieldKind: string;
	readonly caseType: string;
	readonly property: string;
	/** The nearest repeat around the field; absent at the form root. */
	readonly repeatUuid?: string;
}

/** One bucket of a form's writes, as `main` emitted it as one case action. */
export interface FrozenCaseWriteBucket {
	readonly kind: "primary" | "child" | "usercase";
	readonly action: "create" | "update";
	readonly caseType: string;
	/** A child bucket's repeat; absent at the form root and for the others. */
	readonly repeatUuid?: string;
	/** A child bucket's relationship to the own case, from the catalog. */
	readonly relationship?: "child" | "extension";
	readonly writers: readonly FrozenCaseWriter[];
}

export interface FrozenCaseWriteInventory {
	/** Every writer of the form, in data-tree order. */
	readonly writers: readonly FrozenCaseWriter[];
	/** The own bucket first, then the child buckets in the order met, then
	 *  the usercase bucket where it has a writer. */
	readonly buckets: readonly FrozenCaseWriteBucket[];
}

interface CatalogEntry {
	readonly parentType?: string;
	readonly relationship: "child" | "extension";
}

/** The stored case-type catalog by name, as `main`'s `doc.caseTypes`. */
function catalogByName(raw: RawDocument): ReadonlyMap<string, CatalogEntry> {
	const entries = new Map<string, CatalogEntry>();
	const caseTypes = Array.isArray(raw.caseTypes) ? raw.caseTypes : [];
	for (const entry of caseTypes) {
		if (!isRecord(entry)) continue;
		const name = stringAt(entry, "name");
		if (name === undefined || entries.has(name)) continue;
		const parentType = stringAt(entry, "parent_type");
		entries.set(name, {
			...(parentType !== undefined && { parentType }),
			relationship:
				stringAt(entry, "relationship") === "extension" ? "extension" : "child",
		});
	}
	return entries;
}

/** The slugs of the declared worker properties, as `main`'s
 *  `userPropertiesOf(doc)` gave them. */
function declaredWorkerSlugs(raw: RawDocument): ReadonlySet<string> {
	const slugs = new Set<string>();
	for (const property of Object.values(raw.userProperties)) {
		const slug = stringAt(property as JsonRecord, "slug");
		if (slug !== undefined) slugs.add(slug);
	}
	return slugs;
}

/** The writes of form `formUuid` and the buckets `main` emitted them in. */
export function frozenCaseWriteInventory(
	raw: RawDocument,
	formUuid: string,
): FrozenCaseWriteInventory {
	const inMenu = rawFormInMenu(raw, formUuid);
	const formType = stringAt(inMenu?.form ?? raw.forms[formUuid], "type");
	const moduleCaseType = rawModuleCaseType(inMenu?.module);
	const { nearestRepeat } = rawDataPaths(raw, formUuid);

	const writers: FrozenCaseWriter[] = [];
	for (const fieldUuid of rawFieldsInDataOrder(raw, formUuid)) {
		const field = raw.fields[fieldUuid];
		const write = rawFieldCaseWrite(field);
		if (write === undefined) continue;
		const repeatUuid = nearestRepeat.get(fieldUuid);
		writers.push({
			fieldUuid,
			fieldKind: stringAt(field, "kind") ?? "",
			caseType: write.caseType,
			property: write.property,
			...(repeatUuid !== undefined && { repeatUuid }),
		});
	}

	const declaredSlugs = declaredWorkerSlugs(raw);
	const managedNames = new Set(USERCASE_BUILT_IN_KEYS);
	const usercaseWriters: FrozenCaseWriter[] = [];
	const caseWriters: FrozenCaseWriter[] = [];
	for (const writer of writers) {
		if (writer.caseType !== USERCASE_CASE_TYPE) caseWriters.push(writer);
		else if (
			!managedNames.has(writer.property) &&
			declaredSlugs.has(writer.property)
		)
			usercaseWriters.push(writer);
	}
	const usercase: FrozenCaseWriteBucket[] =
		usercaseWriters.length > 0
			? [
					{
						kind: "usercase",
						action: "update",
						caseType: USERCASE_CASE_TYPE,
						writers: usercaseWriters,
					},
				]
			: [];
	if (formType === "survey" || moduleCaseType === undefined)
		return { writers, buckets: usercase };

	const catalog = catalogByName(raw);
	const primaryWriters: FrozenCaseWriter[] = [];
	const children = new Map<
		string,
		{
			bucket: Omit<FrozenCaseWriteBucket, "writers">;
			writers: FrozenCaseWriter[];
		}
	>();
	for (const writer of caseWriters) {
		if (writer.caseType === moduleCaseType) {
			primaryWriters.push(writer);
			continue;
		}
		const destination = catalog.get(writer.caseType);
		if (destination === undefined || destination.parentType !== moduleCaseType)
			continue;
		const key = JSON.stringify([writer.caseType, writer.repeatUuid ?? null]);
		let child = children.get(key);
		if (child === undefined) {
			child = {
				bucket: {
					kind: "child",
					action: "create",
					caseType: writer.caseType,
					...(writer.repeatUuid !== undefined && {
						repeatUuid: writer.repeatUuid,
					}),
					relationship: destination.relationship,
				},
				writers: [],
			};
			children.set(key, child);
		}
		child.writers.push(writer);
	}

	return {
		writers,
		buckets: [
			{
				kind: "primary",
				action: formType === "registration" ? "create" : "update",
				caseType: moduleCaseType,
				writers: primaryWriters,
			},
			...[...children.values()].map(({ bucket, writers: bucketWriters }) => ({
				...bucket,
				writers: bucketWriters,
			})),
			...usercase,
		],
	};
}

/** The unit key of a child bucket: `child:` or `extension:` by its
 *  relationship, then its case type and its repeat (`root` outside one). */
export function childBucketUnit(
	bucket: FrozenCaseWriteBucket,
): `child:${string}:${string}` | `extension:${string}:${string}` {
	const scope = bucket.repeatUuid ?? "root";
	return bucket.relationship === "extension"
		? `extension:${bucket.caseType}:${scope}`
		: `child:${bucket.caseType}:${scope}`;
}
