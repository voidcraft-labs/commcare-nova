export function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'text-lg',
    md: 'text-xl',
    lg: 'text-3xl',
  }

  return (
    <div className={`${sizes[size]} font-display font-bold tracking-tight flex items-center gap-2`}>
      <div className="relative">
        <div className="w-2 h-2 rounded-full bg-nova-violet" />
        <div className="absolute inset-0 w-2 h-2 rounded-full bg-nova-violet animate-ping opacity-30" />
      </div>
      <span className="bg-gradient-to-r from-nova-text to-nova-violet-bright bg-clip-text text-transparent">
        commcare nova
      </span>
    </div>
  )
}
