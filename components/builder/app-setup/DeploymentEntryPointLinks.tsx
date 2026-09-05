"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import { Textarea } from "@/components/shadcn/textarea";
import { useReconcilerContext } from "@/lib/collab/context";
import type { DeploymentView } from "@/lib/deployment/actions";
import { getEntryPointLinkAction } from "@/lib/deployment/actions";
import { useEntryPoints } from "@/lib/doc/hooks/useEntryPoints";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";

export function DeploymentEntryPointLinks({
	appId,
	view,
}: {
	appId: string;
	view: DeploymentView;
}) {
	const { entries, isCurrent } = useEntryPoints();
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const reconciler = useReconcilerContext()?.reconciler;
	const prefix = useId();
	const [selected, setSelected] = useState<string>("");
	const [values, setValues] = useState<Record<string, string>>({});
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [result, setResult] = useState<{ url: string; checkedAt: string }>();
	const [copied, setCopied] = useState(false);
	const generation = useRef(0);
	const entry = entries.find((item) => item.entryPoint?.uuid === selected);
	const sourceKey = JSON.stringify([appId, view.deployment, entry]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: document, destination and target changes revoke results and in-flight requests.
	useEffect(() => {
		generation.current += 1;
		setResult(undefined);
		setPending(false);
		setCopied(false);
		return () => {
			generation.current += 1;
		};
	}, [sourceKey, isCurrent, canEdit, reconciler]);
	const check = async (copy = false) => {
		if (!entry?.entryPoint || !canEdit) return;
		const sequence = ++generation.current;
		setPending(true);
		setFailure(undefined);
		setResult(undefined);
		setCopied(false);
		try {
			if (!reconciler) {
				setFailure("Wait for the app to finish loading and try again.");
				return;
			}
			const saved = await reconciler.waitForHumanSaveBarrier();
			if (sequence !== generation.current || !isCurrent()) return;
			if (saved.kind !== "saved") {
				setFailure("Wait for the app to finish saving and try again.");
				return;
			}
			const response = await getEntryPointLinkAction({
				appId,
				server: view.deployment.deployment.server,
				domain: view.deployment.deployment.domain,
				entryPointUuid: entry.entryPoint.uuid,
				selections: entry.requiredSelections.map((selection) => ({
					moduleUuid: selection.moduleUuid,
					caseIds: (values[selection.moduleUuid] ?? "")
						.split("\n")
						.map((value) => value.trim())
						.filter(Boolean),
				})),
			});
			if (sequence !== generation.current || !isCurrent()) return;
			if (response.success) {
				setResult(response.data);
				if (copy) {
					try {
						await navigator.clipboard.writeText(response.data.url);
						if (sequence === generation.current && isCurrent()) setCopied(true);
					} catch {
						if (sequence === generation.current && isCurrent())
							setFailure(
								"Nova couldn't copy the link. You can select and copy it from the field above.",
							);
					}
				}
			} else setFailure(response.message);
		} catch {
			if (sequence === generation.current)
				setFailure(
					"Nova couldn't check this released app. Try again in a moment.",
				);
		} finally {
			if (sequence === generation.current) setPending(false);
		}
	};
	return (
		<section
			aria-labelledby={`${prefix}-heading`}
			className="mt-4 border-t border-nova-border pt-4 space-y-3"
		>
			<h3 id={`${prefix}-heading`} className="font-medium text-nova-text">
				Deep links
			</h3>
			<p className="text-sm text-nova-text-secondary">
				Nova checks the released build before generating or copying a link.
				CommCare HQ controls which build each signed-in worker opens.
			</p>
			{entries.length === 0 ? (
				<Button
					variant="ghost-action"
					onClick={() => navigate.openAppSetup("deep-links")}
				>
					Set up deep links
				</Button>
			) : (
				<>
					<fieldset
						className="flex flex-wrap gap-2"
						aria-label="Choose a deep link"
					>
						{entries.map((item) => (
							<Button
								key={item.entryPoint?.uuid}
								variant={
									selected === item.entryPoint?.uuid ? "secondary" : "outline"
								}
								aria-pressed={selected === item.entryPoint?.uuid}
								onClick={() => {
									generation.current += 1;
									setSelected(item.entryPoint?.uuid ?? "");
									setValues({});
									setResult(undefined);
									setFailure(undefined);
								}}
							>
								{item.label}
							</Button>
						))}
					</fieldset>
					{entry && (
						<>
							{entry.requiredSelections.length > 0 && (
								<p className="text-sm text-nova-text-secondary">
									Use case IDs from this CommCare HQ project space. Preview
									cases are separate and aren't substituted here.
								</p>
							)}
							{entry.requiredSelections.map((selection) => (
								<div key={selection.moduleUuid} className="space-y-2">
									<Label htmlFor={`${prefix}-${selection.moduleUuid}`}>
										{selection.caseType} case{" "}
										{selection.cardinality === "one" ? "ID" : "IDs"}
									</Label>
									{selection.cardinality === "one" ? (
										<Input
											id={`${prefix}-${selection.moduleUuid}`}
											value={values[selection.moduleUuid] ?? ""}
											disabled={!canEdit || pending}
											onChange={(event) => {
												setValues({
													...values,
													[selection.moduleUuid]: event.target.value,
												});
												setResult(undefined);
												setCopied(false);
											}}
										/>
									) : (
										<Textarea
											id={`${prefix}-${selection.moduleUuid}`}
											value={values[selection.moduleUuid] ?? ""}
											disabled={!canEdit || pending}
											rows={4}
											aria-describedby={`${prefix}-${selection.moduleUuid}-help`}
											onChange={(event) => {
												setValues({
													...values,
													[selection.moduleUuid]: event.target.value,
												});
												setResult(undefined);
												setCopied(false);
											}}
										/>
									)}
									{selection.cardinality === "multiple" && (
										<p
											id={`${prefix}-${selection.moduleUuid}-help`}
											className="text-sm text-nova-text-secondary"
										>
											One case ID per line, in selection order, up to{" "}
											{selection.maximum}
										</p>
									)}
								</div>
							))}
							{canEdit ? (
								<Button
									variant="outline"
									disabled={
										pending ||
										Boolean(entry.issue) ||
										entry.requiredSelections.some(
											(selection) =>
												!(values[selection.moduleUuid] ?? "").trim(),
										)
									}
									onClick={() => void check()}
								>
									{pending ? "Checking released build" : "Generate HQ link"}
								</Button>
							) : (
								<p className="text-sm text-nova-text-secondary">
									A Project editor can check the released build and generate a
									link
								</p>
							)}
						</>
					)}
				</>
			)}
			{failure && (
				<p role="alert" className="text-sm text-nova-red">
					{failure}
				</p>
			)}
			{result && (
				<div className="space-y-2">
					<p role="status" className="text-sm text-nova-text-secondary">
						Released build checked {new Date(result.checkedAt).toLocaleString()}
					</p>
					<Input
						aria-label="CommCare HQ deep link"
						value={result.url}
						readOnly
					/>
					<Button
						variant="secondary"
						disabled={pending || !canEdit}
						onClick={() => void check(true)}
					>
						{copied ? "Copied" : "Copy HQ link"}
					</Button>
				</div>
			)}
		</section>
	);
}
