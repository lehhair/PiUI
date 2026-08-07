export { useClickOutside } from './useClickOutside'
export { useDropdown } from './useDropdown'
export { usePermissions } from './usePermissions'
export { useTheme } from './useTheme'
export { useSessions } from './useSessions'
export { useRouter } from './useRouter'
export { useProject } from './useProject'
export { useMessageAnimation } from './useMessageAnimation'
export { useGlobalEvents } from './useGlobalEvents'
export {
  registerSessionConsumer,
  updateConsumerSessionId,
  hasOtherConsumerForSession,
  notifySessionStarted,
  subscribeSessionIdle,
} from './useGlobalEvents'
export type { SessionEventCallbacks } from './useGlobalEvents'
export { useDelayedRender } from './useDelayedRender'
export { useDisclosureScrollLock } from './useDisclosureScrollLock'
export { useCompositorExpand } from './useCompositorExpand'
export { useBackClose } from './useBackClose'
export { usePathMode } from './usePathMode'
export { useSessionStats, formatTokens, formatCost } from './useSessionStats'
export { useFileExplorer } from './useFileExplorer'
export { useIsMobile } from './useIsMobile'
export { useServerStore } from './useServerStore'
export { useKeybindingStore, useGlobalKeybindings, useKeybindingLabel } from './useKeybindings'
export type { KeybindingHandlers } from './useKeybindings'
export { useNotification } from './useNotification'
export { usePresence } from './usePresence'
export { useResponsiveMaxHeight } from './useResponsiveMaxHeight'
export type { ThemeMode } from './useTheme'
export type { UseProjectResult } from './useProject'
export type { SessionStats } from './useSessionStats'
export type { FileTreeNode, UseFileExplorerOptions, UseFileExplorerResult } from './useFileExplorer'
export { useVcsInfo } from './useVcsInfo'
export type { UseVcsInfoResult } from './useVcsInfo'
export { useGitWorkspaceCatalog, requestGitWorkspaceCatalogRefresh } from './useGitWorkspaceCatalog'
export type { GitWorkspaceCatalog, GitWorkspaceMeta } from './useGitWorkspaceCatalog'

// Re-export from contexts
export {
  DirectoryProvider,
  useDirectory,
  useCurrentDirectory,
  useSavedDirectories,
  usePathInfo,
  useSidebarExpanded,
  SessionProvider,
  useSessionContext,
} from '../contexts'
export type { DirectoryContextValue, SessionContextValue } from '../contexts'
