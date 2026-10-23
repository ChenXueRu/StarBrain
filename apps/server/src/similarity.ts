// 去掉空白與標點（含全形標點、符號），英文轉小寫
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, '')
}

// 字元二元組；只有一個字時用單字本身。以字（code point）為單位，中英文都適用
function bigrams(text: string): Map<string, number> {
  const chars = Array.from(text)
  const grams = chars.length === 1 ? chars : chars.slice(1).map((ch, i) => chars[i] + ch)
  const counts = new Map<string, number>()
  for (const gram of grams) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  return counts
}

// Dice 係數：2 × 共同二元組數 ÷ 兩邊二元組總數，範圍 0～1
export function similarity(a: string, b: string): number {
  const left = bigrams(normalize(a))
  const right = bigrams(normalize(b))
  let total = 0
  let common = 0
  for (const count of left.values()) total += count
  for (const count of right.values()) total += count
  if (total === 0) return 0
  for (const [gram, count] of left) common += Math.min(count, right.get(gram) ?? 0)
  return (2 * common) / total
}
