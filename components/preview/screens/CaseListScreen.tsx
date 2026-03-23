'use client'
import { useMemo } from 'react'
import { motion } from 'motion/react'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { PreviewScreen } from '@/lib/preview/engine/types'
import { getDummyCases } from '@/lib/preview/engine/dummyData'

interface CaseListScreenProps {
  blueprint: AppBlueprint
  moduleIndex: number
  formIndex: number
  onNavigate: (screen: PreviewScreen) => void
}

export function CaseListScreen({ blueprint, moduleIndex, formIndex, onNavigate }: CaseListScreenProps) {
  const mod = blueprint.modules[moduleIndex]
  const form = mod?.forms[formIndex]
  const caseType = blueprint.case_types?.find(ct => ct.name === mod?.case_type)
  const columns = mod?.case_list_columns ?? []

  const rows = useMemo(() => {
    if (!caseType) return []
    return getDummyCases(caseType)
  }, [caseType])

  if (!mod || !caseType || columns.length === 0) {
    return (
      <div className="p-6 text-center text-nova-text-muted">
        No case list configured for this module.
      </div>
    )
  }

  const handleRowClick = (rowIndex: number) => {
    const row = rows[rowIndex]
    onNavigate({
      type: 'form',
      moduleIndex,
      formIndex,
      caseData: row.properties,
    })
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h2 className="text-lg font-display font-semibold text-nova-text mb-1">
        {form?.name}
      </h2>
      <p className="text-sm text-nova-text-muted mb-4">Select a case to continue</p>

      <div className="rounded-lg border border-pv-input-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-pv-surface">
              {columns.map((col, i) => (
                <th key={i} className="text-left px-4 py-2.5 font-medium text-pv-accent-bright border-b border-pv-input-border">
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => (
              <motion.tr
                key={row.case_id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: rIdx * 0.04, duration: 0.2 }}
                onClick={() => handleRowClick(rIdx)}
                className={`cursor-pointer hover:bg-pv-elevated ${
                  rIdx % 2 === 0 ? 'bg-pv-bg' : 'bg-pv-surface/50'
                } transition-colors`}
              >
                {columns.map((col, cIdx) => (
                  <td key={cIdx} className="px-4 py-2 text-nova-text-secondary border-b border-pv-input-border/50">
                    {row.properties.get(col.field) ?? ''}
                  </td>
                ))}
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
