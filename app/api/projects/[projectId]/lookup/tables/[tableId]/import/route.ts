import { type NextRequest, NextResponse } from "next/server";
import { type ZodError, z } from "zod";
import { declaredBodyTooLarge, isClientAbort } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { log } from "@/lib/logger";
import { LOOKUP_MAX_CSV_BYTES } from "@/lib/lookup/constants";
import { parseLookupCsv, validateLookupCsv } from "@/lib/lookup/csv";
import { LookupError, lookupFailure } from "@/lib/lookup/errors";
import {
	hasUnpairedUtf16Surrogate,
	lookupRevisionSchema,
} from "@/lib/lookup/schema";
import { getLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import type {
	LookupFailure,
	LookupImportErrorCode,
	LookupScope,
} from "@/lib/lookup/types";

interface RouteContext {
	params: Promise<{ projectId: string; tableId: string }>;
}

const projectIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.refine((value) => !value.includes("\0"), "Project id may not contain NUL.")
	.refine(
		(value) => !hasUnpairedUtf16Surrogate(value),
		"Project id contains invalid Unicode.",
	);

function acceptsCsv(contentType: string | null): boolean {
	if (!contentType) return false;
	return /^text\/csv(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(
		contentType.trim(),
	);
}

function statusFor(code: LookupImportErrorCode): number {
	switch (code) {
		case "unauthenticated":
			return 401;
		case "not_found":
			return 404;
		case "conflict":
		case "tag_taken":
			return 409;
		case "row_limit":
		case "storage_limit":
		case "invalid_csv":
			return 422;
		case "invalid_input":
			return 400;
		case "internal_error":
			return 500;
	}
}

function failureResponse(
	failure: LookupFailure<LookupImportErrorCode>,
	status = statusFor(failure.code),
): NextResponse {
	return NextResponse.json(failure, { status });
}

function invalidInput(error: ZodError): LookupFailure<"invalid_input"> {
	return {
		success: false,
		code: "invalid_input",
		message: "The Project, table, or expected revision is invalid.",
		details: error.issues.slice(0, 100).map((issue) => ({
			code: "invalid_input",
			message: issue.message,
		})),
		totalDetailCount: error.issues.length,
	};
}

function csvTooLarge(): LookupFailure<"invalid_csv"> {
	return {
		success: false,
		code: "invalid_csv",
		message: `CSV exceeds the ${LOOKUP_MAX_CSV_BYTES}-byte request limit.`,
		details: [
			{
				code: "csv_too_large",
				message: `Choose a CSV no larger than ${LOOKUP_MAX_CSV_BYTES} bytes.`,
			},
		],
		totalDetailCount: 1,
	};
}

/** Atomic raw-CSV replacement. Parsed row arrays never cross a Server Action. */
export async function POST(req: NextRequest, context: RouteContext) {
	/* Reject a declared oversize before touching the body or any database. The
	 * post-buffer check below remains authoritative for chunked/misdeclared input. */
	if (declaredBodyTooLarge(req, LOOKUP_MAX_CSV_BYTES)) {
		return failureResponse(csvTooLarge(), 413);
	}

	try {
		const session = await requireSession(req);
		const rawParams = await context.params;
		const parsedRequest = z
			.object({
				projectId: projectIdSchema,
				tableId: lookupTableIdSchema,
				expectedTableRevision: lookupRevisionSchema,
			})
			.strict()
			.safeParse({
				...rawParams,
				expectedTableRevision: req.nextUrl.searchParams.get(
					"expectedTableRevision",
				),
			});
		if (!parsedRequest.success) {
			return failureResponse(invalidInput(parsedRequest.error));
		}
		const { projectId, tableId, expectedTableRevision } = parsedRequest.data;

		const access = await resolveProjectAccess(
			session.user.id,
			projectId,
			"edit",
		);
		const scope: LookupScope = {
			projectId: access.projectId,
			actorId: session.user.id,
			role: access.role,
		};

		if (!acceptsCsv(req.headers.get("content-type"))) {
			return failureResponse({
				success: false,
				code: "invalid_input",
				message: "Upload raw UTF-8 CSV with Content-Type text/csv.",
			});
		}

		/* Read the current definition before buffering/parsing. This is both the
		 * header/coercion context and a cheap stale-token rejection. A concurrent
		 * change after this snapshot is caught again under the service's locks. */
		const current = await getLookupTable(scope, tableId);
		if (current.tableRevision !== expectedTableRevision) {
			return failureResponse({
				success: false,
				code: "conflict",
				message: "This lookup table changed. Refresh it before importing.",
				currentRevisions: {
					definitionRevision: current.definitionRevision,
					rowsRevision: current.rowsRevision,
					tableRevision: current.tableRevision,
				},
			});
		}

		const bytes = new Uint8Array(await req.arrayBuffer());
		if (bytes.byteLength > LOOKUP_MAX_CSV_BYTES) {
			return failureResponse(csvTooLarge(), 413);
		}
		const parsed = parseLookupCsv(bytes);
		if (!parsed.success) return failureResponse(parsed);
		const validated = validateLookupCsv(parsed.value, current.columns);
		if (!validated.success) return failureResponse(validated);

		const receipt = await replaceLookupRows(scope, {
			tableId,
			expectedTableRevision,
			rows: validated.value.rows,
		});
		return NextResponse.json({ success: true, value: receipt });
	} catch (error) {
		if (isClientAbort(error)) {
			log.warn("[lookup/import] client aborted request", {
				err: error instanceof Error ? error.message : "aborted",
			});
			return failureResponse(
				{
					success: false,
					code: "internal_error",
					message: "Client closed request.",
				},
				499,
			);
		}
		if (error instanceof AppAccessError) {
			return failureResponse({
				success: false,
				code: "not_found",
				message: "Lookup table not found.",
			});
		}
		if (error instanceof LookupError) {
			return failureResponse(lookupFailure(error));
		}
		if (error instanceof Error && error.name === "ApiError") {
			const status = (error as Error & { status?: number }).status ?? 401;
			return failureResponse(
				{
					success: false,
					code: status === 401 ? "unauthenticated" : "internal_error",
					message:
						status === 401 ? "Authentication required." : "Import failed.",
				},
				status,
			);
		}
		log.error("[lookup/import] unhandled", error);
		return failureResponse({
			success: false,
			code: "internal_error",
			message: "The CSV could not be imported. Try again.",
		});
	}
}
