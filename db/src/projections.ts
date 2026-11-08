/** Materialize scalar table rows without rewriting unchanged rows. Key order
 * cannot be used for equality: SDK rows follow schema order, not input order. */
export function syncRows<Row extends { id: string }>(target: {
  iter(): Iterable<Row>;
  id: { delete(id: string): unknown; update(row: Row): unknown };
  insert(row: Row): unknown;
}, rows: Row[]) {
  const current = new Map(Array.from(target.iter(), row => [row.id, row]));
  const nextIds = new Set(rows.map(row => row.id));
  for (const id of current.keys()) if (!nextIds.has(id)) target.id.delete(id);
  for (const row of rows) {
    const previous = current.get(row.id);
    if (!previous) target.insert(row);
    else {
      const old = previous as Record<string, unknown>;
      const equal = Object.keys(previous).length === Object.keys(row).length && Object.entries(row).every(([key, value]) => Object.is(old[key], value));
      if (!equal) target.id.update(row);
    }
  }
}
