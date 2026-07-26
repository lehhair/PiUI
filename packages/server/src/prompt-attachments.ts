import { statSync } from "node:fs"
import type { SessionAttachmentV2 } from "@piui/protocol"
import type { PiImageInput } from "@piui/pi-worker"
import { resolveWorkspacePath } from "./path-safety.ts"

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024
const MAX_TOTAL_TEXT_BYTES = 1024 * 1024

export interface PreparedPromptInput {
  text: string
  images: PiImageInput[]
}

export function preparePromptInput(
  workspaceRoot: string,
  text: string,
  attachments: SessionAttachmentV2[] | undefined,
): PreparedPromptInput {
  if (attachments === undefined) return { text, images: [] }
  if (!Array.isArray(attachments)) throw invalidAttachment("attachments must be an array")

  const images: PiImageInput[] = []
  const references: string[] = []
  let totalImageBytes = 0
  let totalTextBytes = 0

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object" || typeof attachment.type !== "string") {
      throw invalidAttachment("invalid attachment")
    }

    if (attachment.type === "image") {
      if (images.length >= MAX_IMAGES) throw invalidAttachment(`at most ${MAX_IMAGES} images are allowed`)
      if (!SUPPORTED_IMAGE_TYPES.has(attachment.mimeType)) {
        throw invalidAttachment(`unsupported image type: ${attachment.mimeType}`)
      }
      const bytes = decodeBase64(attachment.data)
      if (bytes.length > MAX_IMAGE_BYTES) throw attachmentTooLarge("image exceeds 4.5 MiB")
      totalImageBytes += bytes.length
      if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) throw attachmentTooLarge("images exceed 16 MiB total")
      if (!matchesImageSignature(bytes, attachment.mimeType)) {
        throw invalidAttachment(`image data does not match ${attachment.mimeType}`)
      }
      images.push({ type: "image", mimeType: attachment.mimeType, data: attachment.data })
      continue
    }

    if (attachment.type === "file" || attachment.type === "directory") {
      if (typeof attachment.path !== "string" || /[\r\n]/.test(attachment.path)) {
        throw invalidAttachment("attachment path must be a single-line workspace-relative path")
      }
      const resolved = resolveWorkspacePath(workspaceRoot, attachment.path)
      if (!resolved.exists) throw invalidAttachment(`attachment path does not exist: ${resolved.relative}`)
      const stat = statSync(resolved.absolute)
      const expectedDirectory = attachment.type === "directory"
      if (expectedDirectory ? !stat.isDirectory() : !stat.isFile()) {
        throw invalidAttachment(`attachment path is not a ${expectedDirectory ? "directory" : "file"}`)
      }
      references.push(`[Attached workspace ${attachment.type}: ${resolved.relative}]`)
      continue
    }

    if (attachment.type === "text") {
      if (typeof attachment.text !== "string") throw invalidAttachment("text attachment content required")
      const bytes = Buffer.byteLength(attachment.text)
      if (bytes > MAX_TEXT_ATTACHMENT_BYTES) throw attachmentTooLarge("text attachment exceeds 256 KiB")
      totalTextBytes += bytes
      if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) throw attachmentTooLarge("text attachments exceed 1 MiB total")
      const name = cleanAttachmentName(attachment.name)
      references.push(`[Attached text${name ? `: ${name}` : ""}]\n${attachment.text}`)
      continue
    }

    throw invalidAttachment("unsupported attachment type")
  }

  const suffix = references.length > 0 ? `\n\n${references.join("\n\n")}` : ""
  return { text: `${text}${suffix}`.trim(), images }
}

function decodeBase64(data: unknown): Buffer {
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0) {
    throw invalidAttachment("invalid image base64")
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw invalidAttachment("invalid image base64")
  const bytes = Buffer.from(data, "base64")
  if (bytes.toString("base64") !== data) throw invalidAttachment("invalid image base64")
  return bytes
}

function matchesImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
}

function cleanAttachmentName(name: unknown): string {
  return typeof name === "string" ? name.replace(/[\r\n]/g, " ").trim().slice(0, 120) : ""
}

function invalidAttachment(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" })
}

function attachmentTooLarge(message: string): Error {
  return Object.assign(new Error(message), { code: "FILE_TOO_LARGE" })
}
