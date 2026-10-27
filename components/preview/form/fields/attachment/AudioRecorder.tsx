/**
 * AudioRecorder: Android's sound recorder, in the page.
 *
 * Running as Android, an audio question offers Record sound and no picker:
 * Android shows "Choose sound" only for `appearance="acquire-or-upload"`,
 * which Nova never writes (`views/widgets/CommCareAudioWidget.java`). Preview
 * records through the browser's microphone in its place: Start recording
 * asks for the microphone (`getUserMedia({ audio: true })`) and records with
 * `MediaRecorder`; Stop recording ends it, plays it back, and hands the
 * recording to the question as a file, which attaches as any capture does.
 * A browser with no microphone, or one that refuses it, shows a line saying
 * so, and the recorder stops its tracks whenever it closes or unmounts.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerMicrophone from "@iconify-icons/tabler/microphone";
import tablerPlayerStop from "@iconify-icons/tabler/player-stop";
import { useEffect, useRef, useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";

type RecorderState =
	| { readonly kind: "idle" }
	| { readonly kind: "requesting" }
	| { readonly kind: "recording" }
	| { readonly kind: "unavailable" };

/** The file a recording attaches as: the recorder's own type, and the
 *  matching extension where it names one. */
function recordingFile(blob: Blob): File {
	const type = blob.type.split(";")[0] ?? "";
	const subtype = type.split("/")[1] ?? "";
	const extension = /^[a-z0-9]{1,10}$/.test(subtype) ? subtype : "m4a";
	return new File([blob], `recording.${extension}`, {
		type: type === "" ? "audio/mp4" : type,
	});
}

function stopTracks(stream: MediaStream | undefined): void {
	for (const track of stream?.getTracks() ?? []) track.stop();
}

export function AudioRecorder({
	disabled,
	labelledBy,
	onRecorded,
}: {
	readonly disabled: boolean;
	/** The question's label, which names the recorder's buttons. */
	readonly labelledBy?: string;
	readonly onRecorded: (file: File) => void;
}) {
	const { language } = useBuilderLanguage();
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<RecorderState>({ kind: "idle" });
	const [playbackUrl, setPlaybackUrl] = useState<string | undefined>();
	const recorderRef = useRef<MediaRecorder | undefined>(undefined);
	const streamRef = useRef<MediaStream | undefined>(undefined);
	/** Counts microphone requests; a grant that resolves after a newer
	 *  request, or after unmount, is stale and its tracks stop at once. */
	const requestRef = useRef(0);
	const onRecordedRef = useRef(onRecorded);
	useEffect(() => {
		onRecordedRef.current = onRecorded;
	}, [onRecorded]);

	useEffect(
		() => () => {
			requestRef.current += 1;
			recorderRef.current = undefined;
			stopTracks(streamRef.current);
			streamRef.current = undefined;
		},
		[],
	);
	useEffect(() => {
		if (playbackUrl === undefined) return;
		return () => URL.revokeObjectURL(playbackUrl);
	}, [playbackUrl]);

	const start = async () => {
		const mediaDevices =
			typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
		if (
			typeof mediaDevices?.getUserMedia !== "function" ||
			typeof MediaRecorder === "undefined"
		) {
			setState({ kind: "unavailable" });
			return;
		}
		if (recorderRef.current !== undefined) return;
		const request = ++requestRef.current;
		setState({ kind: "requesting" });
		let stream: MediaStream;
		try {
			stream = await mediaDevices.getUserMedia({ audio: true });
		} catch {
			if (request === requestRef.current) setState({ kind: "unavailable" });
			return;
		}
		if (request !== requestRef.current) {
			stopTracks(stream);
			return;
		}
		try {
			streamRef.current = stream;
			const recorder = new MediaRecorder(stream);
			const chunks: Blob[] = [];
			recorder.addEventListener("dataavailable", (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			});
			recorder.addEventListener("stop", () => {
				stopTracks(stream);
				if (streamRef.current === stream) streamRef.current = undefined;
				if (recorderRef.current !== recorder) return;
				recorderRef.current = undefined;
				const blob = new Blob(chunks, {
					type: recorder.mimeType || chunks[0]?.type || "",
				});
				setPlaybackUrl(URL.createObjectURL(blob));
				setState({ kind: "idle" });
				onRecordedRef.current(recordingFile(blob));
			});
			recorderRef.current = recorder;
			recorder.start();
			setState({ kind: "recording" });
		} catch {
			stopTracks(streamRef.current);
			streamRef.current = undefined;
			setState({ kind: "unavailable" });
		}
	};

	const stop = () => {
		const recorder = recorderRef.current;
		if (recorder !== undefined && recorder.state !== "inactive")
			recorder.stop();
	};

	const buttonCls =
		"nova-focusable inline-flex min-h-11 touch-manipulation items-center gap-2 rounded-md border border-pv-input-border bg-pv-surface px-4 text-sm font-medium text-nova-text transition-colors not-disabled:hover:border-pv-input-focus disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)";

	if (!open)
		return (
			<button
				type="button"
				disabled={disabled}
				onClick={() => setOpen(true)}
				aria-describedby={labelledBy}
				className={buttonCls}
			>
				<Icon
					icon={tablerMicrophone}
					width="16"
					height="16"
					aria-hidden="true"
				/>
				{runtimeMessage(language, "recordSound")}
			</button>
		);

	return (
		<div className="space-y-2">
			{state.kind === "recording" ? (
				<button
					type="button"
					onClick={stop}
					aria-describedby={labelledBy}
					className={buttonCls}
				>
					<Icon
						icon={tablerPlayerStop}
						width="16"
						height="16"
						aria-hidden="true"
						className="text-nova-rose"
					/>
					{runtimeMessage(language, "stopRecording")}
				</button>
			) : (
				<button
					type="button"
					disabled={disabled || state.kind === "requesting"}
					onClick={() => void start()}
					aria-describedby={labelledBy}
					className={buttonCls}
				>
					<Icon
						icon={tablerMicrophone}
						width="16"
						height="16"
						aria-hidden="true"
					/>
					{runtimeMessage(language, "startRecording")}
				</button>
			)}
			{playbackUrl !== undefined && state.kind !== "recording" ? (
				// biome-ignore lint/a11y/useMediaCaption: a worker's own recording has no captions to offer
				<audio controls src={playbackUrl} className="w-full max-w-sm" />
			) : null}
			{state.kind === "unavailable" ? (
				<p className="text-xs text-nova-text-muted">
					Your browser can't record here
				</p>
			) : null}
		</div>
	);
}
