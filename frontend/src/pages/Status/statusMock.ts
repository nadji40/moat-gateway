
export function generateMockUptimeDays() {
  const days = []

  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.UTC(2026, 9, 21))
    date.setUTCDate(date.getUTCDate() - i)

    // Realistic demo values, including degraded days
    const ratio =
      i === 4 ? 0.682 :
      i === 11 ? 0.754 :
      i === 18 ? 0.91 :
      i === 24 ? 0.965 :
      i % 7 === 0 ? 0.995 :
      i % 5 === 0 ? 0.998 :
      1

    const expected = 1000
    const ok = Math.round(expected * ratio)

    days.push({
      date: date.toISOString().slice(0, 10),
      ratio,
      expected,
      ok,
      partial: i === 0,
      declared: false,
    })
  }

  return days
}
