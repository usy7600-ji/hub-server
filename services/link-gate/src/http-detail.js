export function summarizeDetail(value, maxLen = 220) {
  if (value == null) {
    return String(value);
  }

  const text = typeof value === 'string'
    ? value
    : (() => {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })();

  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export function toDetailString(value) {
  const detail = summarizeDetail(value, 500);
  return detail == null ? '' : String(detail);
}
