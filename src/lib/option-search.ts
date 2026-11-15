function normalize(text: string) {
  return text.normalize("NFKC").toLowerCase()
    .replace(/[يى]/g, "ی").replace(/ك/g, "ک")
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - "۰".charCodeAt(0)))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - "٠".charCodeAt(0)))
    .replace(/[\u200c\u200d]/g, "");
}

export function optionMatches(query: string) {
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  return (text: string) => {
    if (!words.length) return true;
    const normalized = normalize(text);
    return words.every((word) => normalized.includes(word));
  };
}
