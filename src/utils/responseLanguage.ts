export type ResponseLanguage = "auto" | "ja" | "en";

export function responseLanguage(value: unknown): ResponseLanguage {
  return value === "ja" || value === "en" ? value : "auto";
}

export function selectionQuestion(selection: string, language: ResponseLanguage): string {
  const characters = Array.from(selection);
  const excerpt = characters.slice(0, 200).join("") + (characters.length > 200 ? "…" : "");
  if (language === "ja") return `次の選択箇所を日本語でわかりやすく説明してください：\n\n「${excerpt}」`;
  if (language === "en") return `Explain this selected passage in English:\n\n"${excerpt}"`;
  return `Explain this selected passage. Answer in the language of the selected passage:\n\n"${excerpt}"`;
}
