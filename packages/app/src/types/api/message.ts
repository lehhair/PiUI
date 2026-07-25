import type {
  AgentPart,
  AssistantMessageInfo,
  CompactionPart,
  FilePart,
  FilePartSource,
  MessageSummary,
  Part,
  PatchPart,
  ReasoningPart,
  RetryPart,
  SnapshotPart,
  StepFinishPart,
  StepStartPart,
  SubtaskPart,
  TextPart,
  ToolPart,
  ToolState,
  UserMessageInfo,
} from '../message'

export type UserMessage = UserMessageInfo
export type AssistantMessage = AssistantMessageInfo
export type Message = UserMessage | AssistantMessage
export type { MessageSummary, TextPart, ReasoningPart, ToolState, ToolPart, FilePart, AgentPart }
export type { StepStartPart, StepFinishPart, SnapshotPart, PatchPart, SubtaskPart, RetryPart, CompactionPart, Part }
export type FileSource = FilePartSource
export type FileSourceType = FileSource['type']

export interface TextPartInput { type: 'text'; text: string; synthetic?: boolean }
export interface FilePartInput { type: 'file'; mime: string; filename?: string; url: string; source?: FileSource }
export interface AgentPartInput { type: 'agent'; name: string; source?: { value: string; start: number; end: number } }
export interface SubtaskPartInput {
  type: 'subtask'
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
}
