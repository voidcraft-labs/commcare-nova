"use client";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";

export function PlaceWorkbookButton({
	appId,
	server,
	domain,
}: {
	appId: string;
	server: string;
	domain: string;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<div className="mt-2 flex flex-col items-start gap-1">
			<Button
				type="button"
				variant="ghost"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					setError("");
					try {
						const response = await fetch("/api/compile/place-ids", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ appId, server, domain }),
						});
						const body = await response.json();
						if (!response.ok || typeof body.artifact?.id !== "string")
							throw Error(
								typeof body.error === "string"
									? body.error
									: "Nova couldn’t prepare this workbook. Check your access to the project space and try again.",
							);
						const link = document.createElement("a");
						link.href = `/api/compile/downloads/${encodeURIComponent(body.artifact.id)}`;
						link.download = body.artifact.filename;
						link.click();
					} catch (error) {
						setError(
							error instanceof Error
								? error.message
								: "Nova couldn’t prepare this workbook.",
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				{busy ? "Preparing workbook" : "Download place ID workbook"}
			</Button>
			{error && (
				<p role="alert" className="text-xs text-nova-red">
					{error}
				</p>
			)}
		</div>
	);
}
