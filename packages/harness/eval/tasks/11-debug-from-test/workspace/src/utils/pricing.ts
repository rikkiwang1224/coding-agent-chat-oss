// Pricing rules for the order system
export interface PricingRule {
  minQuantity: number;
  discountPercent: number;
}

const BULK_DISCOUNT_RULES: PricingRule[] = [
  { minQuantity: 100, discountPercent: 20 },
  { minQuantity: 50, discountPercent: 10 },
  { minQuantity: 20, discountPercent: 10 },
  { minQuantity: 10, discountPercent: 5 },
];

/**
 * Calculate discount percentage based on quantity.
 * Rules are checked from highest threshold down.
 * Returns 0 if no rule matches.
 */
export function getDiscountPercent(quantity: number): number {
  for (const rule of BULK_DISCOUNT_RULES) {
    if (quantity >= rule.minQuantity) {
      return rule.discountPercent;
    }
  }
  return 0;
}

/**
 * Apply discount to a unit price.
 * Returns the discounted price per unit.
 */
export function applyDiscount(unitPrice: number, discountPercent: number): number {
  return unitPrice * (1 - discountPercent / 100);
}
