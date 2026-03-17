'use client'
import { motion } from 'motion/react'

export function ConstraintError({ message }: { message: string }) {
  return (
    <motion.p
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="text-xs text-nova-rose mt-1"
    >
      {message}
    </motion.p>
  )
}
