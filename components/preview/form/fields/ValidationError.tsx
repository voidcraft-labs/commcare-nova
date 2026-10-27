"use client";
import { motion } from "motion/react";

/**
 * The validation message shown when a field is invalid: its text alone, as
 * plain text, which is how every CommCare runtime shows it. Web Apps binds
 * it with `text:` (`form_entry/question.html`, `serverError`) and Android
 * reads `getConstraintText()` with no markdown form, so markdown in the
 * message shows as written on both. The error only renders in preview (edit
 * mode is frozen and never touches a field).
 */
export function ValidationError({ message }: { message: string }) {
	return (
		<motion.div
			initial={{ opacity: 0, y: -4 }}
			animate={{ opacity: 1, y: 0 }}
			className="mt-1 whitespace-pre-wrap text-xs text-nova-rose"
		>
			{message}
		</motion.div>
	);
}
