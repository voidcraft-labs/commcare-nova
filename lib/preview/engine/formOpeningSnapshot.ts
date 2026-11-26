import { z } from "zod";
import type { CaseRow } from "@/lib/case-store/store";
import {
	type BlueprintDoc,
	operationSavesOnlyChanged,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import type {
	WebFormActivityEntry,
	WebFormActivityNotice,
} from "@/lib/domain/webFormActivity";
import type { EntrySessionData } from "./entrySessionData";
import { expressionReadsCaseDatabase } from "./expressionCaseReads";
import type { LookupFixtureDataWire } from "./lookupDataBinding";
import { previewLookupData } from "./lookupEvaluation";
import { caseOperationProgramLookupTableIds } from "./lookupTableReferences";
import type { PreviewDevice } from "./previewDevice";
import type { CaseDatabaseSnapshot } from "./xpathInstances";

type TimestampKey = "opened_on" | "modified_on" | "closed_on";
type StoredOpeningRow = Omit<CaseRow, TimestampKey> &
	Record<TimestampKey, string | null>;

export interface FormOpeningCaseData
	extends Omit<CaseDatabaseSnapshot, "rows"> {
	readonly rows: readonly StoredOpeningRow[];
}

/** Dates cross the signature and SQL boundaries as ISO instants. Map and
 * Date object representations never enter the content digest. */
export function openingCaseData(
	snapshot: CaseDatabaseSnapshot,
): FormOpeningCaseData {
	return {
		...snapshot,
		rows: snapshot.rows.map((row) => ({
			...row,
			opened_on: row.opened_on?.toISOString() ?? null,
			modified_on: row.modified_on?.toISOString() ?? null,
			closed_on: row.closed_on?.toISOString() ?? null,
		})),
	};
}

export function restoreOpeningCases(
	snapshot: FormOpeningCaseData,
): CaseDatabaseSnapshot {
	return {
		...snapshot,
		rows: snapshot.rows.map((row) => ({
			...row,
			opened_on: row.opened_on === null ? null : new Date(row.opened_on),
			modified_on: row.modified_on === null ? null : new Date(row.modified_on),
			closed_on: row.closed_on === null ? null : new Date(row.closed_on),
		})),
	};
}

export function restoreOpeningLookup(lookup: LookupFixtureDataWire) {
	return previewLookupData({
		...lookup,
		rowsByTable: new Map(
			Object.entries(lookup.rowsByTable).map(([table, rows]) => [
				lookupTableIdSchema.parse(table),
				rows,
			]),
		),
	});
}
export interface FormOpeningAudience {
	readonly app: string;
	readonly project: string;
	readonly actor: string;
	readonly session: string;
	readonly worker: string;
	readonly persona: string | null;
	readonly device: PreviewDevice;
	readonly run: string;
	readonly module: Uuid;
	readonly form: Uuid;
	readonly entry: string;
	readonly revision: number;
	readonly blueprintDigest: string;
}

/** An authorized move between two client-owned runs within one device scope. */
export interface ReceiptRunTransition {
	readonly from: string;
	readonly to: string;
	readonly entry?: string;
	readonly signature: string;
}

export interface FormOpeningProjection {
	readonly webActivity?: WebFormActivityEntry;
	/** A bound restore's start is the conservative proof of when the
	 * worker could first see the rows. Held through the choice walk. */
	readonly webActivityRestoreStartedAt?: number;
	readonly cases: FormOpeningCaseData;
	readonly lookup: LookupFixtureDataWire;
	/** Stable supplying identities in the order the physical route reached them. */
	readonly choices: readonly {
		readonly selection: Uuid;
		readonly caseId: string;
	}[];
	/** Values a link supplied before an earlier manual prompt. Verify each
	 * choice against its actual list as soon as execution reaches it. */
	readonly carried?: readonly {
		readonly selection: Uuid;
		readonly caseId: string;
	}[];
	/** The entry's own cases and its automatically reached values are signed
	 * separately: a blank text value is distinct from an absent selection. */
	readonly primaryCaseIds: readonly string[];
	readonly parentChoices?: Readonly<Record<string, readonly string[]>>;
	/** The cases the submission that opened this entry left on the device
	 * (`afterSubmission`), held there until sync though a restore may omit
	 * them (a case it closed). */
	readonly submittedCaseIds?: readonly string[];
	readonly datums: Readonly<Record<string, string>>;
	readonly resolvedEntries: Readonly<Record<string, string>>;
	readonly sessionData: Readonly<Record<string, string>>;
	/** Case IDs set by the form's root ready actions at its first opening. */
	readonly caseCreateIds?: Readonly<Record<string, string>>;
	readonly complete: boolean;
}

export const signedOpeningSchema = z.strictObject({
	version: z.literal(1),
	content: z.string(),
	signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SignedFormOpening = z.infer<typeof signedOpeningSchema>;
export const formOpeningBindingSchema = z.strictObject({
	module: uuidSchema,
	run: z.uuid(),
	evidence: signedOpeningSchema,
});
export type FormOpeningBinding = z.infer<typeof formOpeningBindingSchema>;

export interface FormOpeningState {
	readonly activityNotice?: WebFormActivityNotice;
	readonly binding: FormOpeningBinding;
	readonly projection: FormOpeningProjection;
	readonly blueprintDigest: string;
	readonly entry: string;
	readonly next?: EntrySessionData["nextSelection"];
}

/** These inputs first exist when this form entry opens. A missing binding
 * would otherwise let submission reinterpret the worker's choices. */
export function formNeedsOpeningEvidence(
	doc: BlueprintDoc,
	formUuid: Uuid,
): boolean {
	const form = doc.forms[formUuid];
	if (!form) return false;
	if (
		form.shadowOf !== undefined ||
		form.activityKeyText !== undefined ||
		form.caseSelections !== undefined ||
		form.computedDatums?.length ||
		form.openingAssignments?.length
	)
		return true;
	const operations = form.caseOperations ?? [];
	if (
		operations.some(
			(operation) =>
				operation.ownerAfterCreate !== undefined ||
				operation.writes?.some((write) => write.via) ||
				operationSavesOnlyChanged(operation) ||
				(operation.action !== "own" &&
					(operation.target.kind === "expression" ||
						operation.target.kind === "worker-record" ||
						(operation.target.kind === "new" &&
							operation.target.expr !== undefined))),
		)
	)
		return true;
	const fields = [...(formStructure(doc, formUuid)?.fields.keys() ?? [])];
	const owners = [
		{ entity: "form" as const, uuid: formUuid },
		...fields.map((uuid) => ({ entity: "field" as const, uuid })),
	];
	return (
		owners.some((owner) =>
			expressionSlotValues(doc, owner).some(({ expression }) =>
				expressionReadsCaseDatabase(expression, doc),
			),
		) ||
		caseOperationProgramLookupTableIds(doc, [
			formUuid,
			...fields,
			...operations.map((operation) => operation.uuid),
		]).length > 0
	);
}
