export function toCsv(rows: (string | number)[][]) {
  const body = rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
        .join(","),
    )
    .join("\n");
  return `\uFEFF${body}`;
}
