const TRANSCRIPT_TIMESTAMP_PREFIX = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s+/;

export function formatSessionTranscriptEntry(entry: string, timestamp = new Date().toISOString()): string {
  const normalizedEntry = typeof entry === "string" ? entry.trim() : "";
  if (!normalizedEntry) {
    return "";
  }

  if (hasSessionTranscriptTimestampPrefix(normalizedEntry)) {
    return normalizedEntry;
  }

  return `[${timestamp}] ${normalizedEntry}`;
}

export function hasSessionTranscriptTimestampPrefix(entry: string): boolean {
  return TRANSCRIPT_TIMESTAMP_PREFIX.test(entry);
}

export function stripSessionTranscriptTimestampPrefix(entry: string): string {
  return entry.replace(TRANSCRIPT_TIMESTAMP_PREFIX, "");
}
