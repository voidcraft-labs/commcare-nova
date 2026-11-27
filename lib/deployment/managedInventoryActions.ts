"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { LookupError } from "@/lib/lookup/errors";
import {
	type InventoryCursor,
	readInventoryPiece,
	readInventoryStatus,
} from "@/lib/lookup/generations/read";
import type { InventoryAccess } from "@/lib/lookup/generations/scope";
import { cancelInventory } from "@/lib/lookup/generations/store";
import { inspectManagedLookupWorker } from "./managedData";
import { inspectSourceInventory } from "./managedInventory";
import {
	attestSourceWorkbook,
	historicalSourceWorkbook,
	inspectInlineSourceRow,
	sourceWorkbookBytes,
	workerInspection,
} from "./managedLookupObservation";

const cursorSchema = z.strictObject({
	generationId: z.uuid(),
	ordinal: z.number().int().nonnegative(),
	byteOffset: z.number().int().nonnegative(),
});
const unavailable = {
	ok: false as const,
	message: "This inventory is unavailable with this connection.",
};
async function authorized<T>(
	project: unknown,
	table: unknown,
	fn: (access: InventoryAccess) => Promise<T>,
) {
	const projectId = z.string().min(1).max(255).safeParse(project);
	const tableId = lookupTableIdSchema.safeParse(table);
	const session = await getSession();
	if (!session || !projectId.success || !tableId.success) return unavailable;
	try {
		const access = await resolveProjectAccess(
			session.user.id,
			projectId.data,
			"edit",
		);
		const result = await fn({
			grant: { kind: "session", sessionId: session.session.id },
			tableId: tableId.data,
			scope: {
				actorId: session.user.id,
				projectId: access.projectId,
				role: access.role,
			},
		});
		return { ok: true as const, ...result };
	} catch (error) {
		if (error instanceof AppAccessError) return unavailable;
		if (error instanceof LookupError)
			return { ok: false as const, message: error.message };
		throw error;
	}
}
export async function getManagedInventoryStatusAction(
	projectId: string,
	tableId: string,
) {
	return authorized(projectId, tableId, async (access) => {
		const status = await readInventoryStatus(access);
		if (!status.active && !status.staged) return status;
		return inspectSourceInventory(access, (digest) =>
			readInventoryStatus(access, digest),
		);
	});
}
export async function readManagedInventoryAction(
	projectId: string,
	tableId: string,
	cursor?: InventoryCursor,
) {
	const parsed = cursorSchema.optional().safeParse(cursor);
	if (!parsed.success) return unavailable;
	return authorized(projectId, tableId, (access) =>
		inspectSourceInventory(access, (digest) =>
			readInventoryPiece(access, parsed.data, digest),
		),
	);
}
export async function cancelManagedInventoryAction(
	projectId: string,
	tableId: string,
	stagedGenerationId: string,
) {
	const id = z.uuid().safeParse(stagedGenerationId);
	if (!id.success) return unavailable;
	return authorized(projectId, tableId, async (access) => {
		await cancelInventory(access, id.data);
		return {};
	});
}

export async function inspectManagedLookupWorkerAction(
	projectId: string,
	tableId: string,
	username: string,
) {
	if (typeof username !== "string" || username.length > 128) return unavailable;
	return authorized(projectId, tableId, async (access) => {
		const result = await inspectManagedLookupWorker(access, username);
		if (!result.ok) throw new LookupError("managed_in_hq", result.message);
		return { inspection: workerInspection(result.worker) };
	});
}
export async function attestSourceWorkbookAction(
	projectId: string,
	tableId: string,
	form: FormData,
) {
	return authorized(projectId, tableId, async (access) => {
		const file = form.get("workbook");
		if (
			!(file instanceof File) ||
			file.size > sourceWorkbookBytes ||
			!file.size
		)
			throw new LookupError(
				"invalid_input",
				"You can choose a selected-table workbook up to 768 KiB.",
			);
		return {
			receipt: await attestSourceWorkbook(
				access,
				Buffer.from(await file.arrayBuffer()),
			),
		};
	});
}
export async function readSourceWorkbookReceiptAction(
	projectId: string,
	tableId: string,
) {
	return authorized(projectId, tableId, async (access) => ({
		receipt: await historicalSourceWorkbook(access),
	}));
}

export async function inspectInlineSourceRowAction(
	projectId: string,
	tableId: string,
	ordinal: number,
	revision?: string,
) {
	return authorized(projectId, tableId, async (access) => ({
		page: await inspectInlineSourceRow(access, ordinal, revision),
	}));
}
