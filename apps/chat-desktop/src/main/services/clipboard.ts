import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog } from "electron";
import {
  normalizeImageMediaType,
  resolveImageExtension,
  readImageAttachments,
  type ChatDesktopImageAttachment,
} from "../utils/image.js";
import { collapseText, readTextBlock, formatError } from "../utils/text.js";

export interface PersistPastedImageInput {
  dataUrl?: string;
  name?: string;
  mediaType?: string;
}

export interface ClipboardImageDebugInfo {
  availableFormats: string[];
  hasImage: boolean;
  pngBytes: number;
  width: number;
  height: number;
  timestamp: string;
  error?: string;
}

export interface PasteClipboardImageResult {
  attachment: ChatDesktopImageAttachment | null;
  debug: ClipboardImageDebugInfo;
}

function resolveAttachmentDirectory(): string {
  return path.join(app.getPath("userData"), "chat-attachments");
}

function buildAttachmentFilePath(directory: string, name: string, mediaType: string): string {
  const extension = path.extname(path.basename(name)) || resolveImageExtension(mediaType);
  return path.join(directory, `${randomUUID()}${extension}`);
}

async function writeAttachmentBuffer(
  buffer: Buffer,
  name: string,
  mediaType: string,
): Promise<string> {
  const directory = resolveAttachmentDirectory();
  await mkdir(directory, { recursive: true });
  const filePath = buildAttachmentFilePath(directory, name, mediaType);
  await writeFile(filePath, buffer);
  return filePath;
}

async function copyAttachmentFile(attachment: ChatDesktopImageAttachment): Promise<ChatDesktopImageAttachment> {
  const directory = resolveAttachmentDirectory();
  await mkdir(directory, { recursive: true });
  const filePath = buildAttachmentFilePath(directory, attachment.name, attachment.mediaType);
  await copyFile(attachment.path, filePath);
  return { ...attachment, path: filePath };
}

export async function pickImageAttachments(): Promise<ChatDesktopImageAttachment[]> {
  const ownerWindow = BrowserWindow.getFocusedWindow();
  ownerWindow?.focus();
  const options: Electron.OpenDialogOptions = {
    title: "Choose image attachments",
    buttonLabel: "Attach images",
    defaultPath: app.getPath("home"),
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled) return [];

  const attachments = readImageAttachments(
    result.filePaths.map((fp) => ({
      path: fp,
      name: path.basename(fp),
      mediaType: normalizeImageMediaType(undefined, fp),
    })),
  );
  return Promise.all(attachments.map((attachment) => copyAttachmentFile(attachment)));
}

function parseDataUrlImage(input: PersistPastedImageInput): { buffer: Buffer; mediaType: string; name: string } {
  const dataUrl = readTextBlock(input.dataUrl);
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw new Error("Clipboard image payload must be a base64 image data URL");

  const mediaType = normalizeImageMediaType(readTextBlock(input.mediaType) || match[1]);
  if (!mediaType) throw new Error("Unsupported clipboard image type");

  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (buffer.length === 0) throw new Error("Clipboard image payload is empty");

  const providedName = collapseText(input.name);
  const extension = resolveImageExtension(mediaType);
  const baseName = providedName
    ? path.basename(providedName, path.extname(providedName))
    : `pasted-image-${Date.now().toString(36)}`;
  return { buffer, mediaType, name: `${baseName}${extension}` };
}

export async function savePastedImage(input: PersistPastedImageInput | undefined): Promise<ChatDesktopImageAttachment> {
  const parsed = parseDataUrlImage(input ?? {});
  const filePath = await writeAttachmentBuffer(parsed.buffer, parsed.name, parsed.mediaType);

  return { path: filePath, name: parsed.name, mediaType: parsed.mediaType };
}

function inspectClipboardImage(): ClipboardImageDebugInfo {
  const timestamp = new Date().toISOString();
  try {
    const availableFormats = clipboard.availableFormats();
    const image = clipboard.readImage();
    const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
    return {
      availableFormats,
      hasImage: !image.isEmpty(),
      pngBytes: image.isEmpty() ? 0 : image.toPNG().length,
      width: size.width,
      height: size.height,
      timestamp,
    };
  } catch (error) {
    return { availableFormats: [], hasImage: false, pngBytes: 0, width: 0, height: 0, timestamp, error: formatError(error) };
  }
}

export function readClipboardImagePayload(): PersistPastedImageInput | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  return { dataUrl: image.toDataURL(), mediaType: "image/png", name: `clipboard-image-${Date.now().toString(36)}.png` };
}

export async function pasteClipboardImage(): Promise<PasteClipboardImageResult> {
  const debug = inspectClipboardImage();
  if (!debug.hasImage) {
    console.info("[chat-desktop] clipboard paste: no image", debug);
    return { attachment: null, debug };
  }

  try {
    const image = clipboard.readImage();
    const pngBuffer = image.toPNG();
    if (pngBuffer.length === 0) {
      const emptyDebug = { ...debug, pngBytes: 0, error: "Clipboard image was empty after PNG conversion" };
      console.info("[chat-desktop] clipboard paste: empty png buffer", emptyDebug);
      return { attachment: null, debug: emptyDebug };
    }

    const name = `clipboard-image-${Date.now().toString(36)}.png`;
    const filePath = await writeAttachmentBuffer(pngBuffer, name, "image/png");

    const savedDebug = { ...debug, pngBytes: pngBuffer.length };
    console.info("[chat-desktop] clipboard paste: saved image", { ...savedDebug, path: filePath, name });
    return { attachment: { path: filePath, name, mediaType: "image/png" }, debug: savedDebug };
  } catch (error) {
    const failedDebug = { ...debug, error: formatError(error) };
    console.error("[chat-desktop] clipboard paste failed", failedDebug);
    return { attachment: null, debug: failedDebug };
  }
}
