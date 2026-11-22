import { Readable } from "node:stream";
import { z } from "zod";
import { handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { artifactUnavailable } from "@/lib/export/artifacts/access";
import { readByteRange } from "@/lib/export/artifacts/range";
import { exportRange, readExportManifest } from "@/lib/export/artifacts/store";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;
		if (!z.uuid().safeParse(id).success) return artifactUnavailable();
		const actor = {
			userId: session.user.id,
			grant: { kind: "session" as const, sessionId: session.session.id },
		};
		const manifest = await readExportManifest(actor, id);
		const etag = `"${manifest.sha256}"`;
		const ifRange = req.headers.get("If-Range");
		const header =
			ifRange !== null && ifRange !== etag ? null : req.headers.get("Range");
		const range = readByteRange(header, manifest.byteLength);
		const headers = new Headers({
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, no-store",
			ETag: etag,
			"Content-Type":
				manifest.format === "zip"
					? "application/zip"
					: "application/octet-stream",
			"Content-Disposition": `attachment; filename="${manifest.filename}"`,
			"X-Content-Type-Options": "nosniff",
		});
		if (!range) {
			headers.set("Content-Range", `bytes */${manifest.byteLength}`);
			return new Response(null, { status: 416, headers });
		}
		headers.set("Content-Length", String(range.end - range.start + 1));
		if (header !== null)
			headers.set(
				"Content-Range",
				`bytes ${range.start}-${range.end}/${manifest.byteLength}`,
			);
		const stream = Readable.from(exportRange(actor, id, range, req.signal), {
			objectMode: false,
			highWaterMark: 1,
			signal: req.signal,
		});
		return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
			headers,
			status: header === null ? 200 : 206,
		});
	} catch (error) {
		return handleApiError(
			error instanceof Error ? error : new Error("Download failed."),
		);
	}
}
