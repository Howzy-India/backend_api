import { toSafeProperty, serializeChatSession } from "../chatAgent";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFullProperty() {
  return {
    id: "prop-1",
    uniqueId: "UID-1",
    name: "Prestige Towers",
    developerName: "Prestige Group",
    city: "Hyderabad",
    location: "Gachibowli",
    mapLink: "https://maps.google.com/?q=gachibowli",
    usp: "Prime location with pool",
    leadRegistrationStatus: "Registered", // sensitive — must be stripped
    projectType: "Apartment",
    propertyType: "project",
    projectSegment: "₹80L - ₹1.2Cr",
    possession: "Dec 2026",
    availability: null,
    builderPoc: { name: "John Doe", contact: "+91 9876543210" }, // sensitive — must be stripped
    status: "Listed",
    teaser: "Luxury living at its finest",
    details: "2BHK and 3BHK apartments with premium amenities",
    reraNumber: "P02400001234",
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

// ── toSafeProperty ─────────────────────────────────────────────────────────────

describe("toSafeProperty", () => {
  it("includes all safe fields", () => {
    const safe = toSafeProperty(makeFullProperty() as any);

    expect(safe.id).toBe("prop-1");
    expect(safe.name).toBe("Prestige Towers");
    expect(safe.developerName).toBe("Prestige Group");
    expect(safe.city).toBe("Hyderabad");
    expect(safe.location).toBe("Gachibowli");
    expect(safe.projectType).toBe("Apartment");
    expect(safe.propertyType).toBe("project");
    expect(safe.projectSegment).toBe("₹80L - ₹1.2Cr");
    expect(safe.possession).toBe("Dec 2026");
    expect(safe.usp).toBe("Prime location with pool");
    expect(safe.details).toBe("2BHK and 3BHK apartments with premium amenities");
    expect(safe.status).toBe("Listed");
    expect(safe.reraNumber).toBe("P02400001234");
    expect(safe.mapLink).toBe("https://maps.google.com/?q=gachibowli");
  });

  it("strips builderPoc (contact details)", () => {
    const safe = toSafeProperty(makeFullProperty() as any);
    expect((safe as any).builderPoc).toBeUndefined();
  });

  it("strips leadRegistrationStatus (internal field)", () => {
    const safe = toSafeProperty(makeFullProperty() as any);
    expect((safe as any).leadRegistrationStatus).toBeUndefined();
  });

  it("strips createdAt (internal timestamp)", () => {
    const safe = toSafeProperty(makeFullProperty() as any);
    expect((safe as any).createdAt).toBeUndefined();
  });

  it("strips teaser (internal promotional text)", () => {
    const safe = toSafeProperty(makeFullProperty() as any);
    expect((safe as any).teaser).toBeUndefined();
  });

  it("strips uniqueId (internal ID)", () => {
    const safe = toSafeProperty(makeFullProperty() as any);
    expect((safe as any).uniqueId).toBeUndefined();
  });

  it("only has exactly the allowed keys", () => {
    const safe = toSafeProperty(makeFullProperty() as any);
    const allowedKeys = new Set([
      "id",
      "name",
      "developerName",
      "city",
      "location",
      "projectType",
      "propertyType",
      "projectSegment",
      "possession",
      "usp",
      "details",
      "status",
      "reraNumber",
      "mapLink",
    ]);
    const actualKeys = Object.keys(safe);
    for (const key of actualKeys) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });
});

// ── serializeChatSession ───────────────────────────────────────────────────────

function mockSessionDoc(
  id: string,
  data: Record<string, any>
): FirebaseFirestore.DocumentSnapshot {
  return {
    id,
    data: () => data,
    exists: true,
  } as unknown as FirebaseFirestore.DocumentSnapshot;
}

describe("serializeChatSession", () => {
  it("serializes all session fields", () => {
    const now = new Date();
    const doc = mockSessionDoc("sess-1", {
      user_id: "uid-abc",
      user_name: "Ravi Kumar",
      user_phone: "9876543210",
      created_at: now,
      updated_at: now,
      messages: [
        {
          role: "user",
          content: "Hello",
          timestamp: now.toISOString(),
        },
      ],
      enquiry_ids: ["enq-1"],
    });

    const session = serializeChatSession(doc);

    expect(session.id).toBe("sess-1");
    expect(session.user_id).toBe("uid-abc");
    expect(session.user_name).toBe("Ravi Kumar");
    expect(session.user_phone).toBe("9876543210");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[0].content).toBe("Hello");
    expect(session.enquiry_ids).toEqual(["enq-1"]);
  });

  it("defaults to empty values for missing fields", () => {
    const doc = mockSessionDoc("sess-2", {});
    const session = serializeChatSession(doc);

    expect(session.user_id).toBe("");
    expect(session.user_name).toBe("");
    expect(session.user_phone).toBe("");
    expect(session.messages).toEqual([]);
    expect(session.enquiry_ids).toEqual([]);
    expect(session.created_at).toBeNull();
    expect(session.updated_at).toBeNull();
  });
});
