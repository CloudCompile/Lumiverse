/**
 * Browser and operating-system MIME labels do not always match the labels in
 * Google's Gemini media contract. Keep the bytes unchanged while translating
 * common aliases to the MIME types documented for inlineData.
 */
const GOOGLE_MEDIA_MIME_ALIASES: Readonly<Record<string, string>> = {
  "audio/mpeg": "audio/mp3",
  "audio/x-mp3": "audio/mp3",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-aiff": "audio/aiff",
  "audio/x-flac": "audio/flac",
  "video/quicktime": "video/mov",
  "video/x-m4v": "video/mp4",
  "video/x-msvideo": "video/avi",
  "video/msvideo": "video/avi",
  "video/x-ms-wmv": "video/wmv",
};

export function normalizeGoogleMediaMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return GOOGLE_MEDIA_MIME_ALIASES[normalized] ?? normalized;
}
