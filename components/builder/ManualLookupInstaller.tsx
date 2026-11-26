"use client";

import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import type { CommCareSettingsPublic } from "@/lib/db/settings";
import {
	MANUAL_LOOKUP_MANIFEST,
	type ManualLookupManifest,
	manualLookupManifestSchema,
} from "@/lib/publish/manualLookupManifest";

type Review = {
	status: "review";
	confirmation: string;
	tables: { name: string; tag: string; rows: number }[];
};

export function ManualLookupInstaller({
	connection,
}: {
	connection: Extract<CommCareSettingsPublic, { configured: true }>;
}) {
	const [manifest, setManifest] = useState<ManualLookupManifest>();
	const [domain, setDomain] = useState("");
	const [review, setReview] = useState<Review>();
	const [message, setMessage] = useState("");
	const [working, setWorking] = useState(false);
	const [complete, setComplete] = useState(false);
	const [resume, setResume] = useState(false);
	const reset = () => {
		setReview(undefined);
		setMessage("");
		setComplete(false);
		setResume(false);
	};

	async function submit() {
		if (!manifest || working) return;
		setWorking(true);
		setMessage("");
		try {
			const response = await fetch("/api/commcare/lookup-install", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					manifest,
					server: connection.server,
					domain: domain.trim(),
					confirm: review?.confirmation,
				}),
			});
			const result = await response.json();
			if (!response.ok) {
				setReview(undefined);
				setResume(false);
				setMessage(
					typeof result.error === "string"
						? result.error
						: "Nova could not install the lookup data.",
				);
			} else if (result.status === "review") {
				setReview(result);
			} else if (result.status === "complete") {
				setComplete(true);
				setMessage(
					"The lookup data is ready. You can import the app JSON into this CommCare HQ project space.",
				);
			} else {
				setResume(result.status === "checkpoint");
				setMessage(result.message);
				if (result.status !== "checkpoint") setReview(undefined);
			}
		} catch {
			setMessage(
				"Nova could not confirm the lookup install. You can try again.",
			);
		} finally {
			setWorking(false);
		}
	}

	return (
		<form
			className="space-y-5"
			onSubmit={async (event) => {
				event.preventDefault();
				await submit();
			}}
		>
			<label htmlFor="lookup-install-manifest" className="block space-y-2">
				<span className="text-sm font-medium">Lookup install file</span>
				<Input
					id="lookup-install-manifest"
					type="file"
					accept=".json,application/json"
					disabled={working}
					onChange={async (event) => {
						reset();
						const input = event.currentTarget;
						const file = input.files?.[0];
						setManifest(undefined);
						try {
							if (!file || file.size > 2048) throw new Error();
							const parsed = manualLookupManifestSchema.parse(
								JSON.parse(await file.text()),
							);
							if (input.files?.[0] === file) setManifest(parsed);
						} catch {
							if (file && input.files?.[0] === file)
								setMessage(
									`Choose "${MANUAL_LOOKUP_MANIFEST}" from your import ZIP.`,
								);
						}
					}}
				/>
			</label>
			<label className="block space-y-2">
				<span className="text-sm font-medium">Project space</span>
				<select
					className="block h-9 w-full rounded-md border bg-background px-3 text-sm"
					value={domain}
					disabled={working}
					onChange={(event) => {
						reset();
						setDomain(event.currentTarget.value);
					}}
				>
					<option value="">Choose a connected project space</option>
					{connection.availableDomains.map(({ name, displayName }) => (
						<option key={name} value={name}>
							{displayName} ({name})
						</option>
					))}
				</select>
			</label>
			{review && (
				<ul className="divide-y rounded-md border text-sm">
					{review.tables.map(({ name, tag, rows }) => (
						<li key={tag} className="flex justify-between gap-3 p-3">
							<span>
								{name} ({tag})
							</span>
							<span>
								{rows.toLocaleString()} {rows === 1 ? "row" : "rows"}
							</span>
						</li>
					))}
				</ul>
			)}
			{message && (
				<p role="status" className="text-sm">
					{message}
				</p>
			)}
			<Button
				type="submit"
				disabled={!manifest || !domain.trim() || working || complete}
			>
				{working
					? "Checking lookup data"
					: resume
						? "Continue installing"
						: review
							? "Install lookup data"
							: "Review destination"}
			</Button>
		</form>
	);
}
