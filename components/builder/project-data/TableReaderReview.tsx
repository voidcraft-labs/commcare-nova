"use client";
import { useEffect, useState } from "react";
import { getLookupReferencingAppsAction } from "@/lib/lookup/actions";
import type { LookupTableId } from "@/lib/lookup/types";

export function useTableReaderReview(
	projectId: string,
	tableId: LookupTableId,
	enabled = true,
) {
	const [apps, setApps] =
		useState<{ appId: string; appName: string; deleted: boolean }[]>();
	const [error, setError] = useState("");
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		async function read() {
			try {
				const result = await getLookupReferencingAppsAction(projectId, {
					tableId,
				});
				if (active) {
					if (result.success) setApps(result.value);
					else setError(result.message);
				}
			} catch {
				if (active)
					setError(
						"Nova couldn't check which apps use this table. You can reopen these settings to try again.",
					);
			}
		}
		void read();
		return () => {
			active = false;
		};
	}, [projectId, tableId, enabled]);
	return { apps, error };
}

export function TableReaderReview({
	review,
}: {
	review: ReturnType<typeof useTableReaderReview>;
}) {
	if (review.error)
		return (
			<p role="alert" className="text-sm text-nova-rose">
				{review.error}
			</p>
		);
	if (!review.apps)
		return (
			<p role="status" className="text-sm">
				Checking which apps use this table
			</p>
		);
	if (!review.apps.length) return null;
	return (
		<div>
			<p className="text-sm font-medium">Apps using this table</p>
			<ul className="text-sm">
				{review.apps.map((app) => (
					<li key={app.appId}>
						{app.appName}
						{app.deleted ? " (in trash)" : ""}
					</li>
				))}
			</ul>
		</div>
	);
}
