import { LOOKUP_MAX_VALIDATION_DETAILS } from "./constants";
import type {
	LookupActionErrorCode,
	LookupFailure,
	LookupReferencingAppSummary,
	LookupRowId,
	LookupTableRevisions,
	LookupValidationDetail,
} from "./types";

export interface LookupIssueCollector {
	readonly details: LookupValidationDetail[];
	readonly totalDetailCount: number;
	add(detail: LookupValidationDetail): void;
}

/** Retains a bounded sample while continuing to count every issue. */
export function createLookupIssueCollector(
	maxDetails = LOOKUP_MAX_VALIDATION_DETAILS,
): LookupIssueCollector {
	if (!Number.isSafeInteger(maxDetails) || maxDetails < 0) {
		throw new RangeError("maxDetails must be a nonnegative safe integer");
	}
	const details: LookupValidationDetail[] = [];
	let totalDetailCount = 0;
	return {
		details,
		get totalDetailCount() {
			return totalDetailCount;
		},
		add(detail) {
			totalDetailCount++;
			if (details.length < maxDetails) details.push(detail);
		},
	};
}

/** Expected service-layer rejection. Infrastructure failures stay unwrapped. */
export class LookupError extends Error {
	readonly code: LookupActionErrorCode;
	readonly details?: LookupValidationDetail[];
	readonly totalDetailCount?: number;
	readonly currentRevisions?: LookupTableRevisions;
	readonly blockingApps?: readonly LookupReferencingAppSummary[];
	readonly incompatibleRowIds?: readonly LookupRowId[];

	constructor(
		code: LookupActionErrorCode,
		message: string,
		options: {
			cause?: unknown;
			details?: LookupValidationDetail[];
			totalDetailCount?: number;
			currentRevisions?: LookupTableRevisions;
			blockingApps?: readonly LookupReferencingAppSummary[];
			incompatibleRowIds?: readonly LookupRowId[];
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "LookupError";
		this.code = code;
		this.details = options.details;
		this.totalDetailCount = options.totalDetailCount;
		this.currentRevisions = options.currentRevisions;
		this.blockingApps = options.blockingApps;
		this.incompatibleRowIds = options.incompatibleRowIds;
	}
}

/**
 * A managed copy past one inline copy's bounds (rows, columns, a value, a
 * row, or the bytes Postgres measured once written): nothing was written,
 * and only a paged refresh into a generation takes a table this size. A
 * `storage_limit`, told apart from the Project's own storage running out so
 * each caller can say which next step reaches the table.
 */
export class LookupPastInlineCopyError extends LookupError {
	constructor(message: string) {
		super("storage_limit", message);
		this.name = "LookupPastInlineCopyError";
	}
}

export function lookupFailure(error: LookupError): LookupFailure {
	return {
		success: false,
		code: error.code,
		message: error.message,
		...(error.details === undefined ? {} : { details: error.details }),
		...(error.totalDetailCount === undefined
			? {}
			: { totalDetailCount: error.totalDetailCount }),
		...(error.blockingApps === undefined
			? {}
			: { blockingApps: error.blockingApps }),
		...(error.currentRevisions === undefined
			? {}
			: { currentRevisions: error.currentRevisions }),
	};
}
