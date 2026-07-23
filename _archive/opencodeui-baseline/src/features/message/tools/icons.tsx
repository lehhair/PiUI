// ============================================
// Tool Icons - powered by lucide-react
// 标准化的工具图标组件
// ============================================

import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  FileText,
  FilePenLine,
  Terminal,
  Search,
  Globe,
  Brain,
  Wrench,
  ListChecks,
  Loader,
  CircleHelp,
} from 'lucide-react'

interface IconProps {
  size?: number
  className?: string
}

const defaultSize = 14
const defaultClassName = 'text-text-400'

function wrapTool(Icon: ComponentType<LucideProps>) {
  return function WrappedToolIcon({ size = defaultSize, className = defaultClassName, ...props }: IconProps) {
    return <Icon size={size} className={className} {...(props as LucideProps)} />
  }
}

export const FileReadIcon = wrapTool(FileText)
export const FileWriteIcon = wrapTool(FilePenLine)
export const TerminalIcon = wrapTool(Terminal)
export const SearchIcon = wrapTool(Search)
export const GlobeIcon = wrapTool(Globe)
export const BrainIcon = wrapTool(Brain)
export const WrenchIcon = wrapTool(Wrench)
export const ChecklistIcon = wrapTool(ListChecks)
export const TaskIcon = wrapTool(Loader)

export const QuestionIcon = wrapTool(CircleHelp)
