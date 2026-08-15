/**
 * Minimal RFC4180 CSV, enough for the calibration files.
 *
 * Quoted fields, doubled quotes inside them, CRLF, and `#` comment lines, which
 * addresses.csv uses to record the benchmark cases that could NOT be found.
 */

export type CsvRow = Record<string, string>

function splitLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
    } else {
      field += char
    }
  }

  fields.push(field)
  return fields.map((value) => value.trim())
}

export function parseCsv(text: string): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))

  const header = lines.shift()
  if (header === undefined) return []
  const columns = splitLine(header)

  return lines.map((line) => {
    const values = splitLine(line)
    const row: CsvRow = {}
    columns.forEach((column, index) => {
      row[column] = values[index] ?? ''
    })
    return row
  })
}

function escapeField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function toCsv(rows: CsvRow[], columns: string[]): string {
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => escapeField(row[column] ?? '')).join(','))
  }
  return `${lines.join('\n')}\n`
}
