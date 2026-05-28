import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import { Send, Square, ImagePlus, X, Clipboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useApp } from "@/context/AppContext";
import { getDesktopConfig } from "@/hooks/useDesktopConfig";
import { toFileUrl } from "@/lib/file-url";
import type { ImageAttachment } from "@/types";

function normalizeAttachment(input: unknown): ImageAttachment | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const path = typeof obj.path === "string" ? obj.path.trim() : "";
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const mediaType = typeof obj.mediaType === "string" ? obj.mediaType.trim() : "";
  if (!path || !name || !mediaType.startsWith("image/")) return null;
  return {
    id:
      typeof obj.id === "string" && obj.id.trim()
        ? obj.id.trim()
        : `att-${Math.random().toString(36).slice(2, 10)}`,
    path,
    name,
    mediaType,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read pasted image"));
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

function formatClipboardDebug(
  debug: Record<string, unknown> | null,
  attachment: ImageAttachment | null,
): string {
  if (!debug) {
    if (attachment?.name) return `Clipboard: attached ${attachment.name}`;
    return "";
  }
  const details: string[] = [];
  if (attachment?.name) {
    details.push(`attached ${attachment.name}`);
  } else if (debug.error) {
    details.push(`failed (${debug.error})`);
  } else if (debug.hasImage) {
    details.push("image detected but not saved");
  } else {
    details.push("no image detected");
  }
  if (
    Number.isFinite(debug.width) &&
    Number.isFinite(debug.height) &&
    (debug.width as number) > 0
  ) {
    details.push(`${debug.width}x${debug.height}`);
  }
  if (Number.isFinite(debug.pngBytes) && (debug.pngBytes as number) > 0) {
    const bytes = debug.pngBytes as number;
    const label =
      bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    details.push(label);
  }
  return `Clipboard: ${details.join(" · ")}`;
}

export function Composer() {
  const { workspace, agentRun } = useApp();
  const { currentWorkspace } = workspace;
  const { threadId } = workspace;
  const {
    isRunBusy,
    cancelRun,
    composerAttachments,
    setComposerAttachments,
    sendPrompt,
    resumePrompt,
    sessionId,
  } = agentRun;
  const config = getDesktopConfig();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pasteDebug, setPasteDebug] = useState("");

  const mergeAttachments = useCallback(
    (next: ImageAttachment[]) => {
      setComposerAttachments((prev) => {
        const deduped = new Map(prev.map((a) => [a.path, a]));
        next.forEach((a) => deduped.set(a.path, a));
        return [...deduped.values()];
      });
    },
    [setComposerAttachments],
  );

  const pasteNativeClipboardImage = useCallback(
    async (focusComposer = false): Promise<ImageAttachment | null> => {
      if (!config.pasteClipboardImage) return null;
      const result = await config.pasteClipboardImage();
      const attachment = normalizeAttachment(result?.attachment);
      setPasteDebug(
        formatClipboardDebug(
          (result?.debug as Record<string, unknown>) ?? null,
          attachment,
        ),
      );
      if (attachment) {
        mergeAttachments([attachment]);
        if (focusComposer) textareaRef.current?.focus();
      }
      return attachment;
    },
    [config, mergeAttachments],
  );

  const persistPastedImage = useCallback(
    async (file: File, index = 0): Promise<ImageAttachment | null> => {
      if (!config.savePastedImage) return null;
      const dataUrl = await readFileAsDataUrl(file);
      const result = await config.savePastedImage({
        dataUrl,
        name: file.name || `pasted-image-${index + 1}`,
        mediaType: file.type || undefined,
      });
      return normalizeAttachment(result);
    },
    [config],
  );

  const handleComposerPaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (isRunBusy) return;
      const clipboardData = e.clipboardData;
      const items = Array.from(clipboardData?.items ?? []);
      const imageItems = items.filter(
        (item) =>
          item.kind === "file" &&
          (!item.type || item.type.startsWith("image/")),
      );
      const hasImagePayload =
        imageItems.length > 0 ||
        Array.from(clipboardData?.types ?? []).includes("Files");
      if (!hasImagePayload) return;

      e.preventDefault();

      const pastedText = clipboardData?.getData("text/plain") ?? "";
      if (pastedText && textareaRef.current) {
        const ta = textareaRef.current;
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? ta.value.length;
        ta.value = `${ta.value.slice(0, start)}${pastedText}${ta.value.slice(end)}`;
        const cursor = start + pastedText.length;
        ta.selectionStart = cursor;
        ta.selectionEnd = cursor;
      }

      try {
        let attachment = await pasteNativeClipboardImage();

        if (!attachment && imageItems.length > 0) {
          const domAttachments = (
            await Promise.all(
              imageItems.map(async (item, idx) => {
                const file = item.getAsFile();
                if (!file) return null;
                return persistPastedImage(file, idx);
              }),
            )
          ).filter(Boolean) as ImageAttachment[];
          if (domAttachments.length > 0) {
            mergeAttachments(domAttachments);
            attachment = domAttachments[0];
            setPasteDebug(
              `Clipboard: attached ${domAttachments[0].name}${domAttachments.length > 1 ? ` (+${domAttachments.length - 1})` : ""}`,
            );
          }
        }

        if (!attachment && !pasteDebug) {
          setPasteDebug(
            "Clipboard: image paste detected but nothing was attached",
          );
        }
      } catch (err) {
        setPasteDebug(
          `Clipboard: failed (${err instanceof Error ? err.message : "unknown error"})`,
        );
      }
    },
    [
      isRunBusy,
      pasteNativeClipboardImage,
      persistPastedImage,
      mergeAttachments,
      pasteDebug,
    ],
  );

  useEffect(() => {
    const handleGlobalPaste = async (e: globalThis.KeyboardEvent) => {
      const isPaste =
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "v";
      if (!isPaste || isRunBusy) return;

      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("textarea, input") ||
          target.isContentEditable ||
          Boolean(target.closest("textarea, input")))
      ) {
        return;
      }

      e.preventDefault();
      try {
        await pasteNativeClipboardImage(true);
      } catch (err) {
        setPasteDebug(
          `Clipboard: failed (${err instanceof Error ? err.message : "unknown error"})`,
        );
      }
    };

    document.addEventListener("keydown", handleGlobalPaste);
    return () => document.removeEventListener("keydown", handleGlobalPaste);
  }, [isRunBusy, pasteNativeClipboardImage]);

  const handleSend = async () => {
    if (!currentWorkspace || isRunBusy) return;
    const prompt = textareaRef.current?.value.trim() ?? "";
    if (!prompt && composerAttachments.length === 0) return;

    if (textareaRef.current) textareaRef.current.value = "";
    setPasteDebug("");

    if (threadId) {
      await resumePrompt(prompt, currentWorkspace.path, threadId);
    } else {
      await sendPrompt(prompt, currentWorkspace.path);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handlePickImages = async () => {
    if (!config.pickImages || isRunBusy) return;
    try {
      const picked = await config.pickImages();
      if (Array.isArray(picked) && picked.length > 0) {
        const normalized = (picked as unknown[])
          .map(normalizeAttachment)
          .filter(Boolean) as ImageAttachment[];
        mergeAttachments(normalized);
      }
    } catch {
      /* ignore */
    }
  };

  const removeAttachment = (id: string) => {
    setComposerAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const placeholder = currentWorkspace
    ? `Ask ${currentWorkspace.name} to inspect the codebase, explain a file, or plan a change.`
    : "Choose a codebase first...";

  return (
    <div className="grid gap-3 max-w-[920px] w-full mx-auto">
      <div className="rounded-[20px] border border-line bg-panel shadow-[var(--shadow-soft)] backdrop-blur-[18px] p-4">
        {composerAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-3">
            {composerAttachments.map((att) => (
              <div
                key={att.id}
                className="inline-flex items-center gap-2 max-w-[320px] px-2.5 py-1.5 rounded-full border border-line bg-white/90 shadow-sm"
              >
                <img
                  src={toFileUrl(att.path)}
                  alt={att.name}
                  className="w-7 h-7 rounded-lg object-cover bg-line"
                />
                <span className="text-sm truncate">{att.name}</span>
                <button
                  onClick={() => removeAttachment(att.id)}
                  className="rounded-md p-1 text-soft hover:bg-line hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={3}
          placeholder={placeholder}
          disabled={!currentWorkspace}
          onKeyDown={handleKeyDown}
          onPaste={handleComposerPaste}
          className="w-full min-h-[80px] border-0 bg-transparent text-text text-base leading-relaxed resize-y outline-none placeholder:text-soft disabled:cursor-not-allowed disabled:opacity-50"
        />

        {pasteDebug && (
          <p className="text-xs text-soft pb-1 break-all flex items-center gap-1.5">
            <Clipboard className="h-3 w-3 shrink-0" />
            {pasteDebug}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 pt-3 border-t border-line/60">
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePickImages()}
                  disabled={isRunBusy || !currentWorkspace}
                  className="rounded-full gap-1.5"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  Images
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach images</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center gap-2.5">
            {isRunBusy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void cancelRun()}
                    aria-label="Stop the running agent"
                    className="rounded-full gap-1.5 min-w-[84px]"
                  >
                    <Square className="h-3.5 w-3.5" />
                    Stop
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Stop the running agent</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                onClick={() => void handleSend()}
                disabled={!currentWorkspace}
                size="sm"
                className="rounded-full gap-1.5 min-w-[84px] shadow-[0_12px_22px_rgba(23,21,20,0.18)]"
              >
                <Send className="h-3.5 w-3.5" />
                Send
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2.5 pb-1">
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white/70 px-3 py-1.5 text-xs text-muted">
          <span className="w-2 h-2 rounded-full bg-positive shadow-[0_0_0_3px_rgba(20,145,79,0.14)]" />
          Local
        </span>
        <span className="inline-flex items-center rounded-full border border-line bg-white/70 px-3 py-1.5 text-xs text-muted">
          Workspace-scoped
        </span>
      </div>
    </div>
  );
}
