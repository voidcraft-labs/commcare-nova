"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import { LabeledSelect } from "@/components/shadcn/labeled-select";
import { BUILT_IN_ANDROID_APP_ACTIONS } from "@/lib/domain/fields/androidApp";
import {
	type AndroidAppMatch,
	type AndroidAppResultValue,
	type AndroidAppReturn,
	IDENTITY_TEMPLATE_NAMES,
	SIMPRINTS_TEMPLATE_NAMES,
} from "@/lib/preview/engine/androidAppReturn";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import {
	useAccessPhase,
	useCanEdit,
	usePreviewPlatform,
} from "@/lib/session/hooks";
import { applyAndroidAppResult } from "./attachment/androidAppResult";

type Protocol =
	| "ordinary"
	| "registration"
	| "verification"
	| "identification"
	| "simprintsRegistration";

export function AndroidAppField({
	path,
	appId,
	entryKey,
	value,
	label,
}: {
	path: string;
	appId: string;
	entryKey: string;
	value: string;
	label: string;
}) {
	const inputId = useId();
	const controller = useEngineController();
	const platform = usePreviewPlatform();
	const editing = useCanEdit();
	const access = useAccessPhase();
	const maySetCapture = editing && access === "authorized";
	const [launch, setLaunch] =
		useState<Awaited<ReturnType<typeof controller.openAndroidApp>>>();
	const [primary, setPrimary] = useState<string | undefined>();
	const [named, setNamed] = useState(new Map<string, AndroidAppResultValue>());
	const [bundled, setBundled] = useState(false);
	const [protocol, setProtocol] = useState<Protocol>("ordinary");
	const [guid, setGuid] = useState("");
	const [confidence, setConfidence] = useState("0");
	const [strength, setStrength] =
		useState<AndroidAppMatch["strength"]>("one_star");
	const [templates, setTemplates] = useState(new Map<string, File>());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const operation = useRef<AbortController | null>(null);
	useEffect(() => () => operation.current?.abort(), []);
	const close = () => {
		operation.current?.abort();
		operation.current = null;
		setLaunch(undefined);
		setError("");
		setBusy(false);
	};
	const open = async () => {
		if (operation.current) return;
		const op = new AbortController();
		operation.current = op;
		setBusy(true);
		setError("");
		setBundled(false);
		setProtocol("ordinary");
		setPrimary(undefined);
		setNamed(new Map());
		setTemplates(new Map());
		setGuid("");
		setStrength("one_star");
		setConfidence("0");
		try {
			const opened = await controller.openAndroidApp(entryKey, path, op.signal);
			if (op.signal.aborted) return;
			if (opened) setLaunch(opened);
			else setError("This question changed. Open the Android app again.");
		} catch (problem) {
			if (op.signal.aborted) return;
			setError(
				problem instanceof Error
					? problem.message
					: "The values for this app could not be read.",
			);
		} finally {
			if (operation.current === op) {
				operation.current = null;
				if (!op.signal.aborted) setBusy(false);
			}
		}
	};
	const change = (key: string, result: AndroidAppResultValue | undefined) =>
		setNamed((values) => {
			const next = new Map(values);
			if (result) next.set(key, result);
			else next.delete(key);
			return next;
		});
	const returnToForm = async () => {
		if (!launch || operation.current) return;
		const op = new AbortController();
		operation.current = op;
		setBusy(true);
		setError("");
		try {
			let result: AndroidAppReturn;
			if (protocol === "ordinary")
				result = {
					...(primary === undefined ? {} : { primary }),
					...(bundled ? { bundle: named } : { extras: named }),
				};
			else if (protocol === "verification" || protocol === "identification") {
				const number = Number(confidence);
				if (
					!Number.isInteger(number) ||
					number < -2147483648 ||
					number > 2147483647
				)
					throw new Error("Confidence needs a whole number.");
				const match = { guid, confidence: number, strength };
				result =
					protocol === "verification"
						? { verification: match }
						: { identification: guid ? [match] : [] };
			} else {
				// The native identity parcel carries these byte arrays inline. Its
				// Android Binder buffer is at most 1 MiB, shared with concurrent calls.
				const bytes = [...templates.values()].reduce(
					(total, file) => total + file.size,
					0,
				);
				if (bytes >= 1024 * 1024)
					throw new Error(
						"These sample templates are too large for one Android result. You can choose smaller files.",
					);
				const supplied = new Map<string, Uint8Array>();
				for (const [key, file] of templates) {
					if (op.signal.aborted) return;
					supplied.set(key, new Uint8Array(await file.arrayBuffer()));
				}
				result = { [protocol]: { guid: guid || null, templates: supplied } };
			}
			const applied = await applyAndroidAppResult(
				controller,
				appId,
				entryKey,
				path,
				launch.signature,
				result,
				platform,
				op.signal,
			);
			if (op.signal.aborted) return;
			if (applied) close();
			else
				setError(
					"This question changed. Close the result and open the app again.",
				);
		} catch (problem) {
			if (!op.signal.aborted)
				setError(
					problem instanceof Error
						? problem.message
						: "The form could not use this result.",
				);
		} finally {
			if (operation.current === op) {
				operation.current = null;
				setBusy(false);
			}
		}
	};
	const keys = [...new Set(launch?.destinations.map((item) => item.name))];
	return (
		<div className="space-y-2">
			{value && <p>{value}</p>}
			<Button type="button" variant="outline" disabled={busy} onClick={open}>
				Open Android app
			</Button>
			{error && !launch && <p role="alert">{error}</p>}
			<Dialog
				open={launch !== undefined}
				onOpenChange={(visible) => {
					if (!visible) close();
				}}
			>
				<DialogContent className="max-h-[85vh] overflow-y-auto">
					<DialogTitle>Return to {label}</DialogTitle>
					{launch && (
						<>
							<p className="text-sm">
								On Android, this question opens{" "}
								<strong>
									{BUILT_IN_ANDROID_APP_ACTIONS.get(launch.action.action) ??
										launch.action.action}
								</strong>
								. In Preview, you can enter what the app returns.
							</p>
							{launch.parameters.size > 0 && (
								<dl className="grid grid-cols-2 gap-1">
									{[...launch.parameters].map(([name, val]) => (
										<div key={name} className="contents">
											<dt>{name}</dt>
											<dd>{String(val)}</dd>
										</div>
									))}
								</dl>
							)}
							<LabeledSelect<Protocol>
								label="Result type"
								value={protocol}
								select={(next) => {
									setTemplates(new Map());
									setProtocol(next);
									setError("");
								}}
								choices={[
									{ value: "ordinary", label: "App answer" },
									{ value: "registration", label: "Identity registration" },
									{ value: "verification", label: "Identity verification" },
									{ value: "identification", label: "Identity search" },
									{
										value: "simprintsRegistration",
										label: "Simprints registration",
									},
								]}
							/>
							{protocol === "ordinary" ? (
								<>
									<label
										className="flex items-center gap-2"
										htmlFor={`${inputId}-primary`}
									>
										<Checkbox
											id={`${inputId}-primary`}
											checked={primary !== undefined}
											onCheckedChange={(checked) =>
												setPrimary(checked ? "" : undefined)
											}
										/>
										Return an answer to {label}
									</label>
									{primary !== undefined && (
										<Input
											aria-label={label}
											value={primary}
											onChange={(event) => setPrimary(event.target.value)}
										/>
									)}
									{keys.length > 0 && (
										<label
											className="flex items-center gap-2"
											htmlFor={`${inputId}-bundle`}
										>
											<Checkbox
												id={`${inputId}-bundle`}
												checked={bundled}
												onCheckedChange={(checked) => setBundled(checked)}
											/>
											Return named results in a bundle
										</label>
									)}
									{keys
										.filter((key) => bundled || key !== "odk_intent_data")
										.map((key, index) => {
											const item = named.get(key);
											const destinations = launch.destinations.filter(
												(dest) => dest.name === key,
											);
											const permissionNeeded =
												!maySetCapture &&
												destinations.some((dest) => dest.capture);
											return (
												<fieldset key={key} className="space-y-1">
													<label
														className="flex items-center gap-2"
														htmlFor={`${inputId}-named-${index}`}
													>
														<Checkbox
															id={`${inputId}-named-${index}`}
															checked={item !== undefined}
															disabled={permissionNeeded}
															onCheckedChange={(checked) =>
																change(key, checked ? { value: "" } : undefined)
															}
														/>
														Return {key}
													</label>
													<p className="text-xs text-muted-foreground">
														{permissionNeeded
															? "An editor can return a file to this question."
															: destinations
																	.map((dest) => dest.label)
																	.join(", ")}
													</p>
													{item &&
														destinations.some((dest) => !dest.capture) && (
															<Input
																aria-label={key}
																value={item.value ?? ""}
																onChange={(event) =>
																	change(key, {
																		...item,
																		value: event.target.value,
																	})
																}
															/>
														)}
													{item &&
														destinations.some((dest) => dest.capture) && (
															<Input
																aria-label={`File for ${key}`}
																type="file"
																onChange={(event) => {
																	const file = event.target.files?.[0];
																	change(
																		key,
																		file
																			? { value: item.value || file.name, file }
																			: { value: item.value },
																	);
																}}
															/>
														)}
												</fieldset>
											);
										})}
								</>
							) : (
								<>
									<label htmlFor={`${inputId}-identity`}>
										Identity ID
										<Input
											id={`${inputId}-identity`}
											value={guid}
											onChange={(event) => setGuid(event.target.value)}
										/>
									</label>
									{protocol === "identification" ||
									protocol === "verification" ? (
										<>
											<label htmlFor={`${inputId}-confidence`}>
												Confidence
												<Input
													id={`${inputId}-confidence`}
													type="number"
													value={confidence}
													onChange={(event) =>
														setConfidence(event.target.value)
													}
												/>
											</label>
											<LabeledSelect<AndroidAppMatch["strength"]>
												label="Match strength"
												value={strength}
												select={setStrength}
												choices={(
													[
														"one_star",
														"two_stars",
														"three_stars",
														"four_stars",
														"five_stars",
													] as const
												).map((value, i) => ({
													value,
													label: "★".repeat(i + 1),
												}))}
											/>
										</>
									) : (
										(protocol === "registration"
											? IDENTITY_TEMPLATE_NAMES
											: SIMPRINTS_TEMPLATE_NAMES
										).map((key) => (
											<label key={key} htmlFor={`${inputId}-${key}`}>
												Sample template for{" "}
												{key
													.toLowerCase()
													.replace(/_template$/, "")
													.replaceAll("_", " ")}
												<Input
													id={`${inputId}-${key}`}
													type="file"
													onChange={(event) => {
														const file = event.target.files?.[0];
														setTemplates((current) => {
															const next = new Map(current);
															if (file) next.set(key, file);
															else next.delete(key);
															return next;
														});
													}}
												/>
											</label>
										))
									)}
								</>
							)}
							{error && <p role="alert">{error}</p>}
							<div className="flex justify-end gap-2">
								<Button type="button" variant="outline" onClick={close}>
									Cancel
								</Button>
								<Button type="button" disabled={busy} onClick={returnToForm}>
									Return to form
								</Button>
							</div>
						</>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
