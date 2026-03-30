'use client'
import { Icon } from '@iconify/react/offline'
import ciCheck from '@iconify-icons/ci/check'
import { Button } from './Button'
import { Input } from './Input'

interface ApiKeyInputProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  saved: boolean
  label?: string
  onKeyDown?: (e: React.KeyboardEvent) => void
}

export function ApiKeyInput({ value, onChange, onSave, saved, label, onKeyDown }: ApiKeyInputProps) {
  return (
    <div className="flex gap-3 items-end">
      <div className="flex-1">
        <Input
          type="password"
          placeholder="sk-ant-..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave()
            onKeyDown?.(e)
          }}
          label={label}
        />
      </div>
      <Button
        onClick={onSave}
        variant={saved && value ? 'ghost' : 'secondary'}
        size="md"
        disabled={saved || !value}
        className={saved && value ? '!text-nova-emerald !opacity-100' : ''}
      >
        {saved && value ? (
          <>
            <Icon icon={ciCheck} width="14" height="14" />
            Saved
          </>
        ) : (
          'Save'
        )}
      </Button>
    </div>
  )
}
