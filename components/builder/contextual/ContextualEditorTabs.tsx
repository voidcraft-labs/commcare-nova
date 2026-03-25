'use client'

export type EditorTab = 'ui' | 'logic' | 'data'

const tabs: { id: EditorTab; label: string }[] = [
  { id: 'ui', label: 'UI' },
  { id: 'logic', label: 'Logic' },
  { id: 'data', label: 'Data' },
]

const tabIndex: Record<EditorTab, number> = { ui: 0, logic: 1, data: 2 }

interface ContextualEditorTabsProps {
  activeTab: EditorTab
  onTabChange: (tab: EditorTab) => void
}

export function ContextualEditorTabs({ activeTab, onTabChange }: ContextualEditorTabsProps) {
  // Slide the indicator horizontally via translateX — each tab is 1/3 width
  const translateX = `${tabIndex[activeTab] * 100}%`

  return (
    <div className="flex px-3 pt-3 pb-2">
      <div className="relative flex h-8 flex-1 items-center rounded-lg bg-white/[0.04] p-1 gap-0.5">
        {/* Sliding indicator */}
        <div
          className="absolute top-1 bottom-1 rounded-md bg-white/[0.08] shadow-sm transition-transform duration-200 ease-out"
          style={{ width: `calc((100% - 8px) / 3)`, left: 4, transform: `translateX(${translateX})` }}
        />
        {tabs.map(({ id, label }) => {
          const isActive = activeTab === id
          return (
            <button
              key={id}
              onClick={() => onTabChange(id)}
              className={`relative flex-1 h-full flex items-center justify-center rounded-md text-xs font-medium transition-colors cursor-pointer z-10 ${
                isActive ? 'text-nova-cyan-bright' : 'text-nova-text-muted hover:text-nova-text-secondary'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
