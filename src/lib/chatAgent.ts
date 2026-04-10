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
    name: "create_enquiry",
    description:
      "Create an enquiry on behalf of the logged-in user for a specific property they are interested in. Call this when the user expresses clear interest (e.g., 'I want to know more', 'book a site visit', 'contact developer'). Do NOT call unless the user explicitly shows interest.",
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
2. COLLECT DEMOGRAPHICS (naturally, one at a time, don't make it feel like a form):
   a. Ask their name: "May I know your name please?"
   b. Ask their phone number: "Could you share your mobile number so our team can reach you?"
   c. Ask their city/location: "Which city or area are you looking to buy in?"
3. COLLECT QUERY DETAILS:
   a. Property type (Apartment, Villa, Plot, Farm Land, Commercial, etc.)
   b. Budget range
   c. BHK/size preference (if applicable)
   d. Purpose: self-use, investment, rental
   e. Timeline: how soon they want to buy
4. SEARCH AND PRESENT RESULTS: Once you have at least type + location, call search_properties.
   - Present top 3-5 matches: name, location, type, price, possession date
   - Be enthusiastic about good matches
5. GENERATE ENQUIRY: When user shows interest in any property, call create_enquiry to register their lead.
   - After creating: "Great choice! Our property advisor will call you within 24 hours."

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

export interface ProcessMessageResult {
  reply: string;
  tool_results?: {
    properties?: SafeProperty[];
    enquiry_id?: string;
  };
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
    model: "gemini-1.5-flash",
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

  while (response.functionCalls()?.length) {
    const calls = response.functionCalls()!;
    const functionResponses: FunctionResponsePart[] = [];

    for (const call of calls) {
      let toolOutput: unknown;

      if (call.name === "search_properties") {
        const searchResult = await executeSearchProperties(
          call.args as { type?: string; location?: string; city?: string; q?: string }
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
      } else if (call.name === "create_enquiry") {
        const enquiryResult = await executeCreateEnquiry(
          call.args as {
            property_id: string;
            property_name: string;
            property_type?: string;
            location?: string;
          },
          user
        );
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
  return { reply, tool_results: Object.keys(toolResults).length ? toolResults : undefined };
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
    created_at: data.created_at ?? null,
    updated_at: data.updated_at ?? null,
    messages: (data.messages ?? []) as ChatMessage[],
    enquiry_ids: data.enquiry_ids ?? [],
  };
}
