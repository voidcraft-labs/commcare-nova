"use client";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import type { Uuid } from "@/lib/domain/uuid";
import { readWorkerGroupsAction } from "@/lib/lookup/actions";
import type {
	TargetGroupRead,
	WorkerGroupEdit,
} from "@/lib/lookup/assignmentVocabulary";

type Directory = Extract<
	Awaited<ReturnType<typeof readWorkerGroupsAction>>,
	{ success: true }
>["value"];
export function GroupConnection({
	projectId,
	group,
	busy,
	save,
}: {
	projectId: string;
	group: { id: Uuid; name: string };
	busy: boolean;
	save: (change: WorkerGroupEdit["change"]) => Promise<void>;
}) {
	const groupNameId = useId();
	const exactId = useId();
	const [identifier, setIdentifier] = useState("");
	const [open, setOpen] = useState(false),
		[domain, setDomain] = useState(""),
		[name, setName] = useState(group.name);
	const [spaces, setSpaces] = useState<readonly string[]>([]),
		[request, setRequest] = useState<TargetGroupRead>(),
		[target, setTarget] = useState<Directory["target"]>(),
		[error, setError] = useState("");
	useEffect(() => {
		if (!open || !request) return;
		let current = true;
		async function read() {
			try {
				const r = await readWorkerGroupsAction(projectId, {
					search: { kind: "group", query: group.name },
					target: request,
				});
				if (!current) return;
				if (!r.success) {
					setError(r.message);
					return;
				}
				const result = r.value.target;
				if (result?.kind === "spaces") setSpaces(result.domains);
				setTarget(result);
			} catch {
				if (current)
					setError(
						"Nova couldn't read this connection. You can review it again.",
					);
			}
		}
		void read();
		return () => {
			current = false;
		};
	}, [request, open, projectId, group.name]);
	function review(r: TargetGroupRead) {
		setTarget(undefined);
		setError("");
		setRequest(r);
	}
	return (
		<section className="space-y-2">
			<Button
				variant="outline"
				aria-expanded={open}
				onClick={() => {
					setOpen(!open);
					if (!open) review({ kind: "spaces" });
				}}
			>
				Connect a project space
			</Button>
			{open && (
				<>
					<label>
						Project space
						<select
							className="block"
							value={domain}
							onChange={(e) => {
								setDomain(e.target.value);
								setRequest(undefined);
								setTarget(undefined);
							}}
						>
							<option value="">Choose a project space</option>
							{spaces.map((d) => (
								<option key={d}>{d}</option>
							))}
						</select>
					</label>
					{target?.kind === "spaces" && !spaces.length && (
						<p>You can connect a project space in Settings.</p>
					)}
					{domain && (
						<>
							<label htmlFor={groupNameId}>
								Group name in the project space
								<Input
									id={groupNameId}
									value={name}
									onChange={(e) => {
										setName(e.target.value);
										setTarget(undefined);
										setRequest(undefined);
									}}
								/>
							</label>
							<Button
								variant="outline"
								disabled={!name.trim() || busy}
								onClick={() =>
									review({
										kind: "find",
										domain,
										groupId: group.id,
										name: name.trim(),
									})
								}
							>
								Find matching groups
							</Button>
							<details>
								<summary>Choose by identifier</summary>
								<label htmlFor={exactId}>Group identifier</label>
								<Input
									id={exactId}
									value={identifier}
									onChange={(e) => {
										setIdentifier(e.target.value);
										setTarget(undefined);
										setRequest(undefined);
									}}
								/>
								<Button
									variant="outline"
									disabled={busy || !identifier.trim()}
									onClick={() =>
										review({
											kind: "review",
											groupId: group.id,
											domain,
											remoteId: identifier.trim(),
										})
									}
								>
									Review group
								</Button>
							</details>
						</>
					)}
					{target?.kind === "choices" &&
						(target.choices.length ? (
							target.choices.map((choice) => (
								<Button
									key={choice.id}
									variant="outline"
									onClick={() =>
										review({
											kind: "review",
											domain,
											groupId: group.id,
											remoteId: choice.id,
										})
									}
								>
									Review {choice.name}
									{target.choices.length > 1 ? ` · ${choice.id}` : ""}
								</Button>
							))
						) : (
							<p>No groups match this name in {domain}.</p>
						))}
					{target?.kind === "review" && (
						<>
							<p>
								{target.name} in {domain} has {target.memberCount}{" "}
								{target.memberCount === 1 ? "worker" : "workers"}.{" "}
								{target.matches
									? "The connected workers and case-sharing setting match."
									: "The workers or case-sharing setting differ. You can check the group and its worker connections, then review again."}
							</p>
							<Button
								variant="outline"
								disabled={busy || !target.matches}
								onClick={() =>
									save({
										kind: "connect",
										groupId: group.id,
										domain,
										remoteId: target.remoteId,
										witness: target.witness,
									})
								}
							>
								Connect this group
							</Button>
						</>
					)}
					{error && <p role="alert">{error}</p>}
				</>
			)}
		</section>
	);
}
