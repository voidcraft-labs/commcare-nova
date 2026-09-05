"use client";
import { useBuilderLookupCatalog } from "@/components/builder/lookup/BuilderLookupCatalogProvider";
import { Button } from "@/components/shadcn/button";
import type { BuilderWriteAdmission } from "@/lib/doc/builderWriteAdmission";

/** Reflect the real commit gate while its Project definitions arrive. */
export function EntryPointWriteNotice({
	admission,
}: {
	admission: BuilderWriteAdmission;
}) {
	const catalog = useBuilderLookupCatalog();
	if (admission.ok) return null;
	return (
		<div
			role={catalog.kind === "error" ? "alert" : "status"}
			className="space-y-2 text-sm text-nova-text-secondary"
		>
			<p>{admission.messages.join(" ")}</p>
			{catalog.kind === "error" && (
				<Button variant="outline" onClick={() => void catalog.retry()}>
					Try again
				</Button>
			)}
		</div>
	);
}
