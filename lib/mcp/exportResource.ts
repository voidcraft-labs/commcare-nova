import {
	type McpServer,
	ResourceNotFoundError,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { ApiError } from "@/lib/apiError";
import { AppAccessError } from "@/lib/db/appAccess";
import { EXPORT_RESOURCE_BYTES } from "@/lib/export/artifacts/range";
import { exportRange, readExportManifest } from "@/lib/export/artifacts/store";
import type { ToolContext } from "./types";

export function registerExportResource(server: McpServer, ctx: ToolContext) {
	server.registerResource(
		"export-bytes",
		new ResourceTemplate("nova://exports/{id}/bytes/{offset}", {
			list: undefined,
		}),
		{
			description:
				"Download the next part of a prepared app file using the same connection.",
			mimeType: "application/octet-stream",
		},
		async (uri, variables, request) => {
			const { id, offset } = variables;
			if (
				!ctx.grant ||
				typeof id !== "string" ||
				!z.uuid().safeParse(id).success ||
				typeof offset !== "string" ||
				!/^(?:0|[1-9]\d*)$/.test(offset)
			)
				throw new ResourceNotFoundError(uri.href);
			const start = Number(offset);
			const actor = { userId: ctx.userId, grant: ctx.grant };
			try {
				const manifest = await readExportManifest(actor, id);
				if (!Number.isSafeInteger(start) || start >= manifest.byteLength)
					throw new ResourceNotFoundError(uri.href);
				const end = Math.min(
					start + EXPORT_RESOURCE_BYTES,
					manifest.byteLength,
				);
				const buffers: Uint8Array[] = [];
				for await (const bytes of exportRange(
					actor,
					id,
					{ start, end: end - 1 },
					request.mcpReq.signal,
				))
					buffers.push(bytes);
				return {
					contents: [
						{
							uri: uri.href,
							mimeType: "application/octet-stream",
							blob: Buffer.concat(buffers).toString("base64"),
						},
					],
					_meta: {
						next:
							end < manifest.byteLength
								? `nova://exports/${id}/bytes/${end}`
								: null,
					},
				};
			} catch (error) {
				if (
					error instanceof AppAccessError ||
					(error instanceof ApiError && error.status === 404)
				)
					throw new ResourceNotFoundError(uri.href);
				throw error;
			}
		},
	);
}
