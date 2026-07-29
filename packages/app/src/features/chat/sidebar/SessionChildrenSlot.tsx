import { useMemo } from 'react'
import type { UiSession } from '../../../types/session'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'
import { SessionListItem } from '../../sessions'
import { flattenSessionHierarchy } from '../../../pi/sessionHierarchy'

interface SessionChildrenSlotProps {
  parentSession: UiSession
  selectedSessionId: string | null
  fetchAll?: boolean
  children?: UiSession[]
  childrenByParent?: Map<string, UiSession[]>
  onSelect: (session: UiSession) => void
  onDeleteSelected?: () => void
  isEditMode?: boolean
  selectedSessionIds?: Set<string>
  onToggleSessionSelection?: (sessionId: string, options?: { shiftKey?: boolean }) => void
}

export function SessionChildrenSlot({
  parentSession,
  children = [],
  childrenByParent,
  selectedSessionId,
  onSelect,
  isEditMode = false,
  selectedSessionIds,
  onToggleSessionSelection,
}: SessionChildrenSlotProps) {
  const { preferTouchUi } = useInputCapabilities()
  const rows = useMemo(
    () => flattenSessionHierarchy(parentSession.id, children, childrenByParent),
    [parentSession.id, children, childrenByParent],
  )

  if (rows.length === 0) return null

  return (
    <div>
      {rows.map((row, index) => {
        const isChecked = selectedSessionIds?.has(row.session.id) ?? false
        const previous = rows[index - 1]
        const next = rows[index + 1]
        const prevChecked = isEditMode && previous?.visualDepth === row.visualDepth &&
          (selectedSessionIds?.has(previous.session.id) ?? false)
        const nextChecked = isEditMode && next?.visualDepth === row.visualDepth &&
          (selectedSessionIds?.has(next.session.id) ?? false)
        const hierarchyTitle = row.truncated
          ? `Fork depth ${row.depth}; deeper descendants hidden`
          : row.depth > row.visualDepth
            ? `Fork depth ${row.depth}`
            : undefined

        return (
          <div
            key={row.session.id}
            data-fork-depth={row.depth}
            title={hierarchyTitle}
            style={{ marginInlineStart: `${row.visualDepth * 12}px` }}
          >
            <SessionListItem
              session={row.session}
              isSelected={row.session.id === selectedSessionId}
              onSelect={() => onSelect(row.session)}
              onRename={() => undefined}
              onDelete={() => undefined}
              preferTouchUi={preferTouchUi}
              density="minimal"
              showDirectory={false}
              isEditMode={isEditMode}
              isChecked={isChecked}
              checkedPrev={prevChecked}
              checkedNext={nextChecked}
              onToggleCheck={
                onToggleSessionSelection
                  ? options => onToggleSessionSelection(row.session.id, options)
                  : undefined
              }
            />
          </div>
        )
      })}
    </div>
  )
}
