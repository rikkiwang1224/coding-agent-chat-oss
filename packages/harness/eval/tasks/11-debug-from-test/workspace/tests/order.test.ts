import { buildOrder, type Order } from "../src/index.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

function assertClose(actual: number, expected: number, msg: string) {
  if (Math.abs(actual - expected) > 0.01) {
    console.error(`FAIL: ${msg} — got ${actual}, expected ${expected}`);
    process.exit(1);
  }
}

// Test 1: No discount (quantity < 10)
const order1 = buildOrder("ORD-001", [
  { productId: "SKU-A", unitPrice: 25.0, quantity: 5 },
]);
assert(order1.lines[0].discountPercent === 0, "order1 line discount should be 0%");
assertClose(order1.lines[0].lineTotal, 125.0, "order1 line total");
assertClose(order1.subtotal, 125.0, "order1 subtotal");
assertClose(order1.tax, 10.0, "order1 tax (8%)");
assertClose(order1.total, 135.0, "order1 total");

// Test 2: 5% discount (quantity = 10)
const order2 = buildOrder("ORD-002", [
  { productId: "SKU-B", unitPrice: 10.0, quantity: 10 },
]);
assert(order2.lines[0].discountPercent === 5, "order2 line discount should be 5%");
assertClose(order2.lines[0].lineTotal, 95.0, "order2 line total");

// Test 3: 15% discount (quantity = 50)
// 50 units @ $20 = $1000 before discount
// With 15% off: $20 * 0.85 = $17 per unit → $850 total
const order3 = buildOrder("ORD-003", [
  { productId: "SKU-C", unitPrice: 20.0, quantity: 50 },
]);
assert(order3.lines[0].discountPercent === 15, "order3 line discount should be 15%");
assertClose(order3.lines[0].lineTotal, 850.0, "order3 line total for 50 units @ $20");

// Test 4: Multi-line order
const order4 = buildOrder("ORD-004", [
  { productId: "SKU-A", unitPrice: 50.0, quantity: 100 },  // 20% off → $40 * 100 = $4000
  { productId: "SKU-B", unitPrice: 30.0, quantity: 5 },    // no discount → $30 * 5 = $150
]);
assertClose(order4.subtotal, 4150.0, "order4 subtotal");
assertClose(order4.tax, 332.0, "order4 tax");
assertClose(order4.total, 4482.0, "order4 total");

console.log("All order tests passed!");
