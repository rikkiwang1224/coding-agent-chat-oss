export function fibonacci(n: number): number {
  // BUG: should return 1 for n=1, but returns 0
  if (n <= 1) return 0;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
