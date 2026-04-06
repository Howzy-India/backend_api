/**
 * E2E tests for Resale Properties feature.
 *
 * These tests run against a live server (Firebase emulator or deployed).
 * Set BASE_URL env var to point to the target environment.
 *
 * Auth tokens for different roles should be set via env vars:
 *   CLIENT_TOKEN      – valid Firebase ID token for a client user
 *   ADMIN_TOKEN       – valid Firebase ID token for an admin user
 *   SUPER_ADMIN_TOKEN – valid Firebase ID token for a super_admin user
 */

import { test, expect, request as playwrightRequest } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5001";
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const SUPER_ADMIN_TOKEN = process.env.SUPER_ADMIN_TOKEN ?? "";

// Helper to build auth headers
const authHeader = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

// Shared state across tests within the suite
let clientSubmittedId: string;
let adminCreatedId: string;

// ── Public endpoints (unauthenticated) ───────────────────────────────────────

test.describe("GET /resale (public)", () => {
  test("returns 200 with resaleProperties array", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/resale`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("resaleProperties");
    expect(Array.isArray(body.resaleProperties)).toBe(true);
  });

  test("filters by city query param", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/resale?city=Mumbai`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const p of body.resaleProperties) {
      expect(p.city.toLowerCase()).toBe("mumbai");
    }
  });

  test("filters by type query param", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/resale?type=Apartment`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const p of body.resaleProperties) {
      expect(p.propertyType.toLowerCase()).toBe("apartment");
    }
  });
});

test.describe("GET /resale/:id (public)", () => {
  test("returns 404 for non-existent id", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/resale/non-existent-id-xyz`);
    expect(res.status()).toBe(404);
  });
});

// ── Client endpoints ──────────────────────────────────────────────────────────

test.describe("POST /resale (client submit)", () => {
  test.skip(!CLIENT_TOKEN, "CLIENT_TOKEN not set — skipping authenticated tests");

  test("rejects unauthenticated request with 401", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/resale`, {
      data: {
        title: "Test Property",
        price: 5000000,
        propertyType: "Apartment",
        city: "Hyderabad",
      },
    });
    expect([401, 403]).toContain(res.status());
  });

  test("returns 400 when title is missing", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/resale`, {
      headers: authHeader(CLIENT_TOKEN),
      data: {
        price: 5000000,
        propertyType: "Apartment",
        city: "Hyderabad",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title/i);
  });

  test("returns 400 for invalid propertyType", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/resale`, {
      headers: authHeader(CLIENT_TOKEN),
      data: {
        title: "Test",
        price: 5000000,
        propertyType: "InvalidType",
        city: "Hyderabad",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/propertyType/i);
  });

  test("returns 400 when price is negative", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/resale`, {
      headers: authHeader(CLIENT_TOKEN),
      data: {
        title: "Test",
        price: -100,
        propertyType: "Apartment",
        city: "Hyderabad",
      },
    });
    expect(res.status()).toBe(400);
  });

  test("creates resale property with Pending status and returns 201", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/resale`, {
      headers: authHeader(CLIENT_TOKEN),
      data: {
        title: "E2E Test Resale Apartment",
        description: "A beautiful 2BHK for resale",
        price: 7500000,
        propertyType: "Apartment",
        city: "Hyderabad",
        location: "Gachibowli",
        area: "1200 sqft",
        bedrooms: 2,
        bathrooms: 2,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.id).toBe("string");
    clientSubmittedId = body.id;
  });

  test("client can view their own submissions via GET /resale/mine", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/resale/mine`, {
      headers: authHeader(CLIENT_TOKEN),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("resaleProperties");
    expect(Array.isArray(body.resaleProperties)).toBe(true);
  });

  test("pending property is NOT visible in public GET /resale", async ({ request }) => {
    if (!clientSubmittedId) test.skip();
    const res = await request.get(`${BASE_URL}/resale`);
    const body = await res.json();
    const found = body.resaleProperties.find((p: any) => p.id === clientSubmittedId);
    expect(found).toBeUndefined();
  });
});

// ── Admin endpoints ───────────────────────────────────────────────────────────

test.describe("Admin resale endpoints", () => {
  test.skip(!ADMIN_TOKEN, "ADMIN_TOKEN not set — skipping admin tests");

  test("GET /admin/resale returns 403 for unauthenticated", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/admin/resale`);
    expect([401, 403]).toContain(res.status());
  });

  test("GET /admin/resale returns all resale properties for admin", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/admin/resale`, {
      headers: authHeader(ADMIN_TOKEN),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("resaleProperties");
    expect(Array.isArray(body.resaleProperties)).toBe(true);
  });

  test("GET /admin/resale filters by status=Pending", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/admin/resale?status=Pending`, {
      headers: authHeader(ADMIN_TOKEN),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const p of body.resaleProperties) {
      expect(p.status).toBe("Pending");
    }
  });

  test("Admin can directly create a Listed resale property via POST /admin/resale", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/admin/resale`, {
      headers: authHeader(ADMIN_TOKEN),
      data: {
        title: "Admin Direct Resale Villa",
        description: "Admin created villa",
        price: 15000000,
        propertyType: "Villa",
        city: "Bangalore",
        location: "Whitefield",
        area: "2800 sqft",
        bedrooms: 4,
        bathrooms: 3,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    adminCreatedId = body.id;
  });

  test("Admin-created property appears in public GET /resale immediately", async ({ request }) => {
    if (!adminCreatedId) test.skip();
    const res = await request.get(`${BASE_URL}/resale`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = body.resaleProperties.find((p: any) => p.id === adminCreatedId);
    expect(found).toBeDefined();
    expect(found.status).toBe("Listed");
  });

  test("Admin can view admin-created property via GET /resale/:id", async ({ request }) => {
    if (!adminCreatedId) test.skip();
    const res = await request.get(`${BASE_URL}/resale/${adminCreatedId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.resaleProperty.id).toBe(adminCreatedId);
  });

  test("Admin can approve a client-submitted property via PATCH /admin/resale/:id/status", async ({ request }) => {
    if (!clientSubmittedId) test.skip();
    const res = await request.patch(`${BASE_URL}/admin/resale/${clientSubmittedId}/status`, {
      headers: authHeader(ADMIN_TOKEN),
      data: { status: "Approved" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe("Listed");
  });

  test("Approved property appears in public GET /resale", async ({ request }) => {
    if (!clientSubmittedId) test.skip();
    const res = await request.get(`${BASE_URL}/resale`);
    const body = await res.json();
    const found = body.resaleProperties.find((p: any) => p.id === clientSubmittedId);
    expect(found).toBeDefined();
    expect(found.status).toBe("Listed");
  });

  test("Admin can reject a property via PATCH /admin/resale/:id/status", async ({ request }) => {
    if (!adminCreatedId) test.skip();
    const res = await request.patch(`${BASE_URL}/admin/resale/${adminCreatedId}/status`, {
      headers: authHeader(ADMIN_TOKEN),
      data: { status: "Rejected", remarks: "Does not meet criteria" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("returns 400 for invalid status in PATCH /admin/resale/:id/status", async ({ request }) => {
    if (!adminCreatedId) test.skip();
    const res = await request.patch(`${BASE_URL}/admin/resale/${adminCreatedId}/status`, {
      headers: authHeader(ADMIN_TOKEN),
      data: { status: "InvalidStatus" },
    });
    expect(res.status()).toBe(400);
  });

  test("Admin can update property details via PATCH /admin/resale/:id", async ({ request }) => {
    if (!adminCreatedId) test.skip();
    const res = await request.patch(`${BASE_URL}/admin/resale/${adminCreatedId}`, {
      headers: authHeader(ADMIN_TOKEN),
      data: { title: "Updated Villa Title", price: 16000000 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("PATCH /admin/resale/:id returns 404 for non-existent id", async ({ request }) => {
    const res = await request.patch(`${BASE_URL}/admin/resale/non-existent-xyz`, {
      headers: authHeader(ADMIN_TOKEN),
      data: { title: "Will fail" },
    });
    expect(res.status()).toBe(404);
  });
});

// ── Super Admin endpoints ─────────────────────────────────────────────────────

test.describe("Super Admin DELETE /admin/resale/:id", () => {
  test.skip(!SUPER_ADMIN_TOKEN, "SUPER_ADMIN_TOKEN not set — skipping super admin tests");

  test("Admin (non-super) cannot delete a resale property", async ({ request }) => {
    if (!adminCreatedId) test.skip();
    const res = await request.delete(`${BASE_URL}/admin/resale/${adminCreatedId}`, {
      headers: authHeader(ADMIN_TOKEN),
    });
    expect([403]).toContain(res.status());
  });

  test("Super admin can delete a resale property", async ({ request }) => {
    if (!adminCreatedId) test.skip();
    const res = await request.delete(`${BASE_URL}/admin/resale/${adminCreatedId}`, {
      headers: authHeader(SUPER_ADMIN_TOKEN),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("Deleted property returns 404 from public endpoint", async ({ request }) => {
    if (!adminCreatedId) test.skip();
    const res = await request.get(`${BASE_URL}/resale/${adminCreatedId}`);
    expect(res.status()).toBe(404);
  });
});
