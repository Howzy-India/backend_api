// Mock firestore module to provide a proper Timestamp class for instanceof checks
class MockTimestamp {
  private _date: Date;
  constructor(date: Date) { this._date = date; }
  toDate() { return this._date; }
}

jest.mock("../firestore", () => ({
  Timestamp: MockTimestamp,
  db: {},
  auth: {},
  storage: {},
  FieldValue: {},
  collections: {},
}));

import {
  toISODate,
  coerceDetails,
  formatCurrency,
  chunkArray,
  allowedSubmissionTypes,
} from "../helpers";

// ── toISODate ─────────────────────────────────────────────────────────────────

describe("toISODate", () => {
  it("returns null for null input", () => {
    expect(toISODate(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(toISODate(undefined)).toBeNull();
  });

  it("returns the string as-is when given an ISO string", () => {
    const iso = "2024-01-15T10:30:00.000Z";
    expect(toISODate(iso)).toBe(iso);
  });

  it("returns ISO string when given a Date object", () => {
    const date = new Date("2024-06-01T00:00:00.000Z");
    expect(toISODate(date)).toBe("2024-06-01T00:00:00.000Z");
  });

  it("handles Firestore Timestamp with toDate()", () => {
    const ts = new MockTimestamp(new Date("2024-03-15T12:00:00.000Z")) as any;
    expect(toISODate(ts)).toBe("2024-03-15T12:00:00.000Z");
  });
});

// ── coerceDetails ─────────────────────────────────────────────────────────────

describe("coerceDetails", () => {
  it("returns empty object for null", () => {
    expect(coerceDetails(null)).toEqual({});
  });

  it("returns empty object for undefined", () => {
    expect(coerceDetails(undefined)).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(coerceDetails("")).toEqual({});
  });

  it("parses valid JSON string", () => {
    expect(coerceDetails('{"city":"Hyderabad","price":"50L"}')).toEqual({
      city: "Hyderabad",
      price: "50L",
    });
  });

  it("returns empty object for invalid JSON string", () => {
    expect(coerceDetails("not json")).toEqual({});
  });

  it("returns the object when already an object", () => {
    const obj = { foo: "bar", count: 42 };
    expect(coerceDetails(obj)).toEqual(obj);
  });

  it("returns empty object for number primitive", () => {
    expect(coerceDetails(123)).toEqual({});
  });

  it("handles nested JSON string", () => {
    const nested = JSON.stringify({ a: { b: 1 } });
    expect(coerceDetails(nested)).toEqual({ a: { b: 1 } });
  });
});

// ── formatCurrency ────────────────────────────────────────────────────────────

describe("formatCurrency", () => {
  it("formats a positive number in INR", () => {
    const result = formatCurrency(1000000);
    expect(result).toContain("10,00,000");
  });

  it("formats zero", () => {
    const result = formatCurrency(0);
    expect(result).toContain("0");
  });

  it("handles NaN-like 0 default", () => {
    const result = formatCurrency(0);
    expect(typeof result).toBe("string");
  });

  it("includes currency symbol", () => {
    const result = formatCurrency(500);
    expect(result).toMatch(/₹|INR/);
  });
});

// ── chunkArray ────────────────────────────────────────────────────────────────

describe("chunkArray", () => {
  it("splits array into chunks of given size", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns single chunk when array is smaller than size", () => {
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("returns empty array for empty input", () => {
    expect(chunkArray([], 5)).toEqual([]);
  });

  it("defaults to chunk size of 10", () => {
    const arr = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunkArray(arr);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[1]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
  });

  it("handles chunk size equal to array length", () => {
    expect(chunkArray([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("works with string arrays", () => {
    expect(chunkArray(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});

// ── allowedSubmissionTypes ────────────────────────────────────────────────────

describe("allowedSubmissionTypes", () => {
  it("contains Farm Land", () => {
    expect(allowedSubmissionTypes.has("Farm Land")).toBe(true);
  });

  it("contains Plot", () => {
    expect(allowedSubmissionTypes.has("Plot")).toBe(true);
  });

  it("contains Project", () => {
    expect(allowedSubmissionTypes.has("Project")).toBe(true);
  });

  it("contains Residential", () => {
    expect(allowedSubmissionTypes.has("Residential")).toBe(true);
  });

  it("contains Commercial", () => {
    expect(allowedSubmissionTypes.has("Commercial")).toBe(true);
  });

  it("does not contain unknown types", () => {
    expect(allowedSubmissionTypes.has("Villa")).toBe(false);
    expect(allowedSubmissionTypes.has("")).toBe(false);
    expect(allowedSubmissionTypes.has("partner")).toBe(false);
  });
});
