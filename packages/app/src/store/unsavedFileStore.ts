const dirtyEditors = new Set<string>()

export function setFileEditorDirty(editorId: string, dirty: boolean): void {
  if (dirty) dirtyEditors.add(editorId)
  else dirtyEditors.delete(editorId)
}

export function hasUnsavedFileChanges(): boolean {
  return dirtyEditors.size > 0
}
