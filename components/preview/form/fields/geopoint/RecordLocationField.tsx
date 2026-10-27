// components/preview/form/fields/geopoint/RecordLocationField.tsx
//
// The location question as CommCare Android draws it, shown in the running
// preview when it runs as Android (`lib/preview/platform.ts`,
// `locationQuestion`). Nova writes no `appearance="maps"`, so Android draws
// no map: one button, Record location (Replace location once answered),
// that opens a dialog finding the device's position
// (`views/widgets/GeoPointWidget.java`, `activities/GeoPointActivity.java`).
//
// The dialog watches the browser's position in place of the phone's GPS and
// shows its accuracy as it improves. A fix at 5 metres or better is taken at
// once (`GeoUtils.DEFAULT_GOOD_ACCURACY`). Once a fix is better than 1,600
// metres (`DEFAULT_ACCEPTABLE_ACCURACY`), or a minute has passed with any
// fix, the dialog offers Record location, which takes the latest fix: these
// are Android's acceptable accuracy and timeout defaults, which Nova's
// profile leaves in force. Cancel closes it with Android's toast. A browser
// that refuses its location keeps the dialog open with a line saying so,
// which is what a phone without a fix shows until its timeout.
//
// A Project scope reset closes the dialog and stops its watch, so a fix the
// browser delivers afterwards writes nothing into the new scope's form.
//
// The answer is `lat lon alt acc` in the one spelling Preview stores
// (`formatGeopoint`: altitude and accuracy floored to two decimals, altitude
// 0 when the browser gives none), and an answered question shows Android's
// four lines (`GeoPointWidget.java::setBinaryData`).

"use client";
import { useEffect, useRef, useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { useReconcilerContext } from "@/lib/collab/context";
import {
	androidCoordinateText,
	androidMetersText,
	formatGeopoint,
	parseGeopoint,
} from "@/lib/preview/engine/geopointValue";
import type { FieldState } from "@/lib/preview/engine/types";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { showToast } from "@/lib/ui/toastStore";
import { FORM_PRIMARY_ACTION_CLS } from "../../../screens/formActionButtonStyles";
import { ValidationError } from "../ValidationError";
import { type GeolocationFix, watchGeolocation } from "./geolocation";

/** A fix this good is taken at once (`GeoUtils.DEFAULT_GOOD_ACCURACY`). */
const GOOD_ACCURACY_METERS = 5;
/** A fix better than this can be recorded (`DEFAULT_ACCEPTABLE_ACCURACY`). */
const ACCEPTABLE_ACCURACY_METERS = 1600;
/** After this long, any fix can be recorded (Android's location timeout). */
const ACCEPT_ANY_FIX_AFTER_MS = 60_000;

interface RecordLocationFieldProps {
	readonly state: FieldState;
	/** Visible question label rendered by InteractiveFormRenderer. */
	readonly labelledBy?: string;
	readonly onChange: (value: string) => void;
	readonly onBlur: () => void;
}

export function RecordLocationField({
	state,
	labelledBy,
	onChange,
	onBlur,
}: RecordLocationFieldProps) {
	const { language } = useBuilderLanguage();
	const [open, setOpen] = useState(false);
	const reconciler = useReconcilerContext();
	useEffect(
		() => reconciler?.subscribeProjectScopeReset(() => setOpen(false)),
		[reconciler],
	);
	const point = parseGeopoint(state.value);
	const showError = state.touched && !state.valid;

	const record = (fix: GeolocationFix) => {
		onChange(
			formatGeopoint({
				lat: fix.latitude,
				lon: fix.longitude,
				alt: fix.altitude ?? 0,
				accuracy: fix.accuracy,
			}),
		);
		onBlur();
		setOpen(false);
	};

	return (
		<fieldset
			aria-labelledby={labelledBy}
			className="m-0 min-w-0 space-y-2 border-none p-0"
		>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className={FORM_PRIMARY_ACTION_CLS}
			>
				{runtimeMessage(
					language,
					point === null ? "recordLocation" : "replaceLocation",
				)}
			</button>
			{point !== null ? (
				<p className="whitespace-pre-line rounded-lg bg-pv-surface px-3 py-2 font-mono text-xs text-nova-text-secondary">
					{[
						runtimeMessage(language, "latitudeLine", {
							dms: androidCoordinateText(point.lat, "lat"),
						}),
						runtimeMessage(language, "longitudeLine", {
							dms: androidCoordinateText(point.lon, "lon"),
						}),
						runtimeMessage(language, "altitudeLine", {
							m: androidMetersText(point.alt),
						}),
						runtimeMessage(language, "accuracyLine", {
							m: androidMetersText(point.accuracy),
						}),
					].join("\n")}
				</p>
			) : null}
			{showError && state.errorMessage && (
				<ValidationError message={state.errorMessage} />
			)}
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (next) return;
					setOpen(false);
					showToast(
						"info",
						runtimeMessage(language, "locationCaptureCancelled"),
					);
				}}
			>
				{open ? (
					<FindingLocation
						onRecord={record}
						onCancel={() => {
							setOpen(false);
							showToast(
								"info",
								runtimeMessage(language, "locationCaptureCancelled"),
							);
						}}
					/>
				) : null}
			</Dialog>
		</fieldset>
	);
}

/** The dialog's body while it is open: it owns the position watch and the
 *  one-minute timer, both stopped when it closes. */
function FindingLocation({
	onRecord,
	onCancel,
}: {
	readonly onRecord: (fix: GeolocationFix) => void;
	readonly onCancel: () => void;
}) {
	const { language } = useBuilderLanguage();
	const [fix, setFix] = useState<GeolocationFix | undefined>(undefined);
	const [refused, setRefused] = useState(false);
	const [waitedLongEnough, setWaitedLongEnough] = useState(false);
	const onRecordRef = useRef(onRecord);
	useEffect(() => {
		onRecordRef.current = onRecord;
	}, [onRecord]);

	useEffect(() => {
		let taken = false;
		const stop = watchGeolocation({
			onFix: (next) => {
				if (taken) return;
				setRefused(false);
				setFix(next);
				if (next.accuracy <= GOOD_ACCURACY_METERS) {
					taken = true;
					stop();
					onRecordRef.current(next);
				}
			},
			onFailure: (reason) => {
				if (reason === "permission-denied" || reason === "unsupported")
					setRefused(true);
			},
		});
		const timer = setTimeout(
			() => setWaitedLongEnough(true),
			ACCEPT_ANY_FIX_AFTER_MS,
		);
		return () => {
			taken = true;
			stop();
			clearTimeout(timer);
		};
	}, []);

	const canRecord =
		fix !== undefined &&
		(fix.accuracy < ACCEPTABLE_ACCURACY_METERS || waitedLongEnough);

	return (
		<DialogContent showCloseButton={false}>
			<DialogHeader>
				<DialogTitle>{runtimeMessage(language, "findingLocation")}</DialogTitle>
				<DialogDescription aria-live="polite">
					{refused
						? "Your browser isn't sharing its location"
						: fix !== undefined && Number.isFinite(fix.accuracy)
							? runtimeMessage(language, "locationAccuracy", {
									meters: androidMetersText(fix.accuracy),
								})
							: null}
				</DialogDescription>
			</DialogHeader>
			<DialogFooter>
				<button
					type="button"
					onClick={onCancel}
					className="nova-focusable inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium text-nova-text-secondary transition-colors hover:bg-white/5 hover:text-nova-text"
				>
					{runtimeMessage(language, "cancelLocation")}
				</button>
				{canRecord && fix !== undefined ? (
					<button
						type="button"
						onClick={() => onRecord(fix)}
						className={FORM_PRIMARY_ACTION_CLS}
					>
						{runtimeMessage(language, "recordLocation")}
					</button>
				) : null}
			</DialogFooter>
		</DialogContent>
	);
}
