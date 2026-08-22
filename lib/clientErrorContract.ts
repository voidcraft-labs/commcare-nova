/**
 * Browser-safe contract for the public client-error relay.
 *
 * The producer normalizes to these limits before Sentry or Cloud Logging sees
 * a report, and the public route independently validates the same contract.
 * Keep diagnostics explicit: this endpoint is not a general-purpose channel
 * for serializing application state.
 */

export const CLIENT_ERROR_LIMITS = {
	message: 2_000,
	stack: 8_000,
	url: 2_000,
	diagnosticString: 512,
	shortDiagnosticString: 128,
	issues: 5,
	truncatedFields: 12,
} as const;

export type ErrorSource =
	| "window.onerror"
	| "unhandledrejection"
	| "error-boundary"
	| "manual";

export interface ClientErrorTruncation {
	readonly messageBytes?: number;
	readonly stackBytes?: number;
	readonly componentStackBytes?: number;
	readonly urlBytes?: number;
	readonly diagnosticFields?: readonly string[];
}

/** Safe, bounded metadata understood by both observability channels. */
export interface ClientErrorDiagnostics {
	readonly component?: string;
	readonly operation?: string;
	readonly failureKind?: string;
	readonly appId?: string;
	readonly clientBuildId?: string;
	readonly baseSeq?: number;
	readonly eventId?: string;
	readonly payloadBytes?: number;
	readonly httpStatus?: number;
	readonly mutationIndex?: number | null;
	readonly pointer?: string;
	readonly reason?: string;
	readonly recoveryTrigger?: string;
	readonly issues?: readonly string[];
	readonly truncation?: ClientErrorTruncation;
}

/** Payload accepted from browser call sites before producer normalization. */
export interface ClientErrorPayload {
	readonly message: string;
	readonly stack?: string;
	readonly source: ErrorSource;
	readonly url: string;
	/** React component stack from error boundaries (separate from JS stack). */
	readonly componentStack?: string;
	readonly diagnostics?: ClientErrorDiagnostics;
}

export interface NormalizedClientErrorPayload extends ClientErrorPayload {
	readonly diagnostics: ClientErrorDiagnostics;
}

const CLIENT_BUILD_ID =
	process.env.NEXT_PUBLIC_NOVA_BUILD_ID?.trim() || "local";
const UTF8_ENCODER = new TextEncoder();

/** UTF-8 size for diagnostic volume fields; length limits remain JS strings. */
export function clientErrorUtf8Bytes(value: string): number {
	return UTF8_ENCODER.encode(value).byteLength;
}

function truncate(
	value: string | undefined,
	limit: number,
): { value?: string; originalBytes?: number } {
	if (value === undefined) return {};
	const originalBytes = clientErrorUtf8Bytes(value);
	if (value.length <= limit && originalBytes <= limit) return { value };
	let bytes = 0;
	let end = 0;
	for (const character of value) {
		const characterBytes = clientErrorUtf8Bytes(character);
		if (bytes + characterBytes > limit) break;
		bytes += characterBytes;
		end += character.length;
	}
	return {
		value: value.slice(0, end),
		originalBytes,
	};
}

/** Keep the exception name and first real frames when a multiline parser
 * message would otherwise consume the entire Cloud Logging stack budget. */
function truncateStack(value: string | undefined): {
	value?: string;
	originalBytes?: number;
} {
	if (value === undefined) return {};
	const limit = CLIENT_ERROR_LIMITS.stack;
	const originalBytes = clientErrorUtf8Bytes(value);
	if (value.length <= limit && originalBytes <= limit) return { value };
	const firstFrame = value.search(/\n\s+at\s/);
	if (firstFrame > 0) {
		const firstLineEnd = value.indexOf("\n");
		const header = value.slice(0, firstLineEnd < 0 ? firstFrame : firstLineEnd);
		const safeHeader =
			truncate(header, CLIENT_ERROR_LIMITS.shortDiagnosticString).value ??
			"Error";
		const compact = `${safeHeader}\n[stack message truncated]\n${value.slice(firstFrame + 1)}`;
		return {
			...truncate(compact, limit),
			originalBytes,
		};
	}
	return truncate(value, limit);
}

function diagnosticString(
	value: string | undefined,
	field: string,
	limit: number,
	truncatedFields: string[],
): string | undefined {
	if (value === undefined) return undefined;
	const normalized = truncate(value, limit);
	if (normalized.originalBytes === undefined) return normalized.value;
	truncatedFields.push(field);
	return normalized.value;
}

function nonNegativeSafeInteger(value: number | undefined): number | undefined {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function largestKnownByteCount(
	first: number | undefined,
	second: number | undefined,
): number | undefined {
	const normalizedFirst = nonNegativeSafeInteger(first);
	const normalizedSecond = nonNegativeSafeInteger(second);
	if (normalizedFirst === undefined) return normalizedSecond;
	if (normalizedSecond === undefined) return normalizedFirst;
	return Math.max(normalizedFirst, normalizedSecond);
}

/**
 * Normalize before BOTH outputs. This keeps Sentry and the Cloud relay on the
 * same bounded, data-minimized representation and guarantees a report emitted
 * by this client satisfies the route's field caps.
 */
export function normalizeClientErrorPayload(
	payload: ClientErrorPayload,
	options?: { readonly clientBuildId?: string | null },
): NormalizedClientErrorPayload {
	const message = truncate(payload.message, CLIENT_ERROR_LIMITS.message);
	const stack = truncateStack(payload.stack);
	const componentStack = truncate(
		payload.componentStack,
		CLIENT_ERROR_LIMITS.stack,
	);
	const url = truncate(payload.url, CLIENT_ERROR_LIMITS.url);
	const diagnostics = payload.diagnostics ?? {};
	const diagnosticFields =
		diagnostics.truncation?.diagnosticFields
			?.slice(0, CLIENT_ERROR_LIMITS.truncatedFields)
			.map(
				(field) =>
					truncate(field, CLIENT_ERROR_LIMITS.shortDiagnosticString).value ??
					"unknown",
			) ?? [];
	const issues = diagnostics.issues
		?.slice(0, CLIENT_ERROR_LIMITS.issues)
		.map((issue, index) =>
			diagnosticString(
				issue,
				`issues.${index}`,
				CLIENT_ERROR_LIMITS.diagnosticString,
				diagnosticFields,
			),
		)
		.filter((issue): issue is string => issue !== undefined);
	if (
		diagnostics.issues !== undefined &&
		diagnostics.issues.length > CLIENT_ERROR_LIMITS.issues
	) {
		diagnosticFields.push("issues");
	}
	const component = diagnosticString(
		diagnostics.component,
		"component",
		CLIENT_ERROR_LIMITS.shortDiagnosticString,
		diagnosticFields,
	);
	const operation = diagnosticString(
		diagnostics.operation,
		"operation",
		CLIENT_ERROR_LIMITS.shortDiagnosticString,
		diagnosticFields,
	);
	const failureKind = diagnosticString(
		diagnostics.failureKind,
		"failureKind",
		CLIENT_ERROR_LIMITS.shortDiagnosticString,
		diagnosticFields,
	);
	const appId = diagnosticString(
		diagnostics.appId,
		"appId",
		CLIENT_ERROR_LIMITS.shortDiagnosticString,
		diagnosticFields,
	);
	const clientBuildId = diagnosticString(
		options?.clientBuildId === null
			? undefined
			: (options?.clientBuildId ?? CLIENT_BUILD_ID),
		"clientBuildId",
		CLIENT_ERROR_LIMITS.shortDiagnosticString,
		diagnosticFields,
	);
	const eventId = diagnosticString(
		diagnostics.eventId,
		"eventId",
		CLIENT_ERROR_LIMITS.shortDiagnosticString,
		diagnosticFields,
	);
	const pointer = diagnosticString(
		diagnostics.pointer,
		"pointer",
		CLIENT_ERROR_LIMITS.diagnosticString,
		diagnosticFields,
	);
	const reason = diagnosticString(
		diagnostics.reason,
		"reason",
		CLIENT_ERROR_LIMITS.shortDiagnosticString,
		diagnosticFields,
	);
	const recoveryTrigger = diagnosticString(
		diagnostics.recoveryTrigger,
		"recoveryTrigger",
		CLIENT_ERROR_LIMITS.shortDiagnosticString,
		diagnosticFields,
	);
	const messageBytes = largestKnownByteCount(
		message.originalBytes,
		diagnostics.truncation?.messageBytes,
	);
	const stackBytes = largestKnownByteCount(
		stack.originalBytes,
		diagnostics.truncation?.stackBytes,
	);
	const componentStackBytes = largestKnownByteCount(
		componentStack.originalBytes,
		diagnostics.truncation?.componentStackBytes,
	);
	const urlBytes = largestKnownByteCount(
		url.originalBytes,
		diagnostics.truncation?.urlBytes,
	);

	const truncation: ClientErrorTruncation = {
		...(messageBytes === undefined ? {} : { messageBytes }),
		...(stackBytes === undefined ? {} : { stackBytes }),
		...(componentStackBytes === undefined ? {} : { componentStackBytes }),
		...(urlBytes === undefined ? {} : { urlBytes }),
		...(diagnosticFields.length === 0
			? {}
			: {
					diagnosticFields: [...new Set(diagnosticFields)].slice(
						0,
						CLIENT_ERROR_LIMITS.truncatedFields,
					),
				}),
	};

	return {
		message: message.value ?? "",
		...(stack.value === undefined ? {} : { stack: stack.value }),
		source: payload.source,
		url: url.value ?? "",
		...(componentStack.value === undefined
			? {}
			: { componentStack: componentStack.value }),
		diagnostics: {
			component,
			operation,
			failureKind,
			appId,
			clientBuildId,
			baseSeq: nonNegativeSafeInteger(diagnostics.baseSeq),
			eventId,
			payloadBytes: nonNegativeSafeInteger(diagnostics.payloadBytes),
			httpStatus: nonNegativeSafeInteger(diagnostics.httpStatus),
			mutationIndex:
				diagnostics.mutationIndex === null
					? null
					: nonNegativeSafeInteger(diagnostics.mutationIndex),
			pointer,
			reason,
			recoveryTrigger,
			...(issues === undefined ? {} : { issues }),
			...(Object.keys(truncation).length === 0 ? {} : { truncation }),
		},
	};
}
