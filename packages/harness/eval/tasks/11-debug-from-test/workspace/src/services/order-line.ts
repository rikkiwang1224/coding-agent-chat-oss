import { getDiscountPercent, applyDiscount } from "../utils/pricing.js";

export interface LineItem {
  productId: string;
  unitPrice: number;
  quantity: number;
}

export interface OrderLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  lineTotal: number;
}

/**
 * Calculate a single order line with bulk discount applied.
 */
export function calculateOrderLine(item: LineItem): OrderLine {
  const discountPercent = getDiscountPercent(item.quantity);
  const discountedPrice = applyDiscount(item.unitPrice, discountPercent);
  const lineTotal = discountedPrice * item.quantity;

  return {
    productId: item.productId,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    discountPercent,
    lineTotal: Math.round(lineTotal * 100) / 100,
  };
}
