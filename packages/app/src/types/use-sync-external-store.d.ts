/**
 * Minimal ambient types for the official React `use-sync-external-store`
 * selector shim (the package ships JS only; @types/react only covers the
 * no-selector variant). Declared here so consumers can import
 * `useSyncExternalStoreWithSelector` like reference does.
 */
declare module 'use-sync-external-store/shim/with-selector' {
  import type { useSyncExternalStore } from 'react'
  export const useSyncExternalStoreWithSelector: <Snapshot, Selection>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot: (() => Snapshot) | undefined,
    selector: (snapshot: Snapshot) => Selection,
    isEqual?: (a: Selection, b: Selection) => boolean,
  ) => Selection
  export { useSyncExternalStore }
}
