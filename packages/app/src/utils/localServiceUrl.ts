import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'

export function applyLocalServiceUrl(url: string | null | undefined) {
  if (!url) return

  serverStore.setLocalServerRuntimeUrl(url)
  void serverStore.checkHealth(LOCAL_SERVER_ID)
}
