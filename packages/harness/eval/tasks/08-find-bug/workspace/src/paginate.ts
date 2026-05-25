export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  // BUG: uses page instead of page * pageSize for start index
  const start = page;
  const end = start + pageSize;
  return items.slice(start, end);
}
