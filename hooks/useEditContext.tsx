'use client'
import { createContext, useContext, type ReactNode } from 'react'
import type { Builder } from '@/lib/services/builder'

export type EditMode = 'edit' | 'test'

interface EditContextValue {
  builder: Builder
  moduleIndex: number
  formIndex: number
  mode: EditMode
}

const EditContext = createContext<EditContextValue | null>(null)

export function EditContextProvider({
  builder,
  moduleIndex,
  formIndex,
  mode,
  children,
}: EditContextValue & { children: ReactNode }) {
  return (
    <EditContext.Provider value={{ builder, moduleIndex, formIndex, mode }}>
      {children}
    </EditContext.Provider>
  )
}

export function useEditContext(): EditContextValue | null {
  return useContext(EditContext)
}
