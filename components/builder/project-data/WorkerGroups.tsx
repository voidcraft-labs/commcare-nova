"use client";
import { useEffect, useId, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import type { Uuid } from "@/lib/domain/uuid";
import {
	editWorkerGroupAction,
	readWorkerGroupsAction,
} from "@/lib/lookup/actions";
import type { WorkerGroupEdit } from "@/lib/lookup/assignmentVocabulary";
import { useProjectId } from "@/lib/session/hooks";
import { GroupConnection } from "./GroupConnection";
import { sendLookupGesture } from "./lookupGesture";

type ReadResult = Extract<
	Awaited<ReturnType<typeof readWorkerGroupsAction>>,
	{ success: true }
>["value"];
export function WorkerGroups() {
	const projectId = useProjectId();
	const [open, setOpen] = useState(false);
	return (
		<section className="mt-4">
			<Button
				variant="outline"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				Worker groups
			</Button>
			{open && projectId && (
				<GroupDirectory key={projectId} projectId={projectId} />
			)}
		</section>
	);
}
function GroupDirectory({ projectId }: { projectId: string }) {
	const queryId = useId();
	const [query, setQuery] = useState("");
	const [offset, setOffset] = useState(0);
	const [memberOffset, setMemberOffset] = useState(0);
	const [groupId, setGroupId] = useState<Uuid>();
	const [data, setData] = useState<ReadResult>();
	const [updated, setUpdated] = useState(0);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		// A save or explicit refresh starts a new fetch for the same selection.
		void updated;
		let current = true;
		setData(undefined);
		async function read() {
			try {
				const r = await readWorkerGroupsAction(projectId, {
					search: { query, offset, kind: groupId ? "worker" : "group" },
					groupId,
					memberOffset,
				});
				if (current && r.success) {
					setData(r.value);
					setError("");
				} else if (current && !r.success) setError(r.message);
			} catch {
				if (current)
					setError("Nova couldn't load your groups. You can try again.");
			}
		}
		void read();
		return () => {
			current = false;
		};
	}, [projectId, groupId, query, offset, memberOffset, updated]);
	const select = (id?: Uuid) => {
		setGroupId(id);
		setData(undefined);
		setOffset(0);
		setMemberOffset(0);
		setQuery("");
		setCreating(false);
	};
	const save = async (change: WorkerGroupEdit["change"]) => {
		if (!data || busy) return;
		setBusy(true);
		try {
			const result = await sendLookupGesture(editWorkerGroupAction, projectId, {
				expectedProjectRevision: data.projectRevision,
				change,
			});
			if (result.success) {
				select(result.value.groupId);
				setUpdated((x) => x + 1);
			} else setError(result.message);
		} catch {
			setError("Nova couldn't save the group. You can try again.");
		} finally {
			setBusy(false);
		}
	};
	const selected = data?.selected;
	return (
		<div className="mt-3 max-w-lg space-y-3 text-sm">
			{groupId && (
				<Button variant="ghost" onClick={() => select()}>
					Back to groups
				</Button>
			)}
			{selected && (
				<GroupSettings
					key={selected.group.id + data.projectRevision}
					group={selected.group}
					busy={busy}
					save={save}
				/>
			)}
			{selected && (
				<GroupConnection
					key={selected.group.id}
					projectId={projectId}
					group={selected.group}
					busy={busy}
					save={save}
				/>
			)}
			{creating && <GroupSettings busy={busy} save={save} />}
			{!groupId && !creating && (
				<Button variant="outline" onClick={() => setCreating(true)}>
					New group
				</Button>
			)}
			{selected && (
				<div>
					<p className="font-medium">Group members</p>
					{selected.members.length === 0 && <p>No workers on this page.</p>}
					{selected.members.map((member) => (
						<div key={member.appId + member.personaId}>
							{member.name} · {member.appName}{" "}
							<Button
								variant="ghost"
								disabled={busy}
								onClick={() =>
									save({
										kind: "membership",
										groupId: selected.group.id,
										appId: member.appId,
										personaId: member.personaId,
										member: false,
									})
								}
							>
								Remove
							</Button>
						</div>
					))}
					{memberOffset > 0 && (
						<Button
							variant="ghost"
							onClick={() => setMemberOffset(Math.max(0, memberOffset - 50))}
						>
							Previous members
						</Button>
					)}
					{selected.nextOffset !== null && (
						<Button
							variant="ghost"
							onClick={() => setMemberOffset(selected.nextOffset ?? 0)}
						>
							More members
						</Button>
					)}
				</div>
			)}
			<label htmlFor={queryId}>
				{groupId ? "Find a worker to add" : "Find a group"}
				<Input
					id={queryId}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setOffset(0);
					}}
				/>
			</label>
			{data?.choices.map((choice) => {
				const p = choice.principal;
				if (p.kind === "group")
					return (
						<Button key={p.id} variant="outline" onClick={() => select(p.id)}>
							{choice.name}
						</Button>
					);
				if (
					p.kind === "worker" &&
					groupId &&
					!selected?.members.some(
						(m) => m.appId === p.appId && m.personaId === p.id,
					)
				)
					return (
						<Button
							key={p.appId + p.id}
							variant="outline"
							disabled={busy}
							onClick={() =>
								save({
									kind: "membership",
									groupId,
									appId: p.appId,
									personaId: p.id,
									member: true,
								})
							}
						>
							Add {choice.name} · {choice.appName}
						</Button>
					);
				return null;
			})}
			{offset > 0 && (
				<Button
					variant="ghost"
					onClick={() => setOffset(Math.max(0, offset - 50))}
				>
					Previous results
				</Button>
			)}
			{data?.nextOffset != null && (
				<Button variant="ghost" onClick={() => setOffset(data.nextOffset ?? 0)}>
					More results
				</Button>
			)}
			{error && (
				<div role="alert">
					{error}{" "}
					<Button variant="ghost" onClick={() => setUpdated((x) => x + 1)}>
						Refresh groups
					</Button>
				</div>
			)}
		</div>
	);
}

function GroupSettings({
	group,
	busy,
	save,
}: {
	group?: NonNullable<ReadResult["selected"]>["group"];
	busy: boolean;
	save: (change: WorkerGroupEdit["change"]) => Promise<void>;
}) {
	const nameId = useId();
	const [name, setName] = useState(group?.name ?? "");
	const [shares, setShares] = useState(group?.sharesCases ?? false);
	const [metadata, setMetadata] = useState(
		Object.entries(group?.metadata ?? {}).map(([key, value]) => ({
			localId: key,
			key,
			value,
		})),
	);
	return (
		<fieldset className="space-y-2">
			<legend className="font-medium">
				{group ? "Group settings" : "New group"}
			</legend>
			<label htmlFor={nameId}>
				Name
				<Input
					id={nameId}
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</label>
			<label className="flex items-center gap-2">
				<input
					type="checkbox"
					checked={shares}
					onChange={(e) => setShares(e.target.checked)}
				/>
				Members share cases
			</label>
			{metadata.map((detail, i) => (
				<div className="flex gap-2" key={detail.localId}>
					<Input
						aria-label="Detail name"
						value={detail.key}
						onChange={(e) =>
							setMetadata((v) =>
								v.map((m, n) => (i === n ? { ...m, key: e.target.value } : m)),
							)
						}
					/>
					<Input
						aria-label="Detail value"
						value={detail.value}
						onChange={(e) =>
							setMetadata((v) =>
								v.map((m, n) =>
									i === n ? { ...m, value: e.target.value } : m,
								),
							)
						}
					/>
					<Button
						variant="ghost"
						onClick={() => setMetadata((v) => v.filter((_, n) => n !== i))}
					>
						Remove detail
					</Button>
				</div>
			))}
			<Button
				variant="ghost"
				onClick={() =>
					setMetadata([...metadata, { localId: uuidv4(), key: "", value: "" }])
				}
			>
				Add group detail
			</Button>
			<Button
				disabled={busy || !name.trim()}
				onClick={() =>
					save({
						...(group
							? { kind: "update" as const, groupId: group.id }
							: { kind: "create" as const }),
						name: name.trim(),
						sharesCases: shares,
						metadata: metadata.map(({ key, value }) => ({ key, value })),
					})
				}
			>
				Save group
			</Button>
		</fieldset>
	);
}
