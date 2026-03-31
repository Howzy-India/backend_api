import { Timestamp } from "./firestore";

export const toISODate = (
  value?: FirebaseFirestore.Timestamp | Date | string | null
): string | null => {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
};

export const coerceDetails = (details: unknown): Record<string, any> => {
  if (!details) return {};
  if (typeof details === "string") {
    try {
      return JSON.parse(details);
    } catch {
      return {};
    }
  }
  if (typeof details === "object") return details as Record<string, any>;
  return {};
};

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

export const formatCurrency = (value: number) =>
  currencyFormatter.format(value || 0);

export const chunkArray = <T>(items: T[], size = 10): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

export const allowedSubmissionTypes = new Set([
  "Farm Land",
  "Plot",
  "Project",
  "Residential",
  "Commercial",
]);
