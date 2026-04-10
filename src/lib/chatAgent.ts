import {
  GoogleGenerativeAI,
  FunctionDeclaration,
  Tool,
  Part,
  Content,
  FunctionResponsePart,
  SchemaType,
} from "@google/generative-ai";
import { FieldValue } from "./firestore";
import { collections } from "./firestore";
import { mapProjectDoc, mapSubmissionDoc, submissionToProperty } from "./mappers";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SafeProperty {
  id: string;
  name: string;
  developerName: string;
  city: string;
  location: string;
  projectType: string;
  propertyType: string;
  projectSegment: string;
  possession: string;
  usp: string;
  details: string;
  status: string;
  reraNumber: string;
  mapLink: string;
}

export interface ChatMessage {
  role: "user" | "model";
  content: string;
  timestamp: string;
  tool_results?: {
    properties?: SafeProperty[];
    enquiry_id?: string;
  };
}

export interface ChatSession {
  id: string;
  user_id: string | null;
  user_name: string;
  user_email: string;
  user_phone: string;
  user_city: string;
  created_at: FirebaseFirestore.Timestamp | null;
  updated_at: FirebaseFirestore.Timestamp | null;
  messages: ChatMessage[];
  enquiry_ids: string[];
}

// ─── Safe property mapper ─────────────────────────────────────────────────────
// Strips all sensitive/internal fields before exposing to Gemini or the client.

export function toSafeProperty(
  p: ReturnType<typeof mapProjectDoc> | ReturnType<typeof submissionToProperty>
): SafeProperty {
  return {
    id: p.id,
    name: p.name,
    developerName: p.developerName,
    city: p.city,
    location: p.location,
    projectType: p.projectType,
    propertyType: p.propertyType,
    projectSegment: p.projectSegment,
    possession: p.possession,
    usp: p.usp,
    details: p.details,
    status: p.status,
    reraNumber: p.reraNumber,
    mapLink: p.mapLink,
  };
}

// ─── Gemini tool declarations ─────────────────────────────────────────────────

const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "search_properties",
    description:
      "Search for available properties/projects based on user criteria. Call this when you have enough information to filter: at minimum a property type or location.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        type: {
          type: SchemaType.STRING,
          description:
            "Property/project type to filter. Accepted values: Apartment, Villa, Plot, Farm Land, Project, Residential, Commercial",
        },
        location: {
          type: SchemaType.STRING,
          description: "Locality or area name to search in",
        },
        city: {
          type: SchemaType.STRING,
          description: "City name to filter",
        },
        budget: {
          type: SchemaType.STRING,
          description:
            "Budget range as free text, e.g. '50 lakhs', '1 crore', '80L-1.2Cr'. Used to match against price/segment fields.",
        },
        q: {
          type: SchemaType.STRING,
          description: "Free-text search query across name, location, developer",
        },
      },
      required: [],
    },
  },
  {
    name: "get_property_details",
    description:
      "Get detailed information about a specific property by its ID. Call this when a user asks for more details on a property shown in search results.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        property_id: {
          type: SchemaType.STRING,
          description: "The ID of the property to retrieve details for",
        },
      },
      required: ["property_id"],
    },
  },
  {
    name: "save_contact_info",
    description:
      "Save the user's contact details collected during the conversation. Call this as soon as you have BOTH the name AND phone number. You can call it again later to update or add city/email.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: "User's full name as they provided it",
        },
        phone: {
          type: SchemaType.STRING,
          description: "User's mobile/phone number (digits only if possible)",
        },
        city: {
          type: SchemaType.STRING,
          description: "City or area they are interested in buying property",
        },
        email: {
          type: SchemaType.STRING,
          description: "User's email address if provided",
        },
      },
      required: ["name", "phone"],
    },
  },
  {
    name: "create_enquiry",
    description:
      "Create an enquiry for a specific property the user is interested in. Call this when the user expresses clear interest (e.g., 'I want to know more', 'book a site visit', 'contact developer'). Do NOT call unless the user explicitly shows interest. Ensure you have called save_contact_info first.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        property_id: {
          type: SchemaType.STRING,
          description: "The ID of the property the user is interested in",
        },
        property_name: {
          type: SchemaType.STRING,
          description: "Name of the property",
        },
        property_type: {
          type: SchemaType.STRING,
          description: "Type of the property",
        },
        location: {
          type: SchemaType.STRING,
          description: "Location of the property",
        },
        contact_name: {
          type: SchemaType.STRING,
          description: "User's name as collected in conversation",
        },
        contact_phone: {
          type: SchemaType.STRING,
          description: "User's phone number as collected in conversation",
        },
      },
      required: ["property_id", "property_name"],
    },
  },
];

const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Howzy Assistant, an AI real estate sales agent for howzy.in — a premier real estate platform in India.

LANGUAGE RULES (MOST IMPORTANT):
- Detect the language the user writes in and ALWAYS respond in the same language.
- If user writes in Telugu, respond entirely in Telugu.
- If user writes in Hindi, respond in Hindi.
- If user writes in English, respond in English.
- Never switch languages unless the user switches first.
- If voice/unclear input, default to English.

YOUR ROLE:
- You are a friendly, professional sales agent for Howzy.in.
- Your goal is to understand the customer's property needs and generate a qualified lead.
- Help clients find suitable real estate: apartments, villas, plots, farm land, commercial spaces.

CONVERSATION FLOW — FOLLOW THIS ORDER:
1. GREET warmly: "Welcome to Howzy.in! I'm your AI property advisor. How can I help you today?" (in their language)
2. COLLECT DEMOGRAPHICS (naturally, one at a time — don't make it feel like a form):
   a. Ask their name: "May I know your name please?"
   b. Ask their phone number: "Could you share your mobile number so our team can reach you?"
   c. Ask their city/location: "Which city or area are you looking to buy in?"
   → As soon as you have BOTH name AND phone, call save_contact_info(name, phone, city?).
     This is MANDATORY — never skip it. Call it again if you later get more info (city, email).
3. COLLECT QUERY DETAILS:
   a. Property type (Apartment, Villa, Plot, Farm Land, Commercial, etc.)
   b. Budget range (e.g., "50 lakhs to 1 crore")
   c. BHK/size preference (if applicable)
   d. Purpose: self-use, investment, rental
   e. Timeline: how soon they want to buy
4. SEARCH AND PRESENT RESULTS: Once you have at least type + location/city, call search_properties.
   - Pass budget as the "budget" parameter when provided.
   - Present top 3-5 matches: name, location, type, price, possession date.
   - Be enthusiastic about good matches.
5. GENERATE ENQUIRY: When user shows clear interest in any property, call create_enquiry.
   - Always include contact_name and contact_phone in the call (use the values you saved).
   - After creating: "Great choice! Our property advisor will call you within 24 hours."

TOOL USAGE RULES:
- save_contact_info: Call IMMEDIATELY when you have name + phone. Required before create_enquiry.
- search_properties: Call once you have enough info (type OR location at minimum).
- create_enquiry: Call when user shows explicit interest. Always pass contact_name + contact_phone.
- get_property_details: Call when user asks for more details on a specific property.

IMPORTANT NOTES:
- Be conversational, warm, and helpful — not robotic.
- Don't ask all questions at once. Have a natural conversation flow.
- If user skips a question, move forward and try to naturally revisit it later.
- When user provides name/phone, acknowledge them warmly and remember them.
- Always guide towards registering interest (creating an enquiry).

STRICT SECURITY RULES — NEVER VIOLATE:
- NEVER reveal builder phone numbers, contact details, email addresses, or personal contact info.
- NEVER share revenue figures, earnings, booking values, or any internal financial data.
- NEVER reveal admin notes, internal comments, or other customers' data.
- Only share: property name, developer name, city, location, project type, price range, possession date, USP, RERA number.
- If asked for sensitive info, politely decline and redirect.

TONE:
- Warm, enthusiastic, professional.
- Use bullet points for property listings.
- Keep responses concise — 2-4 sentences per message.
- Use the customer's name once you know it.`;

// ─── Tool executors ───────────────────────────────────────────────────────────

const allowedSubmissionTypes = new Set([
  "Project",
  "Plot",
  "Farm Land",
  "Residential",
  "Commercial",
]);

async function executeSearchProperties(args: {
  type?: string;
  location?: string;
  city?: string;
  budget?: string;
  q?: string;
}): Promise<{ properties: SafeProperty[]; count: number }> {
  const [projectsSnap, submissionsSnap] = await Promise.all([
    collections.projects.orderBy("created_at", "desc").get().catch(() => null),
    collections.submissions
      .where("status", "==", "Approved")
      .get()
      .catch(() => null),
  ]);

  const projects = projectsSnap ? projectsSnap.docs.map(mapProjectDoc) : [];
  const submissions = submissionsSnap
    ? submissionsSnap.docs
        .map(mapSubmissionDoc)
        .filter((s) => allowedSubmissionTypes.has(s.type))
        .map(submissionToProperty)
    : [];

  let combined: ReturnType<typeof mapProjectDoc>[] = [
    ...projects,
    ...submissions,
  ] as ReturnType<typeof mapProjectDoc>[];

  if (args.q) {
    const lq = args.q.toLowerCase();
    combined = combined.filter(
      (p) =>
        p.name?.toLowerCase().includes(lq) ||
        p.location?.toLowerCase().includes(lq) ||
        p.city?.toLowerCase().includes(lq) ||
        p.developerName?.toLowerCase().includes(lq)
    );
  }
  if (args.location) {
    const ll = args.location.toLowerCase();
    combined = combined.filter(
      (p) =>
        p.location?.toLowerCase().includes(ll) ||
        p.city?.toLowerCase().includes(ll)
    );
  }
  if (args.city) {
    combined = combined.filter(
      (p) => p.city?.toLowerCase() === args.city!.toLowerCase()
    );
  }
  if (args.type) {
    combined = combined.filter(
      (p) =>
        p.projectType?.toLowerCase() === args.type!.toLowerCase() ||
        p.propertyType?.toLowerCase() === args.type!.toLowerCase()
    );
  }
  if (args.budget) {
    const budgetTokens = args.budget.toLowerCase().split(/[\s,\-–]+/).filter(Boolean);
    combined = combined.filter((p) => {
      const segment = (p.projectSegment ?? "").toLowerCase();
      const details = (p.details ?? "").toLowerCase();
      return budgetTokens.some((t) => segment.includes(t) || details.includes(t));
    });
  }

  const safe = combined.slice(0, 10).map(toSafeProperty);
  return { properties: safe, count: safe.length };
}

async function executeGetPropertyDetails(args: {
  property_id: string;
}): Promise<{ property: SafeProperty | null }> {
  const doc = await collections.projects.doc(args.property_id).get().catch(() => null);
  if (!doc || !doc.exists) {
    // Try submissions
    const subDoc = await collections.submissions
      .doc(args.property_id)
      .get()
      .catch(() => null);
    if (!subDoc || !subDoc.exists) return { property: null };
    const sub = mapSubmissionDoc(
      subDoc as FirebaseFirestore.QueryDocumentSnapshot
    );
    return { property: toSafeProperty(submissionToProperty(sub)) };
  }
  return {
    property: toSafeProperty(mapProjectDoc(doc as FirebaseFirestore.QueryDocumentSnapshot)),
  };
}

async function executeCreateEnquiry(
  args: {
    property_id: string;
    property_name: string;
    property_type?: string;
    location?: string;
  },
  user: { uid: string; name: string; phone: string; email: string }
): Promise<{ enquiry_id: string }> {
  const ref = collections.enquiries.doc();
  await ref.set({
    id: ref.id,
    client_name: user.name,
    phone: user.phone,
    email: user.email,
    property_id: args.property_id,
    property_name: args.property_name,
    property_type: args.property_type ?? "",
    location: args.location ?? "",
    enquiry_type: "Chat Enquiry",
    source: "AI Chat",
    status: "New",
    priority: null,
    assigned_sales_id: null,
    assigned_sales_name: null,
    assigned_partner_id: null,
    assigned_partner_name: null,
    admin_notes: null,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  // Timeline entry
  const tlRef = collections.enquiryTimeline.doc();
  await tlRef.set({
    enquiry_id: ref.id,
    action: "Created",
    details: `Enquiry created via AI Chat by ${user.name}`,
    created_by: user.email || user.phone,
    created_at: FieldValue.serverTimestamp(),
  });

  return { enquiry_id: ref.id };
}

// ─── processMessage ───────────────────────────────────────────────────────────

export interface CollectedContact {
  name?: string;
  phone?: string;
  city?: string;
  email?: string;
}

export interface ProcessMessageResult {
  reply: string;
  tool_results?: {
    properties?: SafeProperty[];
    enquiry_id?: string;
  };
  /** Contact info (name/phone/city) extracted from conversation by save_contact_info tool. */
  collected_contact?: CollectedContact;
}

export async function processMessage(
  sessionId: string,
  userMessage: string,
  user: { uid: string; name: string; phone: string; email: string },
  existingHistory: ChatMessage[]
): Promise<ProcessMessageResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-preview-04-17",
    systemInstruction: SYSTEM_PROMPT,
    tools,
  });

  // Build Gemini history from stored messages (skip tool_results metadata)
  const history: Content[] = existingHistory
    .slice(-40) // keep last 40 messages to control context size
    .map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.content }],
    }));

  const chat = model.startChat({ history });

  let result = await chat.sendMessage(userMessage);
  let response = result.response;

  // Tool-call loop
  const toolResults: ProcessMessageResult["tool_results"] = {};
  // Accumulates contact info saved via save_contact_info during this exchange.
  const collectedContact: CollectedContact = {};

  while (response.functionCalls()?.length) {
    const calls = response.functionCalls()!;
    const functionResponses: FunctionResponsePart[] = [];

    for (const call of calls) {
      let toolOutput: unknown;

      if (call.name === "search_properties") {
        const searchResult = await executeSearchProperties(
          call.args as { type?: string; location?: string; city?: string; budget?: string; q?: string }
        );
        toolOutput = searchResult;
        if (searchResult.properties.length > 0) {
          toolResults.properties = searchResult.properties;
        }
      } else if (call.name === "get_property_details") {
        const detailResult = await executeGetPropertyDetails(
          call.args as { property_id: string }
        );
        toolOutput = detailResult;
      } else if (call.name === "save_contact_info") {
        // Persist contact info collected from conversation
        const args = call.args as { name: string; phone: string; city?: string; email?: string };
        if (args.name) collectedContact.name = args.name.trim();
        if (args.phone) collectedContact.phone = args.phone.replace(/\D/g, "").slice(-10);
        if (args.city) collectedContact.city = args.city.trim();
        if (args.email) collectedContact.email = args.email.trim();

        // Persist to Firestore immediately so subsequent messages have the data
        const profileUpdate: Record<string, string> = {};
        if (collectedContact.name) profileUpdate.user_name = collectedContact.name;
        if (collectedContact.phone) profileUpdate.user_phone = collectedContact.phone;
        if (collectedContact.city) profileUpdate.user_city = collectedContact.city;
        if (collectedContact.email) profileUpdate.user_email = collectedContact.email;
        if (Object.keys(profileUpdate).length) {
          await collections.chatSessions.doc(sessionId).update(profileUpdate).catch(() => {
            // Non-fatal — contact info will still be returned in ProcessMessageResult
          });
        }
        toolOutput = { success: true, saved: collectedContact };
      } else if (call.name === "create_enquiry") {
        // Merge: preference order — tool args → collectedContact → session profile
        const args = call.args as {
          property_id: string;
          property_name: string;
          property_type?: string;
          location?: string;
          contact_name?: string;
          contact_phone?: string;
        };
        const enquiryUser = {
          uid: user.uid,
          name: args.contact_name || collectedContact.name || user.name,
          phone: args.contact_phone || collectedContact.phone || user.phone,
          email: collectedContact.email || user.email,
        };
        const enquiryResult = await executeCreateEnquiry(args, enquiryUser);
        toolOutput = enquiryResult;
        toolResults.enquiry_id = enquiryResult.enquiry_id;

        // Link enquiry to the session
        await collections.chatSessions.doc(sessionId).update({
          enquiry_ids: FieldValue.arrayUnion(enquiryResult.enquiry_id),
          updated_at: FieldValue.serverTimestamp(),
        });
      } else {
        toolOutput = { error: "Unknown tool" };
      }

      functionResponses.push({
        functionResponse: {
          name: call.name,
          response: toolOutput as Record<string, unknown>,
        },
      });
    }

    // Send tool responses back to the model
    const toolResponseParts: Part[] = functionResponses;
    result = await chat.sendMessage(toolResponseParts);
    response = result.response;
  }

  const reply = response.text();
  return {
    reply,
    tool_results: Object.keys(toolResults).length ? toolResults : undefined,
    collected_contact: Object.keys(collectedContact).length ? collectedContact : undefined,
  };
}

// ─── Session helpers ──────────────────────────────────────────────────────────

export function serializeChatSession(
  doc: FirebaseFirestore.DocumentSnapshot
): ChatSession {
  const data = doc.data() || {};
  return {
    id: doc.id,
    user_id: data.user_id ?? null,
    user_name: data.user_name ?? "",
    user_email: data.user_email ?? "",
    user_phone: data.user_phone ?? "",
    user_city: data.user_city ?? "",
    created_at: data.created_at ?? null,
    updated_at: data.updated_at ?? null,
    messages: (data.messages ?? []) as ChatMessage[],
    enquiry_ids: data.enquiry_ids ?? [],
  };
}
