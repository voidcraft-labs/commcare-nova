"use client";

import { useEffect, useRef, useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/shadcn/dialog";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";

/** CameraOverlayActivity's rectangle is a visual guide. Save the whole
 * sensor frame without drawing the rectangle or the surrounding scrim. */
export function FramedPhoto({
	disabled,
	labelledBy,
	onFile,
}: {
	disabled: boolean;
	labelledBy?: string;
	onFile: (file: File) => void;
}) {
	const { language } = useBuilderLanguage();
	const video = useRef<HTMLVideoElement>(null);
	const session = useRef(0);
	const [open, setOpen] = useState(false);
	const [ready, setReady] = useState(false);
	const [failed, setFailed] = useState(false);
	const [generation, retry] = useState(0);
	useEffect(() => {
		if (!open || disabled || generation === 0) return;
		const current = ++session.current;
		let acquired: MediaStream | undefined;
		const stop = (stream?: MediaStream) => {
			for (const track of stream?.getTracks() ?? []) track.stop();
		};
		async function start() {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: {
						facingMode: { ideal: "environment" },
						width: { ideal: 2560 },
						height: { ideal: 1920 },
					},
				});
				if (current !== session.current || !video.current) {
					stop(stream);
					return;
				}
				acquired = stream;
				video.current.srcObject = stream;
				await video.current.play();
			} catch {
				stop(acquired);
				if (current === session.current) setFailed(true);
			}
		}
		void start();
		return () => {
			session.current++;
			stop(acquired);
		};
	}, [open, disabled, generation]);
	function reset() {
		setReady(false);
		setFailed(false);
	}
	function shoot() {
		const source = video.current;
		if (!source?.videoWidth || !source.videoHeight || disabled || !ready)
			return;
		const current = session.current;
		const frame = document.createElement("canvas");
		frame.width = source.videoWidth;
		frame.height = source.videoHeight;
		const context = frame.getContext("2d");
		if (!context) {
			setFailed(true);
			return;
		}
		context.drawImage(source, 0, 0);
		setReady(false);
		frame.toBlob(
			(blob) => {
				if (session.current !== current) return;
				if (!blob) {
					setFailed(true);
					return;
				}
				setOpen(false);
				onFile(new File([blob], "photo.jpg", { type: "image/jpeg" }));
			},
			"image/jpeg",
			0.92,
		);
	}
	return (
		<Dialog
			open={open && !disabled}
			onOpenChange={(next) => {
				reset();
				setOpen(next);
				retry(next ? 1 : 0);
			}}
		>
			<DialogTrigger
				render={
					<Button
						type="button"
						variant="field"
						disabled={disabled}
						aria-describedby={labelledBy}
					/>
				}
			>
				{runtimeMessage(language, "takePicture")}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{runtimeMessage(language, "takePicture")}</DialogTitle>
					<DialogDescription>
						{runtimeMessage(language, "photoFrameGuide")}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{failed && (
						<p role="status">{runtimeMessage(language, "cameraUnavailable")}</p>
					)}
					<div className="relative overflow-hidden rounded bg-black">
						<video
							ref={video}
							muted
							playsInline
							onLoadedData={() => setReady(true)}
							className="max-h-[60dvh] w-full object-contain"
						/>
						{ready && (
							<div
								aria-hidden="true"
								className="pointer-events-none absolute top-1/2 left-1/2 h-1/5 w-1/2 -translate-x-1/2 -translate-y-1/2 border-2 border-white shadow-[0_0_0_100vmax_#0006] landscape:h-2/5 landscape:w-2/5"
							/>
						)}
					</div>
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button type="button" variant="ghost" />}>
						{runtimeMessage(language, "cancel")}
					</DialogClose>
					{failed ? (
						<Button
							type="button"
							onClick={() => {
								reset();
								retry((n) => n + 1);
							}}
						>
							{runtimeMessage(language, "tryAgain")}
						</Button>
					) : (
						<Button type="button" disabled={!ready} onClick={shoot}>
							{runtimeMessage(language, "takePicture")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
