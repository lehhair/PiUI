import { isSameDirectory } from './directoryUtils'

interface CollectActiveDirectoriesOptions {
  routeDirectory?: string
  currentDirectory?: string
  paneDirectories?: string[]
  projectDirectories?: string[]
}

export function collectActiveDirectories({
  routeDirectory,
  currentDirectory,
  paneDirectories = [],
  projectDirectories = [],
}: CollectActiveDirectoriesOptions): string[] {
  const directories: string[] = []

  const pushDirectory = (directory?: string) => {
    if (!directory) return
    if (directories.some(existing => isSameDirectory(existing, directory))) return
    directories.push(directory)
  }

  pushDirectory(routeDirectory)
  pushDirectory(currentDirectory)
  paneDirectories.forEach(pushDirectory)
  projectDirectories.forEach(pushDirectory)

  return directories
}
