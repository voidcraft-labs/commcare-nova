/**
 * DeviceHomeScreen: Android's home screen, as Preview running as Android
 * plays it.
 *
 * Android opens an app on its home screen, never inside a menu
 * (`activities/HomeButtons.java::buildButtonData`), and returns there after
 * a form whose after-submit destination is the app's home or a case list
 * with no forms. The buttons and their order come from
 * `lib/preview/deviceHome.ts`, the list App Tests' device home reads too.
 *
 * Start opens the module list, which is what `StandardHomeActivity::enterRootModule`
 * opens. Sync with server re-reads the worker's cases, as a submission's
 * announcement does, and records when it ran. Saved and Incomplete read the
 * current Preview device's records. Running as chooses the worker, so Log out
 * is disabled.
 *
 * Labels are runtime messages in the worker's language; reasons are Nova's
 * own words, in English. Rendered only in the running Preview, never in
 * edit mode.
 */
"use client";
import { useId, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { EditableTitle } from "@/components/builder/EditableTitle";
import {
	useBuilderLanguage,
	useLocalizedValues,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { makeTranslationUnitId } from "@/lib/domain";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import {
	type DeviceHomeButton,
	deviceHomeButtons,
} from "@/lib/preview/deviceHome";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
import {
	runtimeDateLocale,
	runtimeMessage,
} from "@/lib/preview/runtimeMessages";
import { useNavigate } from "@/lib/routing/hooks";
import {
	useAccessPhase,
	useAppId,
	useCanEdit,
	useMarkPreviewDeviceSynced,
	usePreviewDevice,
	usePreviewDeviceSyncedAt,
	usePreviewFormRecords,
	useSetPreviewAtDeviceHome,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";

/** A home-screen button: full width, one control height, on the preview
 *  palette like the running form's own actions. */
const HOME_BUTTON_CLS =
	"nova-focusable flex min-h-11 w-full touch-manipulation cursor-pointer items-center justify-center rounded-lg border border-pv-input-border bg-pv-surface px-4 py-2 text-sm font-medium text-nova-text transition-colors not-disabled:hover:border-pv-input-focus not-disabled:hover:text-pv-accent-bright disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)";

type FormList = "deviceHomeSaved" | "deviceHomeIncomplete";

export function DeviceHomeScreen() {
	const canonicalAppName = useAppName();
	const localizedValues = useLocalizedValues();
	// A phone shows `app.display.name`: the app name's own wording there, else its name.
	const appName =
		(localizedValues.get(generatedWordingId("app", "appDisplayName")) as
			| string
			| undefined) ??
		(localizedValues.get(makeTranslationUnitId("app", "name")) as
			| string
			| undefined) ??
		canonicalAppName;
	const { language } = useBuilderLanguage();
	const appSettings = useAppSettings();
	const buttons = deviceHomeButtons(appSettings, language);
	const [list, setList] = useState<FormList>();

	return (
		<ContentFrame width="5xl" className="p-6 space-y-4">
			<div className="flex items-center gap-2">
				<EditableTitle value={appName} readOnly ariaLabel="Application name" />
			</div>
			{list && buttons.some((button) => button.key === list) ? (
				<DeviceFormList list={list} onBack={() => setList(undefined)} />
			) : (
				<ul className="grid gap-3">
					{buttons.map((button) => (
						<li key={button.key}>
							<DeviceHomeAction button={button} showList={setList} />
						</li>
					))}
				</ul>
			)}
		</ContentFrame>
	);
}

function DeviceFormList({
	list,
	onBack,
}: {
	list: FormList;
	onBack: () => void;
}) {
	const records = usePreviewFormRecords();
	const session = useBuilderSessionApi();
	const navigate = useNavigate();
	const doc = useBlueprintDocApi();
	const device = usePreviewDevice();
	const { language } = useBuilderLanguage();
	const access = useAccessPhase();
	const canEdit = useCanEdit();
	const [notice, setNotice] = useState("");
	const incomplete = list === "deviceHomeIncomplete";
	const visible =
		access === "authorized"
			? records.filter(
					(record) => (record.kind === "incomplete") === incomplete,
				)
			: [];
	return (
		<section className="space-y-4" aria-label={runtimeMessage(language, list)}>
			<div className="flex items-center gap-3">
				<button
					type="button"
					className="nova-focusable text-sm text-pv-accent-bright"
					onClick={onBack}
				>
					{runtimeMessage(language, "back")}
				</button>
				<h2 className="font-display text-lg font-semibold">
					{runtimeMessage(language, list)}
				</h2>
			</div>
			{access !== "authorized" ? (
				<p role="status">Checking app access</p>
			) : visible.length === 0 ? (
				<p>{incomplete ? "No incomplete forms" : "No saved forms"}</p>
			) : (
				<ul className="grid gap-3">
					{visible.map((record) => {
						const details = (
							<>
								<span className="font-medium">
									{record.descriptor || record.name}
								</span>
								{record.descriptor && (
									<span className="text-sm text-nova-text-muted">
										{record.name}
									</span>
								)}
								<time
									className="text-xs text-nova-text-muted"
									dateTime={new Date(record.savedAt).toISOString()}
								>
									{new Intl.DateTimeFormat(runtimeDateLocale(language), {
										dateStyle: "medium",
										timeStyle: "short",
									}).format(new Date(record.savedAt))}
								</time>
							</>
						);
						const resume = () => {
							if (record.kind !== "incomplete") return;
							if (doc.getState() !== record.opened.documentState) {
								setNotice(
									"This app changed since the form was saved. You can start another form from the app's home screen.",
								);
								return;
							}
							if (
								record.target.opening &&
								record.device.appLanguage !== device.appLanguage
							) {
								setNotice(
									"This form was opened in another language. You can switch back to that language or start another form.",
								);
								return;
							}
							const opened = session
								.getState()
								.resumePreviewDraft(record.entryKey);
							if (opened) navigate.openForm(opened.moduleUuid, opened.formUuid);
						};
						return (
							<li
								key={record.entryKey}
								className="rounded-lg border border-pv-input-border bg-pv-surface p-3"
							>
								{record.kind === "incomplete" ? (
									<div className="flex items-center justify-between gap-3">
										<button
											type="button"
											disabled={!canEdit}
											className="nova-focusable flex flex-col text-left"
											onClick={resume}
										>
											{details}
										</button>
										<button
											type="button"
											className="nova-focusable text-sm text-nova-text-muted"
											onClick={() =>
												session
													.getState()
													.removePreviewFormRecord(record.entryKey)
											}
										>
											Remove
										</button>
									</div>
								) : (
									<div className="flex flex-col">{details}</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{notice && (
				<p role="status" className="text-sm text-nova-text-muted">
					{notice}
				</p>
			)}
		</section>
	);
}
function DeviceHomeAction({
	button,
	showList,
}: {
	readonly button: DeviceHomeButton;
	readonly showList: (list: FormList) => void;
}) {
	const reasonId = useId();
	const setAtDeviceHome = useSetPreviewAtDeviceHome();
	const appId = useAppId();
	const caseTypes = useMaterializableCaseTypes();
	const markSynced = useMarkPreviewDeviceSynced();
	const syncedAt = usePreviewDeviceSyncedAt();
	const { language } = useBuilderLanguage();

	if (!button.available) {
		return (
			<>
				<button
					type="button"
					disabled
					aria-describedby={reasonId}
					className={HOME_BUTTON_CLS}
				>
					{button.label}
				</button>
				<p id={reasonId} className="mt-1 px-1 text-xs text-nova-text-muted">
					{button.reason}
				</p>
			</>
		);
	}

	if (button.key === "deviceHomeSync") {
		const syncTime =
			syncedAt === undefined
				? undefined
				: new Intl.DateTimeFormat(runtimeDateLocale(language), {
						dateStyle: "medium",
						timeStyle: "short",
					}).format(new Date(syncedAt));
		return (
			<>
				<button
					type="button"
					aria-describedby={syncTime === undefined ? undefined : reasonId}
					onClick={() => {
						if (appId !== undefined)
							for (const caseType of caseTypes)
								invalidateCaseData(appId, caseType.name);
						markSynced(Date.now());
					}}
					className={HOME_BUTTON_CLS}
				>
					{button.label}
				</button>
				{syncTime !== undefined ? (
					<p
						id={reasonId}
						aria-live="polite"
						className="mt-1 px-1 text-xs text-nova-text-muted"
					>
						{runtimeMessage(language, "deviceHomeLastSync", {
							time: syncTime,
						})}
					</p>
				) : null}
			</>
		);
	}

	return (
		<button
			type="button"
			onClick={() => {
				if (
					button.key === "deviceHomeIncomplete" ||
					button.key === "deviceHomeSaved"
				)
					showList(button.key);
				else setAtDeviceHome(false);
			}}
			className={HOME_BUTTON_CLS}
		>
			{button.label}
		</button>
	);
}
