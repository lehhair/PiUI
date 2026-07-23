import type {
  Path as SDKPath,
  Project as SDKProject,
  ProjectUpdateData as SDKProjectUpdateData,
} from '@opencode-ai/sdk/v2/client'

export type Project = SDKProject

export type ProjectIcon = NonNullable<Project['icon']>

export type ProjectCommands = NonNullable<Project['commands']>

export type ProjectUpdateParams = NonNullable<SDKProjectUpdateData['body']>

export type PathResponse = SDKPath
