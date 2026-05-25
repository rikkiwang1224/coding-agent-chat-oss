import path from "node:path";
import { collapseText, isRecord } from "./text.js";

export interface ChatDesktopImageAttachment {
  id?: string;
  path: string;
  name: string;
  mediaType: string;
}

export function normalizeImageMediaType(mediaType: string | undefined, filePath?: string): string | undefined {
  const normalized = mediaType?.trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/gif":
    case "image/webp":
      return normalized;
    default:
      break;
  }

  const extension = path.extname(filePath ?? "").toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

export function resolveImageExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

export function normalizeImageAttachment(value: unknown): ChatDesktopImageAttachment | null {
  if (!isRecord(value)) {
    return null;
  }

  const filePath = collapseText(value.path);
  if (!filePath) {
    return null;
  }

  const mediaType = normalizeImageMediaType(collapseText(value.mediaType), filePath);
  if (!mediaType) {
    return null;
  }

  return {
    id: collapseText(value.id) || undefined,
    path: path.resolve(filePath),
    name: collapseText(value.name) || path.basename(filePath),
    mediaType
  };
}

export function readImageAttachments(value: unknown): ChatDesktopImageAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Map<string, ChatDesktopImageAttachment>();
  for (const item of value) {
    const attachment = normalizeImageAttachment(item);
    if (!attachment) {
      continue;
    }
    deduped.set(attachment.path, attachment);
  }

  return [...deduped.values()];
}
