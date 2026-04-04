"use client";
import { motion } from "motion/react";

export function ThinkingIndicator() {
	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.25, ease: "easeOut" }}
			className="flex items-center gap-2.5 px-1 py-1"
		>
			{/* Orbital dot animation */}
			<div className="relative w-[26px] h-[26px]">
				<motion.div
					className="absolute inset-[3px] rounded-full border border-nova-violet/25"
					animate={{ rotate: 360 }}
					transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
				>
					<div className="absolute -top-[2.5px] left-1/2 -translate-x-1/2 w-[5px] h-[5px] rounded-full bg-nova-violet shadow-[0_0_8px_rgba(139,92,246,0.6)]" />
				</motion.div>
				<div className="absolute inset-[8px] rounded-full bg-nova-violet/10" />
			</div>

			<span className="text-xs text-nova-text-muted tracking-wide">
				Thinking
			</span>
		</motion.div>
	);
}
