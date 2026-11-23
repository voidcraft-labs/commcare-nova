"use client";

import { Icon } from "@iconify/react/offline";
import tablerQrcode from "@iconify-icons/tabler/qrcode";
import tablerVolume from "@iconify-icons/tabler/volume";
import { useCallback } from "react";
import { Button } from "@/components/shadcn/button";

/**
 * The QR code Android draws in a label's image place
 * (`lib/preview/labelPresentation.ts`). Preview names the code and the text
 * it holds, which is what a scan of it reads.
 */
export function LabelQrCode({ text }: { text: string }) {
	return (
		<figure
			className="flex items-center gap-3 rounded-lg border border-pv-input-border bg-pv-surface px-3 py-2"
			data-label-qr-code=""
		>
			<Icon
				icon={tablerQrcode}
				width={40}
				height={40}
				aria-hidden="true"
				className="shrink-0 text-nova-text"
			/>
			<figcaption className="min-w-0 text-sm text-nova-text">
				<span className="block text-xs text-nova-text-muted">QR code</span>
				<span className="block break-words">{text}</span>
			</figcaption>
		</figure>
	);
}

/**
 * The speaker button Android shows beside a label with spoken text and no
 * audio (`lib/preview/labelPresentation.ts`). It reads the text aloud
 * through the browser's speech, where the browser has it.
 */
export function LabelSpeechButton({
	text,
	questionLabel,
}: {
	text: string;
	questionLabel: string | undefined;
}) {
	const speak = useCallback(() => {
		const speech = globalThis.speechSynthesis;
		if (speech === undefined) return;
		speech.cancel();
		speech.speak(new SpeechSynthesisUtterance(text));
	}, [text]);
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			onClick={speak}
			aria-label={questionLabel ? `Read aloud: ${questionLabel}` : "Read aloud"}
			data-label-speech=""
		>
			<Icon icon={tablerVolume} width={20} height={20} aria-hidden="true" />
		</Button>
	);
}
