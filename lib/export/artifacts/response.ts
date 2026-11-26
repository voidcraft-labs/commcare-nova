import type { DownloadTarget } from "@/lib/deployment/downloadTarget";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import { compileExportSpec, type ExportActor } from "./access";
import { deliverExport } from "./store";

export async function compileDownloadResponse(input: {
	source: AsyncIterable<Uint8Array>;
	filename: string;
	prepared: PreparedExportBoundary;
	download: DownloadTarget;
	appId: string;
	actor: () => ExportActor;
	headers: Record<string, string>;
	signal: AbortSignal;
}) {
	const { prepared, filename, download } = input;
	const result = await deliverExport(
		input.source,
		() => ({
			actor: input.actor(),
			spec: compileExportSpec(input.appId, prepared, download, filename),
		}),
		{
			signal: input.signal,
			protected:
				prepared.assignmentWitness !== undefined ||
				(prepared.jsonLookupTables?.length ?? 0) > 0,
		},
	);
	const headers = new Headers(input.headers);
	headers.set("Cache-Control", "private, no-store");
	if ("artifact" in result) {
		headers.delete("Content-Disposition");
		headers.set("Content-Type", "application/json");
		return Response.json({ artifact: result.artifact }, { headers });
	}
	headers.set("Content-Length", String(result.bytes.length));
	return new Response(new Uint8Array(result.bytes), { headers });
}
