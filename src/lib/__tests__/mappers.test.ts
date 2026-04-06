import {
  mapProjectDoc,
  mapSubmissionDoc,
  submissionToProperty,
  mapLeadDoc,
  mapEnquiryDoc,
  mapBookingDoc,
  mapLoginDoc,
  mapUserDoc,
  mapResaleDoc,
} from "../mappers";

// ── Mock Firestore QueryDocumentSnapshot ──────────────────────────────────────

function mockDoc(
  id: string,
  data: Record<string, any>
): FirebaseFirestore.QueryDocumentSnapshot {
  return {
    id,
    data: () => data,
  } as unknown as FirebaseFirestore.QueryDocumentSnapshot;
}

// ── mapProjectDoc ─────────────────────────────────────────────────────────────

describe("mapProjectDoc", () => {
  it("maps all fields from snake_case and camelCase", () => {
    const doc = mockDoc("proj-1", {
      uniqueId: "UID-1",
      rera_number: "RERA123",
      name: "Green Valley",
      developer_name: "ABC Builders",
      city: "Hyderabad",
      location: "Gachibowli",
      map_link: "https://maps.google.com",
      usp: "Best views",
      lead_registration_status: "Open",
      project_type: "Apartment",
      property_type: "residential",
      project_segment: "Premium",
      possession: "Dec 2025",
      availability: "2BHK",
      status: "Listed",
      teaser: "teaser text",
      details: "project details",
    });

    const result = mapProjectDoc(doc);

    expect(result.id).toBe("proj-1");
    expect(result.name).toBe("Green Valley");
    expect(result.reraNumber).toBe("RERA123");
    expect(result.developerName).toBe("ABC Builders");
    expect(result.city).toBe("Hyderabad");
    expect(result.propertyType).toBe("residential");
    expect(result.status).toBe("Listed");
    expect(result.possession).toBe("Dec 2025");
  });

  it("defaults propertyType to 'project' when absent", () => {
    const doc = mockDoc("p2", { name: "Test" });
    expect(mapProjectDoc(doc).propertyType).toBe("project");
  });

  it("defaults status to 'Listed' when absent", () => {
    const doc = mockDoc("p3", { name: "Test" });
    expect(mapProjectDoc(doc).status).toBe("Listed");
  });

  it("maps builderPoc from flat fields when builderPoc object absent", () => {
    const doc = mockDoc("p4", {
      builder_poc_name: "John",
      builder_poc_contact: "9999999999",
    });
    const result = mapProjectDoc(doc);
    expect(result.builderPoc).toEqual({ name: "John", contact: "9999999999" });
  });

  it("returns null for builderPoc when no POC data", () => {
    const doc = mockDoc("p5", {});
    expect(mapProjectDoc(doc).builderPoc).toBeNull();
  });

  it("returns empty strings for missing fields", () => {
    const doc = mockDoc("p6", {});
    const result = mapProjectDoc(doc);
    expect(result.name).toBe("");
    expect(result.city).toBe("");
    expect(result.usp).toBe("");
  });
});

// ── mapSubmissionDoc ──────────────────────────────────────────────────────────

describe("mapSubmissionDoc", () => {
  it("maps all fields correctly", () => {
    const doc = mockDoc("sub-1", {
      type: "Plot",
      name: "Sunrise Plots",
      email: "partner@example.com",
      status: "Approved",
      details: { city: "Pune" },
    });

    const result = mapSubmissionDoc(doc);
    expect(result.id).toBe("sub-1");
    expect(result.type).toBe("Plot");
    expect(result.name).toBe("Sunrise Plots");
    expect(result.email).toBe("partner@example.com");
    expect(result.status).toBe("Approved");
    expect(result.details).toEqual({ city: "Pune" });
  });

  it("defaults status to 'Pending' when absent", () => {
    const doc = mockDoc("sub-2", { type: "Farm Land" });
    expect(mapSubmissionDoc(doc).status).toBe("Pending");
  });

  it("defaults name and email to empty string when absent", () => {
    const doc = mockDoc("sub-3", {});
    const result = mapSubmissionDoc(doc);
    expect(result.name).toBe("");
    expect(result.email).toBe("");
    expect(result.type).toBe("");
  });

  it("coerces string details to object", () => {
    const doc = mockDoc("sub-4", {
      details: '{"price":"50L"}',
    });
    expect(mapSubmissionDoc(doc).details).toEqual({ price: "50L" });
  });
});

// ── submissionToProperty ──────────────────────────────────────────────────────

describe("submissionToProperty", () => {
  const baseSubmission = {
    id: "s1",
    type: "Plot",
    name: "Green Plot",
    email: "test@test.com",
    status: "Approved",
    details: { city: "Chennai", uniqueId: "PL-001", developerName: "Dev Co" },
    createdAt: "2024-01-01T00:00:00.000Z",
  };

  it("maps propertyType to farmland for Farm Land", () => {
    const result = submissionToProperty({ ...baseSubmission, type: "Farm Land" });
    expect(result.propertyType).toBe("farmland");
  });

  it("maps propertyType to plot for Plot", () => {
    const result = submissionToProperty(baseSubmission);
    expect(result.propertyType).toBe("plot");
  });

  it("maps propertyType to project for other types", () => {
    const result = submissionToProperty({ ...baseSubmission, type: "Residential" });
    expect(result.propertyType).toBe("project");
  });

  it("uses uniqueId from details", () => {
    expect(submissionToProperty(baseSubmission).uniqueId).toBe("PL-001");
  });

  it("falls back to submission id when no uniqueId in details", () => {
    const sub = { ...baseSubmission, details: {} };
    expect(submissionToProperty(sub).uniqueId).toBe("s1");
  });

  it("uses developerName from details", () => {
    expect(submissionToProperty(baseSubmission).developerName).toBe("Dev Co");
  });
});

// ── mapLeadDoc ────────────────────────────────────────────────────────────────

describe("mapLeadDoc", () => {
  it("maps camelCase and snake_case fields", () => {
    const doc = mockDoc("lead-1", {
      name: "Rahul",
      budget: "80L",
      location_preferred: "Banjara Hills",
      looking_bhk: "3BHK",
      contact: "9876543210",
      milestone: "Site Visit",
      assigned_to: "Agent A",
      status: "Hot",
    });

    const result = mapLeadDoc(doc);
    expect(result.id).toBe("lead-1");
    expect(result.name).toBe("Rahul");
    expect(result.location_preferred).toBe("Banjara Hills");
    expect(result.locationPreferred).toBe("Banjara Hills");
    expect(result.looking_bhk).toBe("3BHK");
    expect(result.lookingBhk).toBe("3BHK");
    expect(result.status).toBe("Hot");
  });

  it("defaults assigned_to to 'Unassigned'", () => {
    const doc = mockDoc("lead-2", {});
    expect(mapLeadDoc(doc).assigned_to).toBe("Unassigned");
  });

  it("defaults status to 'New'", () => {
    const doc = mockDoc("lead-3", {});
    expect(mapLeadDoc(doc).status).toBe("New");
  });

  it("sets documentUploaded to false by default", () => {
    const doc = mockDoc("lead-4", {});
    expect(mapLeadDoc(doc).documentUploaded).toBe(false);
  });

  it("sets documentUploaded to true when present", () => {
    const doc = mockDoc("lead-5", { document_uploaded: true });
    expect(mapLeadDoc(doc).documentUploaded).toBe(true);
  });
});

// ── mapEnquiryDoc ─────────────────────────────────────────────────────────────

describe("mapEnquiryDoc", () => {
  it("maps all enquiry fields", () => {
    const doc = mockDoc("enq-1", {
      client_name: "Priya",
      phone: "9000000001",
      email: "priya@test.com",
      property_id: "PROP-1",
      property_name: "Skyline Apartments",
      property_type: "Apartment",
      location: "Pune",
      enquiry_type: "Buy",
      source: "Website",
      status: "New",
      priority: "High",
      assigned_to: "Sales A",
    });

    const result = mapEnquiryDoc(doc);
    expect(result.id).toBe("enq-1");
    expect(result.client_name).toBe("Priya");
    expect(result.clientName).toBe("Priya");
    expect(result.propertyName).toBe("Skyline Apartments");
    expect(result.enquiry_type).toBe("Buy");
    expect(result.enquiryType).toBe("Buy");
    expect(result.priority).toBe("High");
  });

  it("defaults status to 'New'", () => {
    const doc = mockDoc("enq-2", {});
    expect(mapEnquiryDoc(doc).status).toBe("New");
  });

  it("defaults assigned_to to empty string", () => {
    const doc = mockDoc("enq-3", {});
    expect(mapEnquiryDoc(doc).assigned_to).toBe("");
  });
});

// ── mapBookingDoc ─────────────────────────────────────────────────────────────

describe("mapBookingDoc", () => {
  it("maps booking fields", () => {
    const doc = mockDoc("book-1", {
      client_name: "Amit",
      property_name: "Sea View Villa",
      ticket_value: 5000000,
      invoice_stage: "Token",
      currency: "INR",
    });

    const result = mapBookingDoc(doc);
    expect(result.clientName).toBe("Amit");
    expect(result.propertyName).toBe("Sea View Villa");
    expect(result.ticketValue).toBe(5000000);
    expect(result.invoiceStage).toBe("Token");
    expect(result.currency).toBe("INR");
  });

  it("defaults ticketValue to 0", () => {
    const doc = mockDoc("book-2", {});
    expect(mapBookingDoc(doc).ticketValue).toBe(0);
  });

  it("defaults currency to INR", () => {
    const doc = mockDoc("book-3", {});
    expect(mapBookingDoc(doc).currency).toBe("INR");
  });
});

// ── mapLoginDoc ───────────────────────────────────────────────────────────────

describe("mapLoginDoc", () => {
  it("maps login fields with snake_case and camelCase", () => {
    const doc = mockDoc("login-1", {
      email: "user@test.com",
      phone: "9000000000",
      device_type: "Mobile",
      browser: "Chrome",
      ip_address: "192.168.1.1",
      location: "Hyderabad",
      status: "Success",
    });

    const result = mapLoginDoc(doc);
    expect(result.email).toBe("user@test.com");
    expect(result.device_type).toBe("Mobile");
    expect(result.deviceType).toBe("Mobile");
    expect(result.browser).toBe("Chrome");
    expect(result.status).toBe("Success");
  });

  it("defaults device_type to 'Unknown'", () => {
    const doc = mockDoc("login-2", {});
    expect(mapLoginDoc(doc).device_type).toBe("Unknown");
  });

  it("defaults browser to 'Unknown'", () => {
    const doc = mockDoc("login-3", {});
    expect(mapLoginDoc(doc).browser).toBe("Unknown");
  });

  it("defaults status to 'Success'", () => {
    const doc = mockDoc("login-4", {});
    expect(mapLoginDoc(doc).status).toBe("Success");
  });
});

// ── mapUserDoc ────────────────────────────────────────────────────────────────

describe("mapUserDoc", () => {
  it("maps user fields", () => {
    const doc = mockDoc("user-1", {
      name: "Kiran",
      email: "kiran@howzy.in",
      role: "partner",
      location: "Mumbai",
      expertise: "Commercial",
      active_leads: 5,
    });

    const result = mapUserDoc(doc);
    expect(result.id).toBe("user-1");
    expect(result.name).toBe("Kiran");
    expect(result.email).toBe("kiran@howzy.in");
    expect(result.role).toBe("partner");
    expect(result.location).toBe("Mumbai");
    expect(result.expertise).toBe("Commercial");
    expect(result.activeLeads).toBe(5);
  });

  it("defaults expertise to 'Residential'", () => {
    const doc = mockDoc("user-2", {});
    expect(mapUserDoc(doc).expertise).toBe("Residential");
  });

  it("defaults role and name to empty strings", () => {
    const doc = mockDoc("user-3", {});
    const result = mapUserDoc(doc);
    expect(result.name).toBe("");
    expect(result.role).toBe("");
  });

  it("defaults activeLeads to 0", () => {
    const doc = mockDoc("user-4", {});
    expect(mapUserDoc(doc).activeLeads).toBe(0);
  });
});

// ── mapResaleDoc ──────────────────────────────────────────────────────────────

describe("mapResaleDoc", () => {
  it("maps all fields correctly", () => {
    const doc = mockDoc("resale-1", {
      title: "3BHK Sea View Apartment",
      description: "Beautiful apartment with sea view",
      price: 8500000,
      propertyType: "Apartment",
      city: "Mumbai",
      location: "Bandra",
      mapLink: "https://maps.google.com/test",
      area: "1400 sqft",
      bedrooms: 3,
      bathrooms: 2,
      floor: 5,
      totalFloors: 12,
      amenities: ["Gym", "Pool"],
      possession: "Immediate",
      images: ["https://img.example.com/1.jpg"],
      submittedBy: "client@example.com",
      submittedByUid: "uid-123",
      submittedByRole: "client",
      status: "Listed",
      remarks: null,
      approvedBy: "admin@howzy.in",
    });

    const result = mapResaleDoc(doc);

    expect(result.id).toBe("resale-1");
    expect(result.title).toBe("3BHK Sea View Apartment");
    expect(result.price).toBe(8500000);
    expect(result.propertyType).toBe("Apartment");
    expect(result.city).toBe("Mumbai");
    expect(result.location).toBe("Bandra");
    expect(result.area).toBe("1400 sqft");
    expect(result.bedrooms).toBe(3);
    expect(result.bathrooms).toBe(2);
    expect(result.floor).toBe(5);
    expect(result.totalFloors).toBe(12);
    expect(result.amenities).toEqual(["Gym", "Pool"]);
    expect(result.possession).toBe("Immediate");
    expect(result.images).toEqual(["https://img.example.com/1.jpg"]);
    expect(result.submittedBy).toBe("client@example.com");
    expect(result.submittedByUid).toBe("uid-123");
    expect(result.submittedByRole).toBe("client");
    expect(result.status).toBe("Listed");
    expect(result.approvedBy).toBe("admin@howzy.in");
  });

  it("defaults status to 'Pending' when absent", () => {
    const doc = mockDoc("resale-2", { title: "Test Property" });
    expect(mapResaleDoc(doc).status).toBe("Pending");
  });

  it("defaults price to 0 when absent", () => {
    const doc = mockDoc("resale-3", {});
    expect(mapResaleDoc(doc).price).toBe(0);
  });

  it("defaults amenities and images to empty arrays when absent", () => {
    const doc = mockDoc("resale-4", {});
    const result = mapResaleDoc(doc);
    expect(result.amenities).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("defaults optional fields to null when absent", () => {
    const doc = mockDoc("resale-5", {});
    const result = mapResaleDoc(doc);
    expect(result.mapLink).toBeNull();
    expect(result.bedrooms).toBeNull();
    expect(result.bathrooms).toBeNull();
    expect(result.floor).toBeNull();
    expect(result.totalFloors).toBeNull();
    expect(result.possession).toBeNull();
    expect(result.remarks).toBeNull();
    expect(result.approvedBy).toBeNull();
  });

  it("defaults submittedByRole to 'client' when absent", () => {
    const doc = mockDoc("resale-6", {});
    expect(mapResaleDoc(doc).submittedByRole).toBe("client");
  });

  it("defaults title and description to empty strings when absent", () => {
    const doc = mockDoc("resale-7", {});
    const result = mapResaleDoc(doc);
    expect(result.title).toBe("");
    expect(result.description).toBe("");
    expect(result.city).toBe("");
  });
});
