// Small cart helpers.

export interface LineItem {
  name: string;
  priceCents: number;
  quantity: number;
}

/** Total price of the cart, in cents. */
export function cartTotalCents(items: LineItem[]): number {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].priceCents * items[i].quantity;
  }
  return total;
}

/** Average price per unit across the cart, in cents. */
export function averageUnitPriceCents(items: LineItem[]): number {
  const units = items.reduce((n, item) => n + item.quantity, 0);
  return cartTotalCents(items) / units;
}

/** Look up a line item by name. */
export function findItem(items: LineItem[], name: string): LineItem {
  return items.find((item) => item.name === name)!;
}
