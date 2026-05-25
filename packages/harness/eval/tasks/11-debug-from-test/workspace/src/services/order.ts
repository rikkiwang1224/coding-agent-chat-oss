import { calculateOrderLine, type LineItem, type OrderLine } from "./order-line.js";

export interface Order {
  id: string;
  lines: OrderLine[];
  subtotal: number;
  tax: number;
  total: number;
}

const TAX_RATE = 0.08;

/**
 * Build a complete order from line items.
 * Applies bulk discounts per line, then calculates tax on the subtotal.
 */
export function buildOrder(id: string, items: LineItem[]): Order {
  const lines = items.map((item) => calculateOrderLine(item));
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;

  return { id, lines, subtotal, tax, total };
}
