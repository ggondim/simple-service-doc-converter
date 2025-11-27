import { basename, extname } from 'path';

// Sanitize filename for safe Content-Disposition usage
export function sanitizeFilename(name: string, maxLength = 100): string {
  if (!name) return 'file';
  // Keep only basename
  let b = basename(name);
  // Remove control chars and replace problematic chars with underscore
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    const code = b.charCodeAt(i);
    // control chars
    if (code <= 31) {
      out.push('_');
      continue;
    }
    // problematic filesystem/header chars
    if (["\"", '\\', '/', '<', '>', '|', ':', '*', '?'].includes(ch)) {
      out.push('_');
      continue;
    }
    out.push(ch);
  }
  b = out.join('');
  // Trim whitespace
  b = b.trim();
  // Limit length
  if (b.length > maxLength) b = b.slice(0, maxLength);
  // Fallback
  if (!b) return 'file';
  return b;
}

// Build a safe Content-Disposition header for attachments.
// Returns a string like: attachment; filename="..."; filename*=UTF-8''encoded
export function buildContentDispositionAttachment(originalName: string, ext: string, maxBaseLength = 100): string {
  if (!ext) ext = '';
  // remove leading dot from ext if present
  const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext;

  // Use basename without extension
  const base = basename(originalName, extname(originalName) || `.${cleanExt}`);
  const safeBase = sanitizeFilename(base, maxBaseLength);
  const filename = cleanExt ? `${safeBase}.${cleanExt}` : safeBase;

  // filename* must be RFC5987 encoded (UTF-8 percent-encoding)
  const filenameStar = encodeURIComponent(filename);

  return `attachment; filename="${filename}"; filename*=UTF-8''${filenameStar}`;
}
