// Protect code before converting the TeX delimiters commonly emitted by chat models.
// Requiring double dollars in remark-math also keeps currency such as $5 literal.
export function normalizeMathDelimiters(content: string): string {
  return content.replace(
    /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2[^\n]*(?:\n|$)|$(?![\s\S])))|(`+)[^`]*?\3|\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)|(?<![\\$])\$(?!\$)([^\n$]+?)\$(?![\d$])/gm,
    (match, fenced: string | undefined, _fence: string | undefined, inline: string | undefined, display: string | undefined, math: string | undefined, dollar: string | undefined) => {
      if (fenced || inline) return match;
      if (display !== undefined) return `\n\n$$\n${display.trim()}\n$$\n\n`;
      if (math !== undefined) return `$$${math}$$`;
      // The delimiter pattern excludes pairs of prices such as "$5 and $10".
      if (dollar !== undefined) return `$$${dollar}$$`;
      return match;
    },
  );
}
