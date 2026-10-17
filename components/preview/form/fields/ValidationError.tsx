"use client";
import { motion } from "motion/react";
import { PreviewMarkdown } from "@/lib/markdown";

/**
 * The validation message shown when a field is invalid: its text alone, as
 * every CommCare runtime shows it. The error only renders in preview (edit
 * mode is frozen and never touches a field).
 */
export function ValidationError({ message }: { message: string }) {
	return (
		<motion.div
			initial={{ opacity: 0, y: -4 }}
			animate={{ opacity: 1, y: 0 }}
			className="preview-markdown text-xs text-nova-rose mt-1"
		>
			<PreviewMarkdown>{message}</PreviewMarkdown>
		</motion.div>
	);
}
