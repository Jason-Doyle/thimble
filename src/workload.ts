import type { JsonDocument, JsonValue } from "./core.js";

export type WorkloadProfile = {
  name: "tiny" | "small";
  products: number;
  customers: number;
  orders: number;
  pointReads: number;
  catalogueScans: number;
  updates: number;
  concurrentWrites: number;
  checkouts: number;
};

export type StoreDataset = {
  products: JsonDocument[];
  customers: JsonDocument[];
  orders: JsonDocument[];
};

export const workloadProfiles: Record<
  WorkloadProfile["name"],
  WorkloadProfile
> = {
  tiny: {
    name: "tiny",
    products: 128,
    customers: 32,
    orders: 96,
    pointReads: 40,
    catalogueScans: 3,
    updates: 20,
    concurrentWrites: 16,
    checkouts: 8,
  },
  small: {
    name: "small",
    products: 512,
    customers: 128,
    orders: 512,
    pointReads: 100,
    catalogueScans: 5,
    updates: 50,
    concurrentWrites: 40,
    checkouts: 20,
  },
};

const categories = [
  "home",
  "outdoors",
  "office",
  "electronics",
  "hobbies",
  "clothing",
];

const adjectives = [
  "Compact",
  "Reliable",
  "Everyday",
  "Classic",
  "Portable",
  "Durable",
  "Simple",
  "Modern",
];

const nouns = [
  "Lamp",
  "Bottle",
  "Notebook",
  "Speaker",
  "Backpack",
  "Keyboard",
  "Planter",
  "Jacket",
];

export function generateStoreDataset(
  profile: WorkloadProfile,
  seed = 42,
): StoreDataset {
  const random = mulberry32(seed);
  const products = Array.from({ length: profile.products }, (_, index) =>
    productDocument(index, random),
  );
  const customers = Array.from({ length: profile.customers }, (_, index) =>
    customerDocument(index, random),
  );
  const orders = Array.from({ length: profile.orders }, (_, index) =>
    orderDocument(index, products, customers, random),
  );

  return { products, customers, orders };
}

export function updatedProduct(
  product: JsonDocument,
  revision: number,
): JsonDocument {
  const currentPrice =
    typeof product.priceCents === "number" ? product.priceCents : 0;
  return {
    ...structuredClone(product),
    priceCents: currentPrice + revision + 1,
    updatedAt: new Date(1_700_000_000_000 + revision * 1_000).toISOString(),
  };
}

export function checkoutOrder(
  index: number,
  product: JsonDocument,
  customer: JsonDocument,
): JsonDocument {
  const price =
    typeof product.priceCents === "number" ? product.priceCents : 0;
  return {
    id: `checkout-${index.toString().padStart(5, "0")}`,
    customerId: customer.id,
    status: "paid",
    createdAt: new Date(1_710_000_000_000 + index * 60_000).toISOString(),
    totalCents: price,
    items: [
      {
        productId: product.id,
        quantity: 1,
        priceCents: price,
      },
    ],
  };
}

function productDocument(
  index: number,
  random: () => number,
): JsonDocument {
  const adjective = pick(adjectives, random);
  const noun = pick(nouns, random);
  const category = pick(categories, random);
  return {
    id: `product-${index.toString().padStart(5, "0")}`,
    sku: `SKU-${(10_000 + index).toString()}`,
    name: `${adjective} ${noun}`,
    category,
    priceCents: 500 + Math.floor(random() * 25_000),
    stock: 5 + Math.floor(random() * 200),
    active: random() > 0.05,
    tags: [category, adjective.toLowerCase(), noun.toLowerCase()],
    description:
      `${adjective} ${noun} for a small online store. ` +
      "This representative description adds enough payload to expose read and write amplification.",
    createdAt: new Date(1_680_000_000_000 + index * 86_400_000).toISOString(),
  };
}

function customerDocument(
  index: number,
  random: () => number,
): JsonDocument {
  const number = index.toString().padStart(5, "0");
  return {
    id: `customer-${number}`,
    email: `customer-${number}@example.test`,
    name: `Customer ${number}`,
    marketingOptIn: random() > 0.65,
    createdAt: new Date(1_675_000_000_000 + index * 43_200_000).toISOString(),
    address: {
      line1: `${100 + index} Sample Street`,
      city: pick(["Dublin", "Belfast", "Cork", "Galway"], random),
      postalCode: `A${number.slice(-4)}`,
      country: "IE",
    },
  };
}

function orderDocument(
  index: number,
  products: JsonDocument[],
  customers: JsonDocument[],
  random: () => number,
): JsonDocument {
  const itemCount = 1 + Math.floor(random() * 3);
  const items: JsonValue[] = [];
  let totalCents = 0;

  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const product = pick(products, random);
    const price =
      typeof product.priceCents === "number" ? product.priceCents : 0;
    const quantity = 1 + Math.floor(random() * 3);
    totalCents += price * quantity;
    items.push({
      productId: product.id,
      quantity,
      priceCents: price,
    });
  }

  return {
    id: `order-${index.toString().padStart(6, "0")}`,
    customerId: pick(customers, random).id,
    status: pick(["paid", "shipped", "delivered"], random),
    totalCents,
    items,
    createdAt: new Date(1_700_000_000_000 + index * 120_000).toISOString(),
  };
}

function pick<T>(values: T[], random: () => number): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error("Cannot pick from an empty array");
  }
  return value;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
