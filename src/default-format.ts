export type OutputFormat = "mp3" | "m4a" | "original";
const formatKey = "shiyin-format";
const explicitKey = "shiyin-format-explicit";

function isOutputFormat(value: unknown): value is OutputFormat {
  return value === "mp3" || value === "m4a" || value === "original";
}

// Apply the MP3 default once for existing profiles, then respect later manual choices.
export function savedOutputFormat(): OutputFormat {
  const marker = "shiyin-default-mp3-v1";
  if (localStorage.getItem(marker) !== "1") {
    localStorage.setItem(formatKey, "mp3");
    localStorage.setItem(marker, "1");
  }
  const saved = localStorage.getItem(formatKey);
  return isOutputFormat(saved) ? saved : "mp3";
}

export function hasExplicitOutputFormat() {
  return localStorage.getItem(explicitKey) === "1";
}

export function setDefaultOutputFormat(value: OutputFormat) {
  if (!isOutputFormat(value)) return;
  savedOutputFormat();
  localStorage.setItem(formatKey, value);
  localStorage.setItem(explicitKey, "1");
}

export function rememberOutputFormat(value: unknown) {
  if (!hasExplicitOutputFormat() && isOutputFormat(value)) localStorage.setItem(formatKey, value);
}
