"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Field,
	FieldDescription,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import type { CommCareServer } from "@/lib/deployment";
import { projectSearchDestinationAction } from "@/lib/deployment/actions";
import { recordFromEntries } from "@/lib/domain/records";
import { projectSearchMenuLine } from "@/lib/publish/bringInCopy";

type Review = Extract<
	Awaited<ReturnType<typeof projectSearchDestinationAction>>,
	{ success: true }
>["data"];
type Connections = { review: Review; values: Record<string, string> };

function fromReview(review: Review): Connections {
	return {
		review,
		values: recordFromEntries(
			review.searches.map((row) => [
				row.searchUuid,
				row.endpointId?.toString() ?? "",
			]),
		),
	};
}

interface DestinationProps {
	appId: string;
	server: CommCareServer;
	domain: string;
	canEdit: boolean;
}

export function ProjectSearchConnections(props: DestinationProps) {
	const [generation, setGeneration] = useState(0);
	return (
		<DestinationConnections
			key={JSON.stringify([
				props.appId,
				props.server,
				props.domain,
				props.canEdit,
				generation,
			])}
			{...props}
			refresh={() => setGeneration((value) => value + 1)}
		/>
	);
}

function DestinationConnections({
	appId,
	server,
	domain,
	canEdit,
	refresh,
}: DestinationProps & { refresh: () => void }) {
	const id = useId();
	const [connections, setConnections] = useState<Connections>();
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		let current = true;
		setConnections(undefined);
		setMessage("");
		void projectSearchDestinationAction({ appId, server, domain })
			.then((result) => {
				if (!current) return;
				if (result.success) setConnections(fromReview(result.data));
				else setMessage(result.message);
			})
			.catch(() => {
				if (current)
					setMessage(
						"Nova couldn't read the search connections. Try again to see them.",
					);
			});
		return () => {
			current = false;
		};
	}, [appId, server, domain]);

	const save = async () => {
		if (!connections || saving || !canEdit) return;
		if (
			Object.values(connections.values).some(
				(value) =>
					value !== "" &&
					(!/^[1-9][0-9]*$/.test(value) || Number(value) > 2147483647),
			)
		) {
			setMessage(
				"Each search ID is a whole number from 1 to 2147483647. An empty ID disconnects the search.",
			);
			return;
		}
		setSaving(true);
		setMessage("");
		try {
			const result = await projectSearchDestinationAction(
				{ appId, server, domain },
				{
					version: connections.review.version,
					bindings: connections.review.searches.map(({ searchUuid }) => ({
						searchUuid,
						endpointId:
							connections.values[searchUuid] === ""
								? null
								: Number(connections.values[searchUuid]),
					})),
				},
			);
			if (result.success) {
				setConnections(fromReview(result.data));
				setMessage("Search connections saved.");
			} else setMessage(result.message);
		} catch {
			setMessage(
				"Nova couldn't confirm the save. Refresh the connections to check them.",
			);
		} finally {
			setSaving(false);
		}
	};
	const dirty = connections?.review.searches.some(
		(row) =>
			connections.values[row.searchUuid] !== (row.endpointId?.toString() ?? ""),
	);
	return (
		<FieldSet className="mt-4">
			<FieldLegend>Search connections</FieldLegend>
			<FieldDescription>
				Each ID selects a search managed in {domain}. Its current settings there
				determine which cases a worker sees.
			</FieldDescription>
			{connections?.review.searches.map((row) => (
				<Field key={row.searchUuid}>
					<FieldLabel htmlFor={id + row.searchUuid}>{row.name}</FieldLabel>
					<Input
						id={id + row.searchUuid}
						type="text"
						inputMode="numeric"
						value={connections.values[row.searchUuid]}
						disabled={!canEdit || saving}
						placeholder="Search ID"
						onChange={(event) => {
							const value = event.currentTarget.value;
							setMessage("");
							setConnections(
								(state) =>
									state && {
										...state,
										values: { ...state.values, [row.searchUuid]: value },
									},
							);
						}}
					/>
					{row.menus.length === 0 && (
						<FieldDescription>
							No menu currently uses this connection. Clear its ID to make it
							available to another search.
						</FieldDescription>
					)}
					{row.menus.map((menu) => (
						<FieldDescription key={menu.menuUuid}>
							{projectSearchMenuLine(menu)}
						</FieldDescription>
					))}
				</Field>
			))}
			{!connections && !message && (
				<p role="status">Reading search connections</p>
			)}
			{message && <p role="status">{message}</p>}
			<div className="flex gap-2">
				{canEdit && connections && (
					<Button
						type="button"
						variant="outline"
						disabled={!dirty || saving}
						onClick={save}
					>
						{saving ? "Saving" : "Save connections"}
					</Button>
				)}
				{message && (
					<Button
						type="button"
						variant="ghost"
						disabled={saving}
						onClick={refresh}
					>
						Refresh connections
					</Button>
				)}
			</div>
		</FieldSet>
	);
}
