import { LOOKUP_MAX_VALIDATION_DETAILS } from "./constants";
import type {
	LookupActionErrorCode,
	LookupFailure,
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

	constructor(
		code: LookupActionErrorCode,
		message: string,
		options: {
			cause?: unknown;
			details?: LookupValidationDetail[];
			totalDetailCount?: number;
			currentRevisions?: LookupTableRevisions;
		} = {},
	) {
		super(message, { cause: options.cause });
		this.name = "LookupError";
		this.code = code;
		this.details = options.details;
		this.totalDetailCount = options.totalDetailCount;
		this.currentRevisions = options.currentRevisions;
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
		...(error.currentRevisions === undefined
			? {}
			: { currentRevisions: error.currentRevisions }),
	};
}
