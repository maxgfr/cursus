/** Items keyed by their text, repeats told apart by their rank, each with its position. */
export function keyedChoices(items: readonly string[]): { item: string; key: string; at: number }[] {
  const seen = new Map<string, number>()
  return items.map((item, at) => {
    const n = (seen.get(item) ?? 0) + 1
    seen.set(item, n)
    return { item, key: n === 1 ? item : `${item}#${n}`, at }
  })
}
