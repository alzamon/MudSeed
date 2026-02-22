/**
 * Minimal POSIX path utilities for Deno — no external dependencies.
 */

/** Join path segments, normalising `.` and `..` components. */
export function join(...parts: string[]): string {
  const raw = parts.join("/").replace(/\/+/g, "/");
  const abs = raw.startsWith("/");
  const segments = raw.split("/");
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!abs) {
        stack.push("..");
      }
    } else if (seg !== "." && seg !== "") {
      stack.push(seg);
    }
  }
  return (abs ? "/" : "") + (stack.join("/") || ".");
}

/** Return the extension of the last segment (including the leading dot). */
export function extname(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}
