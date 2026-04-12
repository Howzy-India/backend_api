import { onRequest } from "firebase-functions/v2/https";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomInt, randomUUID } from "node:crypto";
import { google } from "googleapis";
import { collections, FieldValue, db, storage, auth } from "../lib/firestore";
import {
  mapProjectDoc,
  mapProjectRow,
  mapSubmissionDoc,
  submissionToProperty,
  mapLeadDoc,
  mapEnquiryDoc,
  mapBookingDoc,
  mapLoginDoc,
  mapUserDoc,
  mapResaleDoc,
} from "../lib/mappers";
import {
  allowedSubmissionTypes,
  chunkArray,
  formatCurrency,
  toISODate,
} from "../lib/helpers";
import { requireAuth, requireAdmin, requireRole, optionalAuth } from "../middleware/auth";
import {
  processMessage,
  serializeChatSession,
  ChatMessage,
} from "../lib/chatAgent";
import { query, queryOne, withTransaction } from "../lib/db";
import { upsertProjectRow } from "../lib/sheetsBackup";
import type { CreateProjectInput, UpdateProjectInput } from "../types/project";

const ALLOWED_ORIGINS = [
  "https://howzy-web.web.app",
  "https://howzy-web.firebaseapp.com",
  // Add custom domain here when configured, e.g. "https://app.howzy.in"
];

const app = express();

// Handle preflight OPTIONS for all routes before any auth middleware
app.options("*", cors({ origin: ALLOWED_ORIGINS, credentials: true }));

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server calls (no origin) and listed origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-bootstrap-key"],
  })
);
app.use(express.json({ limit: "10mb" })); // 10mb to handle base64 attendance photos
app.use(cookieParser());

// ── Helpers ───────────────────────────────────────────────────────────

const isPermissionDeniedError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("PERMISSION_DENIED") ||
    message.includes("Missing or insufficient permissions")
  );
};

const isAdminRole = (role?: string) =>
  role === "admin" || role === "super_admin";

const ensurePropertyExists = async (propertyId?: string | null) => {
  if (!propertyId) return true;
  const [projectDoc, submissionDoc] = await Promise.all([
    collections.projects.doc(propertyId).get(),
    collections.submissions.doc(propertyId).get(),
  ]);
  return projectDoc.exists || submissionDoc.exists;
};

const addTimelineEntry = async ({
  enquiryId,
  action,
  details,
  createdBy,
}: {
  enquiryId: string;
  action: string;
  details?: string | null;
  createdBy: string;
}) => {
  const docRef = collections.enquiryTimeline.doc();
  await docRef.set({
    enquiry_id: enquiryId,
    action,
    details: details ?? null,
    created_by: createdBy,
    created_at: FieldValue.serverTimestamp(),
  });
};

const getGoogleOAuthClient = (redirectUri: string) =>
  new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

const ensureGoogleAuth = (req: express.Request, res: express.Response) => {
  const accessToken = req.cookies.google_access_token;
  const refreshToken = req.cookies.google_refresh_token;
  if (!accessToken && !refreshToken) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return oauth2Client;
};

class ApiHttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

type AdminUserStatus = "active" | "disabled";

const isAdminUserStatus = (value: unknown): value is AdminUserStatus =>
  value === "active" || value === "disabled";

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const assertManageableAdminUser = async (uid: string) => {
  if (!uid) {
    throw new ApiHttpError(400, "uid is required");
  }

  // Pending admins (not yet logged in) only exist in Firestore
  const userDoc = await collections.users.doc(uid).get();
  if (!userDoc.exists) {
    throw new ApiHttpError(404, "User not found");
  }

  const existingRole = userDoc.data()?.role as string | undefined;

  // For real Firebase Auth users, also check custom claims
  if (!uid.startsWith("pending_")) {
    try {
      const authUser = await auth.getUser(uid);
      const claimRole = authUser.customClaims?.role as string | undefined;
      if ((claimRole ?? existingRole) !== "admin") {
        throw new ApiHttpError(400, "Only admin users can be managed from this endpoint");
      }
    } catch (err) {
      if (err instanceof ApiHttpError) throw err;
      // Auth user not found — fall through to Firestore role check
    }
  }

  if (existingRole !== "admin") {
    throw new ApiHttpError(400, "Only admin users can be managed from this endpoint");
  }
};

const buildAdminAuthUpdate = (payload: {
  email?: unknown;
  password?: unknown;
  displayName?: unknown;
  status?: unknown;
}) => {
  const authUpdate: {
    email?: string;
    password?: string;
    displayName?: string;
    disabled?: boolean;
  } = {};

  const email = nonEmpty(payload.email);
  if (email) authUpdate.email = email;

  const password = nonEmpty(payload.password);
  if (password) authUpdate.password = password;

  const displayName = nonEmpty(payload.displayName);
  if (displayName) authUpdate.displayName = displayName;

  if (isAdminUserStatus(payload.status)) {
    authUpdate.disabled = payload.status === "disabled";
  }

  return authUpdate;
};

const buildAdminFirestoreUpdate = ({
  authUpdate,
  status,
  updatedBy,
}: {
  authUpdate: { email?: string; displayName?: string };
  status?: unknown;
  updatedBy?: string;
}) => {
  const firestoreUpdate: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy,
  };

  if (authUpdate.email) firestoreUpdate.email = authUpdate.email;
  if (authUpdate.displayName) {
    firestoreUpdate.displayName = authUpdate.displayName;
    firestoreUpdate.name = authUpdate.displayName;
  }
  if (isAdminUserStatus(status)) {
    firestoreUpdate.status = status;
  }

  return firestoreUpdate;
};

const handleAdminUserApiError = (
  action: string,
  error: unknown,
  res: express.Response
) => {
  if (error instanceof ApiHttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error(`Error ${action}:`, error);
  res.status(500).json({ error: `Failed to ${action}` });
};

/** Normalize a phone string to E.164, also return raw digits and pendingId. */
const parsePhone = (phone: unknown): { digits: string; normalizedPhone: string; pendingId: string } | null => {
  const raw = typeof phone === "string" ? phone : "";
  const digits = raw.replaceAll(/\D/g, "");
  if (!digits) return null;
  const normalizedPhone = digits.length === 10 ? `+91${digits}` : `+${digits}`;
  if (!/^\+\d{10,15}$/.test(normalizedPhone)) return null;
  const pendingId = digits.length === 10 ? `pending_91${digits}` : `pending_${digits}`;
  return { digits, normalizedPhone, pendingId };
};

/** Check if a phone number already exists (pending doc or Firebase Auth user). */
const checkPhoneConflict = async (pendingId: string, normalizedPhone: string): Promise<string | null> => {
  const [pendingSnap, existingFirebaseUser] = await Promise.allSettled([
    collections.users.doc(pendingId).get(),
    auth.getUserByPhoneNumber(normalizedPhone),
  ]);
  if (pendingSnap.status === "fulfilled" && pendingSnap.value.exists) {
    return "A user with this phone number already exists";
  }
  if (existingFirebaseUser.status === "fulfilled") {
    return "A user with this phone number already exists in the system";
  }
  return null;
};

/** Map a Firestore user document to a standard list-item shape for admin APIs. */
const toUserListItem = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
  const data = doc.data();
  const isPending = doc.id.startsWith("pending_");
  return {
    uid: doc.id,
    name: data.displayName ?? data.name ?? "",
    displayName: data.displayName ?? data.name ?? "",
    email: data.email ?? "",
    phone: data.phone ?? "",
    role: data.role ?? "",
    status: isPending ? "pending" : (data.status ?? "active"),
    createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
  };
};

/** Validate phone, check conflicts, create a pending user doc, and send 201. Returns false if already responded with an error. */
const createPendingUser = async (
  params: { name: unknown; phone: unknown; role: string; email?: unknown; createdBy?: string },
  res: express.Response
): Promise<boolean> => {
  const { name, phone, role, email, createdBy } = params;
  if (!name || !phone) {
    res.status(400).json({ error: "name and phone are required" });
    return false;
  }
  const parsed = parsePhone(phone);
  if (!parsed) {
    res.status(400).json({ error: "Invalid phone number format" });
    return false;
  }
  const { normalizedPhone, pendingId } = parsed;
  const conflict = await checkPhoneConflict(pendingId, normalizedPhone);
  if (conflict) {
    res.status(409).json({ error: conflict });
    return false;
  }
  const doc: Record<string, unknown> = {
    name: String(name).trim(),
    displayName: String(name).trim(),
    phone: normalizedPhone,
    role,
    status: "active",
    createdBy,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (email) doc.email = String(email).trim();
  await collections.users.doc(pendingId).set(doc);
  res.status(201).json({ success: true, pendingId, phone: normalizedPhone });
  return true;
};

// ── Health ────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  try {
    await db.collection("__health__").limit(1).get();
    res.json({ status: "ok", firestore: "connected" });
  } catch (err: any) {
    res.status(500).json({ status: "degraded", firestore: "error", detail: err?.message ?? String(err) });
  }
});

// ── Projects ─────────────────────────────────────────────────────────

app.get("/projects", optionalAuth, async (req, res) => {
  try {
    const {
      location,
      type,
      city,
      zone,
      q,
      after,
      limit: limitStr,
      status,
    } = req.query as Record<string, string>;

    const limit = Math.min(Number(limitStr) || 50, 200);
    const callerRole = req.user?.role;
    const isAdminCaller = callerRole === "super_admin" || callerRole === "admin";

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status && isAdminCaller) {
      params.push(status.toUpperCase());
      conditions.push(`p.status = $${params.length}`);
    } else if (callerRole === "super_admin") {
      conditions.push("p.status != 'INACTIVE'");
    } else {
      conditions.push("p.status NOT IN ('INACTIVE', 'PENDING_APPROVAL')");
    }

    if (city) {
      params.push(city);
      conditions.push(`p.city ILIKE $${params.length}`);
    }
    if (zone) {
      params.push(zone.toUpperCase());
      conditions.push(`p.zone = $${params.length}`);
    }
    if (type) {
      params.push(type.toUpperCase().replaceAll(/\s+/g, ""));
      conditions.push(`p.property_type = $${params.length}`);
    }
    if (location) {
      params.push(`%${location}%`);
      conditions.push(`p.location ILIKE $${params.length}`);
    }
    if (q) {
      params.push(q);
      conditions.push(
        `to_tsvector('english', p.name || ' ' || p.developer_name || ' ' || COALESCE(p.location,''))
         @@ plainto_tsquery('english', $${params.length})`
      );
    }
    if (after) {
      params.push(after);
      conditions.push(`p.created_at < (SELECT created_at FROM projects WHERE id = $${params.length})`);
    }

    params.push(limit);
    const whereClause = conditions.join(" AND ");

    const sql = `
      SELECT
        p.*,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object(
            'id', c.id, 'bhk_count', c.bhk_count,
            'min_sft', c.min_sft, 'max_sft', c.max_sft, 'unit_count', c.unit_count
          )) FILTER (WHERE c.id IS NOT NULL), '[]'
        ) AS configurations,
        COALESCE(
          json_agg(jsonb_build_object(
            'id', ph.id, 'url', ph.url, 'display_order', ph.display_order
          ) ORDER BY ph.display_order) FILTER (WHERE ph.id IS NOT NULL), '[]'
        ) AS photos,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', pa.id, 'amenity', pa.amenity))
          FILTER (WHERE pa.id IS NOT NULL), '[]'
        ) AS amenities
      FROM projects p
      LEFT JOIN configurations c ON c.project_id = p.id
      LEFT JOIN project_photos ph ON ph.project_id = p.id
      LEFT JOIN project_amenities pa ON pa.project_id = p.id
      WHERE ${whereClause}
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT $${params.length}
    `;

    const rows = await query(sql, params);
    const projects = rows.map((row: any) => mapProjectRow({
      ...row,
      configurations: row.configurations ?? [],
      photos: row.photos ?? [],
      amenities: row.amenities ?? [],
    }));

    res.json({ projects, total: projects.length });
  } catch (error: any) {
    console.error("Error fetching projects:", error);
    res.status(500).json({ error: "Failed to fetch projects", detail: error?.message ?? String(error) });
  }
});

// Single project by ID (public)
app.get("/projects/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `
      SELECT
        p.*,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object(
            'id', c.id, 'bhk_count', c.bhk_count,
            'min_sft', c.min_sft, 'max_sft', c.max_sft, 'unit_count', c.unit_count
          )) FILTER (WHERE c.id IS NOT NULL), '[]'
        ) AS configurations,
        COALESCE(
          json_agg(jsonb_build_object(
            'id', ph.id, 'url', ph.url, 'display_order', ph.display_order
          ) ORDER BY ph.display_order) FILTER (WHERE ph.id IS NOT NULL), '[]'
        ) AS photos,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', pa.id, 'amenity', pa.amenity))
          FILTER (WHERE pa.id IS NOT NULL), '[]'
        ) AS amenities
      FROM projects p
      LEFT JOIN configurations c ON c.project_id = p.id
      LEFT JOIN project_photos ph ON ph.project_id = p.id
      LEFT JOIN project_amenities pa ON pa.project_id = p.id
      WHERE (p.id::text = $1 OR p.unique_id = $1) AND p.status != 'INACTIVE'
      GROUP BY p.id
    `;

    const row: any = await queryOne(sql, [id]);

    if (row) {
      return res.json({
        project: mapProjectRow({
          ...row,
          configurations: row.configurations ?? [],
          photos: row.photos ?? [],
          amenities: row.amenities ?? [],
        }),
      });
    }

    return res.status(404).json({ error: "Project not found" });
  } catch (error) {
    console.error("Error fetching project:", error);
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

// Public stats (property counts, cities, types)
app.get("/public/stats", async (_req, res) => {
  try {
    const [projectsSnapshot, submissionsSnapshot] = await Promise.all([
      collections.projects.get().catch((error) => {
        if (isPermissionDeniedError(error)) {
          console.warn(
            "Projects read denied while fetching public stats. Returning empty stats."
          );
          return null;
        }
        throw error;
      }),
      collections.submissions
        .where("status", "==", "Approved")
        .get()
        .catch((error) => {
          if (isPermissionDeniedError(error)) {
            console.warn(
              "Submissions read denied while fetching public stats. Returning projects-only stats."
            );
            return null;
          }
          throw error;
        }),
    ]);

    const projects = projectsSnapshot ? projectsSnapshot.docs.map(mapProjectDoc) : [];
    const submissions = submissionsSnapshot
      ? submissionsSnapshot.docs
          .map(mapSubmissionDoc)
          .filter((s) => allowedSubmissionTypes.has(s.type))
          .map(submissionToProperty)
      : [];

    const all = [...projects, ...submissions];

    const cities = [...new Set(all.map((p) => p.city).filter(Boolean))];
    const types = [...new Set(all.map((p) => p.projectType).filter(Boolean))];

    res.json({
      totalProjects: all.length,
      cities,
      propertyTypes: types,
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── Leads ────────────────────────────────────────────────────────────

app.get("/leads", ...requireAdmin, async (_req, res) => {
  try {
    const snapshot = await collections.leads
      .orderBy("created_at", "desc")
      .get()
      .catch(() => collections.leads.get())
      .catch(() => null);
    const leads = snapshot ? snapshot.docs.map(mapLeadDoc) : [];
    res.json({ leads });
  } catch (error) {
    console.error("Error fetching leads:", error);
    res.json({ leads: [] });
  }
});

app.post("/leads", async (req, res) => {
  try {
    const {
      name,
      budget,
      location_preferred,
      locationPreferred,
      looking_bhk,
      lookingBhk,
      contact,
      milestone,
      project_id,
      document_uploaded,
      status,
      campaign_source,
      campaign_name,
    } = req.body;

    const docRef = collections.leads.doc();
    await docRef.set({
      id: docRef.id,
      name,
      budget,
      location_preferred: location_preferred ?? locationPreferred ?? "",
      looking_bhk: looking_bhk ?? lookingBhk ?? "",
      contact,
      milestone,
      project_id: project_id ?? "",
      document_uploaded: Boolean(document_uploaded),
      status: status ?? "New",
      campaign_source: campaign_source ?? "",
      campaign_name: campaign_name ?? "",
      assigned_to: "Unassigned",
      created_at: FieldValue.serverTimestamp(),
    });

    res.json({ success: true, id: docRef.id });
  } catch (error) {
    console.error("Error creating lead:", error);
    res.status(500).json({ error: "Failed to create lead" });
  }
});

app.post("/leads/auto-assign", ...requireAdmin, async (_req, res) => {
  try {
    const partnersSnapshot = await collections.users
      .where("role", "==", "partner")
      .get();
    if (partnersSnapshot.empty) {
      res
        .status(400)
        .json({ error: "No partners available for assignment." });
      return;
    }
    const partners = partnersSnapshot.docs.map(mapUserDoc);

    const unassignedSnapshot = await collections.leads
      .where("assigned_to", "==", "Unassigned")
      .get();
    const batch = db.batch();
    let assignedCount = 0;

    unassignedSnapshot.docs.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot, index) => {
      const partner = partners[index % partners.length];
      batch.update(doc.ref, {
        assigned_to: partner.name,
        updated_at: FieldValue.serverTimestamp(),
      });
      assignedCount++;
    });

    if (assignedCount === 0) {
      res.json({ success: true, assignedCount: 0 });
      return;
    }

    await batch.commit();
    res.json({ success: true, assignedCount });
  } catch (error) {
    console.error("Error auto-assigning leads:", error);
    res.status(500).json({ error: "Failed to auto-assign leads" });
  }
});

// ── Earnings ─────────────────────────────────────────────────────────

app.get("/earnings", ...requireAdmin, async (_req, res) => {
  try {
    const snapshot = await collections.bookings
      .orderBy("created_at", "desc")
      .get()
      .catch(() => collections.bookings.get());
    const bookings = snapshot.docs.map(mapBookingDoc);
    const totalValue = bookings.reduce((sum, booking) => {
      const ticketValue =
        typeof booking.ticketValue === "number"
          ? booking.ticketValue
          : Number(String(booking.ticketValue).replaceAll(/[^0-9.-]/g, "")) ||
            0;
      return sum + ticketValue;
    }, 0);

    res.json({
      totalBookingsMonth: bookings.length,
      totalEarningValue: totalValue,
      totalEarningValueFormatted: formatCurrency(totalValue),
      bookings,
    });
  } catch (error) {
    console.error("Error fetching earnings:", error);
    res.status(500).json({ error: "Failed to fetch earnings" });
  }
});

// ── Submissions ──────────────────────────────────────────────────────

app.get("/submissions", requireAuth, async (req, res) => {
  try {
    const userRole = req.user?.role;
    const requesterEmail = req.user?.email?.toLowerCase();
    const isAdmin = isAdminRole(userRole);
    const email = req.query.email as string | undefined;
    const normalizedEmail = email?.toLowerCase();

    if (!isAdmin) {
      if (!requesterEmail) {
        res.status(400).json({ error: "Email not found in token" });
        return;
      }
      if (normalizedEmail && normalizedEmail !== requesterEmail) {
        res.status(403).json({ error: "Forbidden: can only access own submissions" });
        return;
      }
    }

    const effectiveEmail = isAdmin ? normalizedEmail : requesterEmail;
    let query: FirebaseFirestore.Query = collections.submissions;
    if (effectiveEmail) {
      query = query.where("email", "==", effectiveEmail);
    }
    query = query.orderBy("created_at", "desc");
    const snapshot = await query
      .get()
      .catch((error) => {
        if (isPermissionDeniedError(error)) {
          console.warn("Submissions read denied. Returning empty submissions list.");
          return null;
        }
        if (effectiveEmail) {
          return collections.submissions
            .where("email", "==", effectiveEmail)
            .get()
            .catch((fallbackError) => {
              if (isPermissionDeniedError(fallbackError)) {
                console.warn("Submissions read denied on fallback. Returning empty submissions list.");
                return null;
              }
              throw fallbackError;
            });
        }
        return collections.submissions.get().catch((fallbackError) => {
          if (isPermissionDeniedError(fallbackError)) {
            console.warn("Submissions read denied on fallback. Returning empty submissions list.");
            return null;
          }
          throw fallbackError;
        });
      });
    if (!snapshot) {
      res.json({ submissions: [] });
      return;
    }
    const submissions = snapshot.docs.map(mapSubmissionDoc).map((s) => ({
      ...s,
      date: s.createdAt ? s.createdAt.split("T")[0] : null,
    }));
    res.json({ submissions });
  } catch (error) {
    console.error("Error fetching submissions:", error);
    res.status(500).json({ error: "Failed to fetch submissions" });
  }
});

app.post("/submissions", async (req, res) => {
  try {
    const { type, name, email, details } = req.body;
    const docRef = collections.submissions.doc();
    await docRef.set({
      id: docRef.id,
      type,
      name,
      email,
      status: "Pending",
      details: details ?? {},
      created_at: FieldValue.serverTimestamp(),
    });
    res.json({ success: true, id: docRef.id });
  } catch (error) {
    console.error("Error creating submission:", error);
    res.status(500).json({ error: "Failed to create submission" });
  }
});

app.patch("/submissions/:id/status", ...requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, remarks } = req.body;
    const docRef = collections.submissions.doc(id);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }

    const submission = mapSubmissionDoc(
      docSnap as FirebaseFirestore.QueryDocumentSnapshot
    );
    const details: Record<string, any> = { ...submission.details, remarks };
    let generatedPartnerId: string | null = null;

    if (submission.type === "Partner" && status === "Approved") {
      const cityCode = details.city
        ? String(details.city).substring(0, 3).toUpperCase()
        : "GEN";
      const sequenceNumber = randomInt(1000, 10000);
      generatedPartnerId = `HZ-${cityCode}-PTN-${sequenceNumber}`;
      details.partnerId = generatedPartnerId;

      await collections.users.doc(submission.email).set(
        {
          name: submission.name,
          email: submission.email,
          role: "partner",
          partnerId: generatedPartnerId,
          location: details.city ?? details.location ?? "",
          expertise: details.expertise ?? "Residential",
          created_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    await docRef.update({
      status,
      details,
      updated_at: FieldValue.serverTimestamp(),
    });

    res.json({ success: true, partnerId: generatedPartnerId });
  } catch (error) {
    console.error("Error updating submission status:", error);
    res.status(500).json({ error: "Failed to update submission status" });
  }
});

// ── Enquiries ────────────────────────────────────────────────────────

app.patch("/submissions/:id", ...requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = collections.submissions.doc(id);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    await docRef.update({ ...req.body, updated_at: FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating submission details:", error);
    res.status(500).json({ error: "Failed to update submission" });
  }
});

app.get("/enquiries", ...requireAdmin, async (_req, res) => {
  try {
    const snapshot = await collections.enquiries
      .orderBy("created_at", "desc")
      .get()
      .catch(() => collections.enquiries.get());
    const enquiries = snapshot.docs.map(mapEnquiryDoc);
    res.json({ enquiries });
  } catch (error) {
    console.error("Error fetching enquiries:", error);
    res.status(500).json({ error: "Failed to fetch enquiries" });
  }
});

app.post("/enquiries", async (req, res) => {
  try {
    const {
      client_name,
      phone,
      email,
      property_id,
      property_name,
      property_type,
      location,
      enquiry_type,
      source,
    } = req.body;

    if (property_id && !(await ensurePropertyExists(property_id))) {
      res
        .status(400)
        .json({ error: "Invalid property_id. Property does not exist." });
      return;
    }

    const docRef = collections.enquiries.doc();
    await docRef.set({
      id: docRef.id,
      client_name,
      phone,
      email,
      property_id: property_id ?? "",
      property_name: property_name ?? "",
      property_type: property_type ?? "",
      location: location ?? "",
      enquiry_type: enquiry_type ?? "",
      source: source ?? "Website",
      status: "New",
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });

    await addTimelineEntry({
      enquiryId: docRef.id,
      action: "Created",
      details: null,
      createdBy: email ?? "Client",
    });

    res.json({ success: true, id: docRef.id });
  } catch (error) {
    console.error("Error creating enquiry:", error);
    res.status(500).json({ error: "Failed to create enquiry" });
  }
});

app.patch("/enquiries/:id/status", ...requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, priority } = req.body;
    const docRef = collections.enquiries.doc(id);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      res.status(404).json({ error: "Enquiry not found" });
      return;
    }

    await docRef.update({
      status,
      priority: priority ?? null,
      updated_at: FieldValue.serverTimestamp(),
    });

    await addTimelineEntry({
      enquiryId: id,
      action: `Status changed to ${status}`,
      details: priority ? `Priority set to ${priority}` : null,
      createdBy: "System",
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error updating enquiry status:", error);
    res.status(500).json({ error: "Failed to update enquiry status" });
  }
});

app.get("/enquiries/:id/timeline", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const snapshot = await collections.enquiryTimeline
      .where("enquiry_id", "==", id)
      .orderBy("created_at", "desc")
      .get()
      .catch(() => collections.enquiryTimeline.get());

    const timeline = snapshot.docs
      .filter((doc) => doc.data().enquiry_id === id)
      .map((doc) => ({
        id: doc.id,
        enquiry_id: doc.data().enquiry_id,
        action: doc.data().action,
        details: doc.data().details ?? null,
        created_by: doc.data().created_by,
        created_at: toISODate(doc.data().created_at),
      }))
      .sort((a, b) => {
        if (!a.created_at || !b.created_at) return 0;
        return (
          new Date(b.created_at).getTime() -
          new Date(a.created_at).getTime()
        );
      });
    res.json({ timeline });
  } catch (error) {
    console.error("Error fetching timeline:", error);
    res.status(500).json({ error: "Failed to fetch timeline" });
  }
});

// ── Admin ────────────────────────────────────────────────────────────

app.get("/admin/sales-team", ...requireAdmin, async (_req, res) => {
  try {
    const snapshot = await collections.users
      .where("role", "==", "sales")
      .get();
    const sales = snapshot.docs.map(mapUserDoc).map((u) => ({
      id: u.id,
      name: u.name,
      region: u.region,
      activeLeads: u.activeLeads ?? 0,
    }));
    res.json({ sales });
  } catch (error) {
    console.error("Error fetching sales team:", error);
    res.status(500).json({ error: "Failed to fetch sales team" });
  }
});

app.get("/admin/partners", ...requireAdmin, async (_req, res) => {
  try {
    const snapshot = await collections.users
      .where("role", "==", "partner")
      .get();
    const partners = snapshot.docs.map(mapUserDoc).map((u) => ({
      id: u.id,
      name: u.name,
      location: u.location,
      expertise: u.expertise,
    }));
    res.json({ partners });
  } catch (error) {
    console.error("Error fetching partners:", error);
    res.status(500).json({ error: "Failed to fetch partners" });
  }
});

app.get("/admin/users", requireAuth, requireRole("super_admin"), async (_req, res) => {
  try {
    const snap = await collections.users.where("role", "==", "admin").orderBy("createdAt", "desc").get();
    const users = snap.docs.map(toUserListItem);
    res.json({ users });
  } catch (error) {
    console.error("Error fetching admin users:", error);
    res.status(500).json({ error: "Failed to fetch admin users" });
  }
});

app.post("/admin/users", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { name, phone, email } = req.body ?? {};
    await createPendingUser({ name, phone, email, role: "admin", createdBy: req.user?.uid }, res);
  } catch (error) {
    console.error("Error creating admin user:", error);
    res.status(500).json({ error: "Failed to create admin user" });
  }
});

app.patch("/admin/users/:uid", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { uid } = req.params;
    await assertManageableAdminUser(uid);

    if (uid.startsWith("pending_")) {
      // For pending users, only update Firestore fields (name, email, status)
      const firestoreUpdate: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: req.user?.uid,
      };
      const name = nonEmpty(req.body?.name ?? req.body?.displayName);
      if (name) { firestoreUpdate.name = name; firestoreUpdate.displayName = name; }
      const email = nonEmpty(req.body?.email);
      if (email) firestoreUpdate.email = email;
      if (isAdminUserStatus(req.body?.status)) firestoreUpdate.status = req.body.status;
      await collections.users.doc(uid).set(firestoreUpdate, { merge: true });
    } else {
      // Real Firebase Auth users — update Auth + Firestore
      const authUpdate = buildAdminAuthUpdate(req.body ?? {});
      if (Object.keys(authUpdate).length > 0) {
        await auth.updateUser(uid, authUpdate);
      }
      const firestoreUpdate = buildAdminFirestoreUpdate({
        authUpdate,
        status: req.body?.status,
        updatedBy: req.user?.uid,
      });
      await collections.users.doc(uid).set(firestoreUpdate, { merge: true });
    }

    res.json({ success: true });
  } catch (error) {
    handleAdminUserApiError("updating admin user", error, res);
  }
});

app.delete("/admin/users/:uid", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { uid } = req.params;
    await assertManageableAdminUser(uid);

    // Pending users only exist in Firestore — no Firebase Auth record to delete
    if (!uid.startsWith("pending_")) {
      await auth.deleteUser(uid);
    }
    await collections.users.doc(uid).delete();
    res.json({ success: true });
  } catch (error) {
    handleAdminUserApiError("deleting admin user", error, res);
  }
});

// ── Admin: Howzer Employees (howzer_sourcing / howzer_sales) ──────────

const EMPLOYEE_ROLES = ["howzer_sourcing", "howzer_sales"] as const;
type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];
const isEmployeeRole = (v: unknown): v is EmployeeRole =>
  EMPLOYEE_ROLES.includes(v as EmployeeRole);

app.get("/admin/employees", requireAuth, requireRole("super_admin"), async (_req, res) => {
  try {
    const snap = await collections.users
      .where("role", "in", [...EMPLOYEE_ROLES])
      .orderBy("createdAt", "desc")
      .get();
    const employees = snap.docs.map(toUserListItem);
    res.json({ employees });
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

app.post("/admin/employees", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { name, phone, role } = req.body ?? {};
    if (!isEmployeeRole(role)) {
      res.status(400).json({ error: `role must be one of: ${EMPLOYEE_ROLES.join(", ")}` });
      return;
    }
    const created = await createPendingUser({ name, phone, role, createdBy: req.user?.uid }, res);
    if (!created) return;

    // If this phone number already has a Firebase Auth user (previously logged in as client),
    // update their UID-keyed Firestore doc and custom claims immediately.
    const parsed = parsePhone(phone);
    if (parsed) {
      try {
        const existingUser = await auth.getUserByPhoneNumber(parsed.normalizedPhone);
        const uidRef = collections.users.doc(existingUser.uid);
        await uidRef.set({ role, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.user?.uid }, { merge: true });
        await auth.setCustomUserClaims(existingUser.uid, { role });
      } catch (err: unknown) {
        // No existing Auth user for this phone — that's expected, pending doc is enough
        const code = (err as { code?: string })?.code;
        if (code !== "auth/user-not-found") {
          console.warn("Unexpected error checking existing Auth user:", code);
        }
      }
    }
  } catch (error) {
    console.error("Error creating employee:", error);
    res.status(500).json({ error: "Failed to create employee" });
  }
});

app.patch("/admin/employees/:uid", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await collections.users.doc(uid).get();
    if (!snap.exists || !isEmployeeRole(snap.data()?.role)) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }

    const update: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: req.user?.uid,
    };
    const name = (req.body?.name ?? req.body?.displayName)?.toString().trim();
    if (name) { update.name = name; update.displayName = name; }
    if (isEmployeeRole(req.body?.role)) update.role = req.body.role;
    if (["active", "disabled"].includes(req.body?.status)) update.status = req.body.status;

    await collections.users.doc(uid).set(update, { merge: true });
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating employee:", error);
    res.status(500).json({ error: "Failed to update employee" });
  }
});

app.delete("/admin/employees/:uid", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await collections.users.doc(uid).get();
    if (!snap.exists || !isEmployeeRole(snap.data()?.role)) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }

    if (!uid.startsWith("pending_")) {
      await auth.deleteUser(uid);
    }
    await collections.users.doc(uid).delete();
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting employee:", error);
    res.status(500).json({ error: "Failed to delete employee" });
  }
});

// ── Admin: Create User With Any Role ─────────────────────────────────

const MANAGEABLE_ROLES = ["admin", "agent", "partner", "client", "howzer_sourcing", "howzer_sales"] as const;
type ManageableRole = (typeof MANAGEABLE_ROLES)[number];
const isManageableRole = (v: unknown): v is ManageableRole =>
  MANAGEABLE_ROLES.includes(v as ManageableRole);

app.post("/admin/create-user", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { email, password, displayName, role } = req.body ?? {};
    if (!email || !password || !displayName) {
      return res.status(400).json({ error: "email, password and displayName are required" });
    }
    if (!isManageableRole(role)) {
      return res.status(400).json({
        error: `role must be one of: ${MANAGEABLE_ROLES.join(", ")}`,
      });
    }

    const userRecord = await auth.createUser({ email, password, displayName });
    await auth.setCustomUserClaims(userRecord.uid, { role });

    await collections.users.doc(userRecord.uid).set({
      email,
      displayName,
      name: displayName,
      role,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user?.uid,
    });

    res.status(201).json({ success: true, uid: userRecord.uid });
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
});

app.delete("/admin/create-user/:uid", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ error: "uid is required" });

    const authUser = await auth.getUser(uid).catch(() => null);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const existingRole = authUser.customClaims?.role as string | undefined;
    if (existingRole === "super_admin") {
      return res.status(403).json({ error: "Cannot delete super_admin users" });
    }

    await auth.deleteUser(uid);
    await collections.users.doc(uid).delete();
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ── Admin Properties ─────────────────────────────────────────────────

const ALLOWED_PROPERTY_TYPES = ["project", "plot", "farmland"] as const;
type AllowedPropertyType = (typeof ALLOWED_PROPERTY_TYPES)[number];
const isAllowedPropertyType = (v: unknown): v is AllowedPropertyType =>
  ALLOWED_PROPERTY_TYPES.includes(v as AllowedPropertyType);

// Shared helper: fetch a fully-joined project from Cloud SQL by its UUID
async function fetchProjectById(id: string) {
  const sql = `
    SELECT
      p.*,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object(
          'id', c.id, 'bhk_count', c.bhk_count,
          'min_sft', c.min_sft, 'max_sft', c.max_sft, 'unit_count', c.unit_count
        )) FILTER (WHERE c.id IS NOT NULL), '[]'
      ) AS configurations,
      COALESCE(
        json_agg(jsonb_build_object(
          'id', ph.id, 'url', ph.url, 'display_order', ph.display_order
        ) ORDER BY ph.display_order) FILTER (WHERE ph.id IS NOT NULL), '[]'
      ) AS photos,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('id', pa.id, 'amenity', pa.amenity))
        FILTER (WHERE pa.id IS NOT NULL), '[]'
      ) AS amenities
    FROM projects p
    LEFT JOIN configurations c ON c.project_id = p.id
    LEFT JOIN project_photos ph ON ph.project_id = p.id
    LEFT JOIN project_amenities pa ON pa.project_id = p.id
    WHERE p.id::text = $1
    GROUP BY p.id
  `;
  const row: any = await queryOne(sql, [id]);
  if (!row) return null;
  return mapProjectRow({
    ...row,
    configurations: row.configurations ?? [],
    photos: row.photos ?? [],
    amenities: row.amenities ?? [],
  });
}

app.post("/admin/properties", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const body = req.body as CreateProjectInput;

    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!body.city || !String(body.city).trim()) {
      return res.status(400).json({ error: "city is required" });
    }
    if (!body.propertyType) {
      return res.status(400).json({ error: "propertyType is required (PROJECT | PLOT | FARMLAND)" });
    }

    const callerRole = req.user?.role;
    const callerUid = req.user?.uid ?? "";
    const projectStatus = callerRole === "admin" ? "PENDING_APPROVAL" : (body.status ?? "ACTIVE");

    // Generate a collision-resistant unique ID using crypto (CSPRNG)
    const uniqueId = `PROP-${randomUUID()}`;

    const project = await withTransaction(async (client) => {
      // Insert main project row
      const insertResult = await client.query(
        `INSERT INTO projects (
          unique_id, name, developer_name, rera_number, property_type, project_type,
          project_segment, possession_status, possession_date, address, zone, location,
          area, city, state, pincode, landmark, map_link, land_parcel, number_of_towers,
          total_units, available_units, density, sft_costing_per_sqft, emi_starts_from,
          pricing_two_bhk, pricing_three_bhk, pricing_four_bhk, video_link_3d, brochure_link,
          onboarding_agreement_link, project_manager_name, project_manager_contact,
          spoc_name, spoc_contact, usp, teaser, details, status, lead_registration_status,
          created_by, updated_by, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,now(),now()
        ) RETURNING *`,
        [
          uniqueId, String(body.name).trim(), body.developerName ?? "",
          body.reraNumber ?? null, body.propertyType, body.projectType ?? null,
          body.projectSegment ?? null, body.possessionStatus ?? null, body.possessionDate ?? null,
          body.address ?? null, body.zone ?? null, body.location ?? null,
          body.area ?? null, body.city, body.state ?? null,
          body.pincode ?? null, body.landmark ?? null, body.mapLink ?? null,
          body.landParcel ?? null, body.numberOfTowers ?? null,
          body.totalUnits ?? null, body.availableUnits ?? null, body.density ?? null,
          body.sftCostingPerSqft ?? null, body.emiStartsFrom ?? null,
          body.pricingTwoBhk ?? null, body.pricingThreeBhk ?? null, body.pricingFourBhk ?? null,
          body.videoLink3D ?? null, body.brochureLink ?? null,
          body.onboardingAgreementLink ?? null, body.projectManagerName ?? null,
          body.projectManagerContact ?? null, body.spocName ?? null, body.spocContact ?? null,
          body.usp ?? null, body.teaser ?? null, body.details ?? null,
          projectStatus, null, callerUid, callerUid,
        ]
      );
      const projectId = insertResult.rows[0].id;

      // Insert configurations
      if (body.configurations?.length) {
        for (const cfg of body.configurations) {
          await client.query(
            `INSERT INTO configurations (project_id, bhk_count, min_sft, max_sft, unit_count)
             VALUES ($1,$2,$3,$4,$5)`,
            [projectId, cfg.bhkCount, cfg.minSft, cfg.maxSft, cfg.unitCount]
          );
        }
      }

      // Insert photos (accept string[] or {url, displayOrder}[])
      if (body.photos?.length) {
        for (let i = 0; i < body.photos.length; i++) {
          const photoUrl = typeof body.photos[i] === 'string' ? body.photos[i] : (body.photos[i] as any).url;
          await client.query(
            `INSERT INTO project_photos (project_id, url, display_order) VALUES ($1,$2,$3)`,
            [projectId, photoUrl, i]
          );
        }
      }

      // Insert amenities
      if (body.amenities?.length) {
        for (const amenity of body.amenities) {
          await client.query(
            `INSERT INTO project_amenities (project_id, amenity)
             VALUES ($1,$2) ON CONFLICT (project_id, amenity) DO NOTHING`,
            [projectId, amenity]
          );
        }
      }

      return insertResult.rows[0];
    });

    const fullProject = await fetchProjectById(project.id);

    // Fire-and-forget backup
    if (fullProject) upsertProjectRow(fullProject).catch(() => {});

    res.status(201).json({ id: project.id, uniqueId, success: true, pending: callerRole === "admin" });
  } catch (error) {
    console.error("Error creating property:", error);
    res.status(500).json({ error: "Failed to create property" });
  }
});

/** Applies all field updates for a project inside a transaction. */
async function applyProjectUpdate(
  projectId: string,
  body: UpdateProjectInput,
  callerUid: string
): Promise<void> {
  await withTransaction(async (client) => {
    const sets: string[] = ["updated_at = now()", "updated_by = $1"];
    const params: unknown[] = [callerUid];

    const fieldMap: Record<string, string> = {
      name: "name", developerName: "developer_name", reraNumber: "rera_number",
      propertyType: "property_type", projectType: "project_type",
      projectSegment: "project_segment", possessionStatus: "possession_status",
      possessionDate: "possession_date", address: "address", zone: "zone",
      location: "location", area: "area", city: "city", state: "state",
      pincode: "pincode", landmark: "landmark", mapLink: "map_link",
      landParcel: "land_parcel", numberOfTowers: "number_of_towers",
      totalUnits: "total_units", availableUnits: "available_units",
      density: "density", sftCostingPerSqft: "sft_costing_per_sqft",
      emiStartsFrom: "emi_starts_from", pricingTwoBhk: "pricing_two_bhk",
      pricingThreeBhk: "pricing_three_bhk", pricingFourBhk: "pricing_four_bhk",
      videoLink3D: "video_link_3d", brochureLink: "brochure_link",
      onboardingAgreementLink: "onboarding_agreement_link",
      projectManagerName: "project_manager_name",
      projectManagerContact: "project_manager_contact",
      spocName: "spoc_name", spocContact: "spoc_contact",
      usp: "usp", teaser: "teaser", details: "details", status: "status",
    };

    for (const [jsKey, colName] of Object.entries(fieldMap)) {
      if (jsKey in body && (body as any)[jsKey] !== undefined) {
        params.push((body as any)[jsKey]);
        sets.push(`${colName} = $${params.length}`);
      }
    }

    params.push(projectId);
    await client.query(
      `UPDATE projects SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params
    );

    if (body.configurations !== undefined) {
      await client.query("DELETE FROM configurations WHERE project_id = $1", [projectId]);
      for (const cfg of body.configurations ?? []) {
        await client.query(
          `INSERT INTO configurations (project_id, bhk_count, min_sft, max_sft, unit_count)
           VALUES ($1,$2,$3,$4,$5)`,
          [projectId, cfg.bhkCount, cfg.minSft, cfg.maxSft, cfg.unitCount]
        );
      }
    }

    if (body.photos?.length) {
      const countRes = await client.query(
        "SELECT COUNT(*) FROM project_photos WHERE project_id = $1",
        [projectId]
      );
      let startOrder = Number(countRes.rows[0].count);
      for (const photo of body.photos) {
        const photoUrl = typeof photo === "string" ? photo : (photo as any).url;
        await client.query(
          "INSERT INTO project_photos (project_id, url, display_order) VALUES ($1,$2,$3)",
          [projectId, photoUrl, startOrder++]
        );
      }
    }

    if (body.amenities !== undefined) {
      await client.query("DELETE FROM project_amenities WHERE project_id = $1", [projectId]);
      for (const amenity of body.amenities ?? []) {
        await client.query(
          `INSERT INTO project_amenities (project_id, amenity)
           VALUES ($1,$2) ON CONFLICT (project_id, amenity) DO NOTHING`,
          [projectId, amenity]
        );
      }
    }
  });
}

// Update a project (admin/super_admin)
app.patch("/admin/properties/:id", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body as UpdateProjectInput;
    const callerUid = req.user?.uid ?? "";

    // Verify project exists
    const existing: any = await queryOne("SELECT id FROM projects WHERE id::text = $1 OR unique_id = $1", [id]);
    if (!existing) return res.status(404).json({ error: "Project not found" });
    const projectId = existing.id;

    await applyProjectUpdate(projectId, body, callerUid);

    const updated = await fetchProjectById(projectId);
    if (updated) upsertProjectRow(updated).catch(() => {});

    res.json({ success: true, project: updated });
  } catch (error) {
    console.error("Error updating property:", error);
    res.status(500).json({ error: "Failed to update property" });
  }
});

app.delete("/admin/properties/:id", requireAuth, requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      "UPDATE projects SET status = 'INACTIVE', updated_at = now() WHERE id::text = $1 OR unique_id = $1 RETURNING id",
      [id]
    );
    if (!result.length) return res.status(404).json({ error: "Property not found" });
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting property:", error);
    res.status(500).json({ error: "Failed to delete property" });
  }
});

app.post("/admin/properties/:id/approve", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      "UPDATE projects SET status = 'ACTIVE', updated_at = now() WHERE id::text = $1 OR unique_id = $1 RETURNING id",
      [id]
    );
    if (!result.length) return res.status(404).json({ error: "Property not found" });
    res.json({ success: true, project: { id: result[0].id, status: "ACTIVE" } });
  } catch (error) {
    console.error("Error approving property:", error);
    res.status(500).json({ error: "Failed to approve property" });
  }
});

app.post("/admin/properties/:id/reject", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      "UPDATE projects SET status = 'INACTIVE', updated_at = now() WHERE id::text = $1 OR unique_id = $1 RETURNING id",
      [id]
    );
    if (!result.length) return res.status(404).json({ error: "Property not found" });
    res.json({ success: true });
  } catch (error) {
    console.error("Error rejecting property:", error);
    res.status(500).json({ error: "Failed to reject property" });
  }
});

// Super admin: get Google Sheets backup link
app.get("/admin/settings/backup-sheet", requireAuth, requireRole("super_admin"), async (_req, res) => {
  const sheetId = process.env.BACKUP_SHEET_ID;
  if (!sheetId) {
    return res.status(503).json({ error: "Backup sheet not configured" });
  }
  res.json({ sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` });
});

app.post("/admin/enquiries/:id/assign", ...requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { salesId, salesName, partnerId, partnerName, notes } = req.body;
    const docRef = collections.enquiries.doc(id);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      res.status(404).json({ error: "Enquiry not found" });
      return;
    }

    await docRef.update({
      assigned_sales_id: salesId ?? null,
      assigned_sales_name: salesName ?? null,
      assigned_partner_id: partnerId ?? null,
      assigned_partner_name: partnerName ?? null,
      status: "Assigned",
      admin_notes: notes ?? null,
      updated_at: FieldValue.serverTimestamp(),
    });

    const details = [
      salesName ? `Assigned to Sales: ${salesName}` : null,
      partnerName ? `Assigned to Partner: ${partnerName}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    await addTimelineEntry({
      enquiryId: id,
      action: "Assigned",
      details: details || notes || "",
      createdBy: "Admin",
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error assigning enquiry:", error);
    res.status(500).json({ error: "Failed to assign enquiry" });
  }
});

app.get("/admin/client-login-stats", ...requireAdmin, async (_req, res) => {
  try {
    const snapshot = await collections.clientLogins.get().catch(() => null);
    if (!snapshot) {
      res.json({ totalUsers: 0, activeToday: 0, totalLogins: 0, failedAttempts: 0 });
      return;
    }
    const docs = snapshot.docs.map((d) => d.data());

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const uniqueUsers = new Set(docs.map((d) => d.email as string)).size;
    const activeToday = new Set(
      docs
        .filter((d) => {
          const t = d.login_time?.toDate?.() ?? new Date(d.login_time);
          return t >= todayStart;
        })
        .map((d) => d.email as string)
    ).size;
    const totalLogins = docs.length;
    const failedAttempts = docs.filter((d) => d.status === "Failed").length;

    res.json({ totalUsers: uniqueUsers, activeToday, totalLogins, failedAttempts });
  } catch (error) {
    console.error("Error fetching client login stats:", error);
    res.json({ totalUsers: 0, activeToday: 0, totalLogins: 0, failedAttempts: 0 });
  }
});

app.get("/admin/client-logins", ...requireAdmin, async (_req, res) => {
  try {
    const snapshot = await collections.clientLogins
      .orderBy("login_time", "desc")
      .get()
      .catch(() => collections.clientLogins.get())
      .catch(() => null);
    const logins = snapshot ? snapshot.docs.map(mapLoginDoc) : [];

    // Enrich login records with user names from client_profiles (by phone)
    const phones = [...new Set(logins.map((l) => l.phone).filter(Boolean))] as string[];
    const nameByPhone: Record<string, string> = {};
    for (let i = 0; i < phones.length; i += 10) {
      const chunk = phones.slice(i, i + 10);
      const profileSnap = await db
        .collection("client_profiles")
        .where("phone", "in", chunk)
        .get()
        .catch(() => null);
      if (profileSnap) {
        profileSnap.docs.forEach((d) => {
          const data = d.data();
          if (data.phone) nameByPhone[data.phone] = data.name ?? "";
        });
      }
    }
    const enriched = logins.map((l) => ({
      ...l,
      name: l.phone ? (nameByPhone[l.phone] ?? null) : null,
    }));
    res.json({ logins: enriched });
  } catch (error) {
    console.error("Error fetching client logins:", error);
    res.json({ logins: [] });
  }
});

app.delete("/admin/clients/:uid", ...requireAdmin, async (req, res) => {
  if (req.user?.role !== "super_admin") {
    res.status(403).json({ error: "Only super admins can delete users" });
    return;
  }
  const { uid } = req.params;
  try {
    await Promise.all([
      auth.deleteUser(uid).catch(() => null),
      db.collection("users").doc(uid).delete().catch(() => null),
      db.collection("client_profiles").doc(uid).delete().catch(() => null),
    ]);
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting client:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

app.get("/admin/client-360/:email", ...requireAdmin, async (req, res) => {
  try {
    const email = req.params.email;
    const [loginSnapshot, listingsSnapshot] = await Promise.all([
      collections.clientLogins
        .where("email", "==", email)
        .orderBy("login_time", "desc")
        .get()
        .catch(() => collections.clientLogins.get()),
      collections.submissions.where("email", "==", email).get(),
    ]);

    const logins = loginSnapshot.docs
      .filter((doc) => (doc.data().email ?? email) === email)
      .map(mapLoginDoc);
    const listings = listingsSnapshot.docs.map(mapSubmissionDoc);
    const propertyIds = listings.map((l) => l.id);

    let enquiriesOnListings: ReturnType<typeof mapEnquiryDoc>[] = [];
    if (propertyIds.length > 0) {
      for (const chunk of chunkArray(propertyIds)) {
        const snap = await collections.enquiries
          .where("property_id", "in", chunk)
          .get();
        enquiriesOnListings = enquiriesOnListings.concat(
          snap.docs.map(mapEnquiryDoc)
        );
      }
    }

    const enquiriesMadeSnapshot = await collections.enquiries
      .where("email", "==", email)
      .orderBy("created_at", "desc")
      .get()
      .catch(() => collections.enquiries.get());
    const enquiriesMade = enquiriesMadeSnapshot.docs
      .filter((doc) => (doc.data().email ?? email) === email)
      .map(mapEnquiryDoc);

    res.json({
      logins,
      listings: listings.map((l) => ({ ...l, details: l.details })),
      enquiriesOnListings,
      enquiriesMade,
    });
  } catch (error) {
    console.error("Error fetching client 360 view:", error);
    res.status(500).json({ error: "Failed to fetch client 360 view" });
  }
});

// ── Client ───────────────────────────────────────────────────────────

app.get("/client/enquiries", requireAuth, async (req, res) => {
  try {
    const requesterEmail = req.user?.email?.toLowerCase();
    const emailParam = (req.query.email as string | undefined)?.toLowerCase();
    if (!requesterEmail) {
      res.status(400).json({ error: "Email not found in token" });
      return;
    }
    if (emailParam && emailParam !== requesterEmail) {
      res.status(403).json({ error: "Forbidden: can only access own enquiries" });
      return;
    }
    const email = emailParam ?? requesterEmail;

    const snapshot = await collections.enquiries
      .where("email", "==", email)
      .orderBy("created_at", "desc")
      .get()
      .catch((error) => {
        if (isPermissionDeniedError(error)) {
          console.warn("Enquiries read denied for client endpoint. Returning empty list.");
          return null;
        }
        return collections.enquiries.get();
      });
    if (!snapshot) {
      res.json({ enquiries: [] });
      return;
    }
    const enquiries = snapshot.docs
      .filter((doc) => doc.data().email === email)
      .map(mapEnquiryDoc);
    res.json({ enquiries });
  } catch (error) {
    console.error("Error fetching client enquiries:", error);
    res.status(500).json({ error: "Failed to fetch client enquiries" });
  }
});

app.post("/client/login-track", async (req, res) => {
  try {
    const {
      email,
      phone,
      device_type,
      browser,
      ip_address,
      location,
      status,
      failure_reason,
    } = req.body;
    const docRef = collections.clientLogins.doc();
    await docRef.set({
      id: docRef.id,
      email,
      phone: phone ?? null,
      device_type: device_type ?? "Unknown",
      browser: browser ?? "Unknown",
      ip_address: ip_address ?? "Unknown",
      location: location ?? "Unknown",
      status: status ?? "Success",
      failure_reason: failure_reason ?? null,
      login_time: FieldValue.serverTimestamp(),
    });

    res.json({ success: true, id: docRef.id });
  } catch (error: unknown) {
    if (isPermissionDeniedError(error)) {
      console.warn("Client login tracking denied by Firestore permissions. Continuing.");
      res.json({ success: true, skipped: "permission_denied" });
      return;
    }
    console.error("Error tracking login:", error);
    res.status(500).json({ error: "Failed to track login" });
  }
});

app.post("/client/logout-track", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      res.status(400).json({ error: "Missing login record id" });
      return;
    }
    await collections.clientLogins.doc(id).update({
      logout_time: FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (error: unknown) {
    if (isPermissionDeniedError(error)) {
      console.warn("Client logout tracking denied by Firestore permissions. Continuing.");
      res.json({ success: true, skipped: "permission_denied" });
      return;
    }
    console.error("Error tracking logout:", error);
    res.status(500).json({ error: "Failed to track logout" });
  }
});

// ── Pilot / Partner ──────────────────────────────────────────────────

const fetchAssignedEnquiries = async (
  predicate: (enquiry: ReturnType<typeof mapEnquiryDoc>) => boolean
) => {
  const snapshot = await collections.enquiries.get();
  return snapshot.docs
    .map(mapEnquiryDoc)
    .filter(predicate)
    .sort((a, b) => {
      if (!a.updated_at || !b.updated_at) return 0;
      return (
        new Date(b.updated_at).getTime() -
        new Date(a.updated_at).getTime()
      );
    });
};

app.get("/pilot/assigned-enquiries", requireAuth, requireRole("sales", "admin", "super_admin"), async (_req, res) => {
  try {
    const enquiries = await fetchAssignedEnquiries((e) =>
      Boolean(e.assigned_sales_id)
    );
    res.json({ enquiries });
  } catch (error) {
    console.error("Error fetching assigned enquiries:", error);
    res.status(500).json({ error: "Failed to fetch assigned enquiries" });
  }
});

app.get("/partner/assigned-enquiries", requireAuth, requireRole("partner", "admin", "super_admin", "howzer_sourcing", "howzer_sales"), async (_req, res) => {
  try {
    const enquiries = await fetchAssignedEnquiries((e) =>
      Boolean(e.assigned_partner_id)
    );
    res.json({ enquiries });
  } catch (error) {
    console.error("Error fetching partner enquiries:", error);
    res.status(500).json({ error: "Failed to fetch assigned enquiries" });
  }
});

// ── Google Calendar ──────────────────────────────────────────────────

app.get("/auth/google/url", (req, res) => {
  const redirectUri = req.query.redirectUri as string;
  if (!redirectUri) {
    res.status(400).json({ error: "redirectUri is required" });
    return;
  }
  const oauth2Client = getGoogleOAuthClient(redirectUri);
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    prompt: "consent",
  });
  res.json({ url });
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  const protocol =
    (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const redirectUri = `${protocol}://${host}/auth/google/callback`;

  try {
    const oauth2Client = getGoogleOAuthClient(redirectUri);
    const { tokens } = await oauth2Client.getToken(code as string);

    res.cookie("google_access_token", tokens.access_token, {
      secure: true,
      sameSite: "none",
      httpOnly: true,
      maxAge: 3600000,
    });
    if (tokens.refresh_token) {
      res.cookie("google_refresh_token", tokens.refresh_token, {
        secure: true,
        sameSite: "none",
        httpOnly: true,
        maxAge: 30 * 24 * 3600000,
      });
    }

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("OAuth error:", error);
    res.status(500).send("Authentication failed");
  }
});

app.get("/calendar/events", async (req, res) => {
  const oauth2Client = ensureGoogleAuth(req, res);
  if (!oauth2Client) return;
  try {
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime",
    });
    res.json({ events: response.data.items });
  } catch (error) {
    console.error("Calendar API error:", error);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

app.post("/calendar/events", async (req, res) => {
  const oauth2Client = ensureGoogleAuth(req, res);
  if (!oauth2Client) return;
  try {
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const { summary, description, start, end } = req.body;
    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description,
        start: { dateTime: start },
        end: { dateTime: end },
      },
    });
    res.json({ event: response.data });
  } catch (error) {
    console.error("Calendar API error:", error);
    res.status(500).json({ error: "Failed to create event" });
  }
});

app.get("/calendar/status", (req, res) => {
  const accessToken = req.cookies.google_access_token;
  const refreshToken = req.cookies.google_refresh_token;
  res.json({ connected: !!(accessToken || refreshToken) });
});

// ── Leads (update) ───────────────────────────────────────────────────

app.patch("/leads/:id", requireAuth, requireRole("agent", "admin", "super_admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = collections.leads.doc(id);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const allowed = [
      "name", "budget", "location_preferred", "locationPreferred",
      "looking_bhk", "lookingBhk", "contact", "milestone", "project_id",
      "document_uploaded", "status", "campaign_source", "campaign_name",
      "assigned_to", "followUpDate", "followUpNote",
    ];
    const updates: Record<string, unknown> = { updated_at: FieldValue.serverTimestamp() };
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }

    await docRef.update(updates);
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating lead:", error);
    res.status(500).json({ error: "Failed to update lead" });
  }
});

// ── Partner: own submissions ──────────────────────────────────────────

app.get(
  "/partner/submissions",
  requireAuth,
  requireRole("partner", "admin", "super_admin", "howzer_sourcing", "howzer_sales"),
  async (req, res) => {
    try {
      const email = req.user?.email;
      if (!email) {
        // howzer_sourcing/howzer_sales log in via phone — no submissions in this collection
        res.json({ submissions: [] });
        return;
      }
      const snapshot = await collections.submissions
        .where("email", "==", email)
        .orderBy("created_at", "desc")
        .get()
        .catch(() =>
          collections.submissions.where("email", "==", email).get()
        );
      const submissions = snapshot.docs.map(mapSubmissionDoc).map((s) => ({
        ...s,
        date: s.createdAt ? s.createdAt.split("T")[0] : null,
      }));
      res.json({ submissions });
    } catch (error) {
      console.error("Error fetching partner submissions:", error);
      res.status(500).json({ error: "Failed to fetch submissions" });
    }
  }
);

// ── Partner: update assigned enquiry status ──────────────────────────

app.patch(
  "/partner/enquiries/:id/status",
  requireAuth,
  requireRole("partner", "admin", "super_admin", "howzer_sourcing", "howzer_sales"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const docRef = collections.enquiries.doc(id);
      const docSnap = await docRef.get();
      if (!docSnap.exists) {
        res.status(404).json({ error: "Enquiry not found" });
        return;
      }

      const allowedStatuses = ["In Progress", "Closed", "Assigned"];
      if (!allowedStatuses.includes(status)) {
        res.status(400).json({
          error: `Invalid status. Allowed: ${allowedStatuses.join(", ")}`,
        });
        return;
      }

      await docRef.update({
        status,
        updated_at: FieldValue.serverTimestamp(),
      });

      await addTimelineEntry({
        enquiryId: id,
        action: `Status changed to ${status}`,
        details: `Updated by Partner`,
        createdBy: req.user?.email ?? "Partner",
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error updating partner enquiry status:", error);
      res.status(500).json({ error: "Failed to update enquiry status" });
    }
  }
);

// ── Attendance ───────────────────────────────────────────────────────

const uploadAttendancePhoto = async (
  base64Photo: string,
  path: string
): Promise<string> => {
  const bucket = storage.bucket();
  const matches = /^data:([A-Za-z-+/]+);base64,(.+)$/.exec(base64Photo);
  const mimeType = matches?.[1] ?? "image/jpeg";
  const base64Data = matches?.[2] ?? base64Photo;
  const buffer = Buffer.from(base64Data, "base64");
  const file = bucket.file(path);
  await file.save(buffer, { metadata: { contentType: mimeType } });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/${path}`;
};

app.post(
  "/attendance/punch-in",
  requireAuth,
  requireRole("agent", "partner", "admin", "super_admin"),
  async (req, res) => {
    try {
      const { photo, location, userEmail: bodyEmail } = req.body;
      const userEmail = bodyEmail ?? req.user?.email ?? "";
      const today = new Date().toISOString().split("T")[0];

      // Check if already punched in today
      const existing = await collections.attendance
        .where("userEmail", "==", userEmail)
        .where("date", "==", today)
        .limit(1)
        .get();

      if (!existing.empty) {
        res.status(400).json({ error: "Already punched in today" });
        return;
      }

      let photoUrl: string | null = null;
      if (photo) {
        photoUrl = await uploadAttendancePhoto(
          photo,
          `attendance/${userEmail}/${today}/punch-in.jpg`
        );
      }

      const docRef = collections.attendance.doc();
      const record = {
        id: docRef.id,
        userEmail,
        date: today,
        punchInTime: FieldValue.serverTimestamp(),
        punchOutTime: null,
        punchInLocation: location ?? null,
        punchOutLocation: null,
        punchInPhoto: photoUrl,
        punchOutPhoto: null,
        status: "Working",
        created_at: FieldValue.serverTimestamp(),
      };
      await docRef.set(record);
      res.json({ success: true, id: docRef.id });
    } catch (error) {
      console.error("Error punching in:", error);
      res.status(500).json({ error: "Failed to punch in" });
    }
  }
);

app.post(
  "/attendance/punch-out",
  requireAuth,
  requireRole("agent", "partner", "admin", "super_admin"),
  async (req, res) => {
    try {
      const { photo, location, userEmail: bodyEmail } = req.body;
      const userEmail = bodyEmail ?? req.user?.email ?? "";
      const today = new Date().toISOString().split("T")[0];

      const existing = await collections.attendance
        .where("userEmail", "==", userEmail)
        .where("date", "==", today)
        .where("status", "==", "Working")
        .limit(1)
        .get();

      if (existing.empty) {
        res.status(400).json({ error: "No active punch-in found for today" });
        return;
      }

      const docRef = existing.docs[0].ref;
      let photoUrl: string | null = null;
      if (photo) {
        photoUrl = await uploadAttendancePhoto(
          photo,
          `attendance/${userEmail}/${today}/punch-out.jpg`
        );
      }

      await docRef.update({
        punchOutTime: FieldValue.serverTimestamp(),
        punchOutLocation: location ?? null,
        punchOutPhoto: photoUrl,
        status: "Completed",
        updated_at: FieldValue.serverTimestamp(),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error punching out:", error);
      res.status(500).json({ error: "Failed to punch out" });
    }
  }
);

app.get(
  "/attendance",
  requireAuth,
  requireRole("agent", "partner", "admin", "super_admin"),
  async (req, res) => {
    try {
      const { email, date } = req.query as Record<string, string>;
      const userEmail = email ?? req.user?.email ?? "";
      let query: FirebaseFirestore.Query = collections.attendance.where(
        "userEmail",
        "==",
        userEmail
      );
      if (date) {
        query = query.where("date", "==", date);
      }
      const snapshot = await query.limit(1).get();
      if (snapshot.empty) {
        res.json({ record: null });
        return;
      }
      const doc = snapshot.docs[0];
      const data = doc.data();
      res.json({
        record: {
          id: doc.id,
          userEmail: data.userEmail,
          date: data.date,
          punchInTime: toISODate(data.punchInTime),
          punchOutTime: toISODate(data.punchOutTime),
          punchInLocation: data.punchInLocation ?? null,
          punchOutLocation: data.punchOutLocation ?? null,
          punchInPhoto: data.punchInPhoto ?? null,
          punchOutPhoto: data.punchOutPhoto ?? null,
          status: data.status,
        },
      });
    } catch (error) {
      console.error("Error fetching attendance:", error);
      res.status(500).json({ error: "Failed to fetch attendance" });
    }
  }
);

app.get(
  "/attendance/history",
  requireAuth,
  requireRole("agent", "partner", "admin", "super_admin"),
  async (req, res) => {
    try {
      const email = (req.query.email as string) ?? req.user?.email ?? "";
      const snapshot = await collections.attendance
        .where("userEmail", "==", email)
        .orderBy("date", "desc")
        .get()
        .catch(() =>
          collections.attendance.where("userEmail", "==", email).get()
        );
      const records = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          userEmail: data.userEmail,
          date: data.date,
          punchInTime: toISODate(data.punchInTime),
          punchOutTime: toISODate(data.punchOutTime),
          punchInLocation: data.punchInLocation ?? null,
          punchOutLocation: data.punchOutLocation ?? null,
          punchInPhoto: data.punchInPhoto ?? null,
          punchOutPhoto: data.punchOutPhoto ?? null,
          status: data.status,
        };
      });
      res.json({ records });
    } catch (error) {
      console.error("Error fetching attendance history:", error);
      res.status(500).json({ error: "Failed to fetch attendance history" });
    }
  }
);

app.post(
  "/attendance/location",
  requireAuth,
  requireRole("agent", "partner", "admin", "super_admin"),
  async (req, res) => {
    try {
      const { lat, lng, userEmail: bodyEmail } = req.body;
      if (typeof lat !== "number" || typeof lng !== "number") {
        res.status(400).json({ error: "lat and lng are required numbers" });
        return;
      }
      const userEmail = bodyEmail ?? req.user?.email ?? "";
      const docRef = collections.locationLogs.doc();
      await docRef.set({
        id: docRef.id,
        userEmail,
        lat,
        lng,
        timestamp: FieldValue.serverTimestamp(),
      });
      res.json({ success: true, id: docRef.id });
    } catch (error) {
      console.error("Error logging location:", error);
      res.status(500).json({ error: "Failed to log location" });
    }
  }
);

// ── Resale Properties ────────────────────────────────────────────────────────

const ALLOWED_RESALE_PROPERTY_TYPES = new Set([
  "Apartment",
  "Villa",
  "Plot",
  "Farm Land",
  "Commercial",
]);

const RESALE_EDITABLE_FIELDS = [
  "title", "description", "price", "propertyType", "city", "location",
  "mapLink", "area", "bedrooms", "bathrooms", "floor", "totalFloors",
  "amenities", "possession", "images",
] as const;

type ResaleBody = {
  title?: string;
  description?: string;
  price?: number;
  propertyType?: string;
  city?: string;
  location?: string;
  mapLink?: string;
  area?: string;
  bedrooms?: number;
  bathrooms?: number;
  floor?: number;
  totalFloors?: number;
  amenities?: string[];
  possession?: string;
  images?: string[];
};

function validateResaleBody(
  body: ResaleBody,
  res: import("express").Response
): boolean {
  if (!body.title || typeof body.title !== "string") {
    res.status(400).json({ error: "title is required" });
    return false;
  }
  if (!body.propertyType || !ALLOWED_RESALE_PROPERTY_TYPES.has(body.propertyType)) {
    res.status(400).json({
      error: `propertyType must be one of: ${[...ALLOWED_RESALE_PROPERTY_TYPES].join(", ")}`,
    });
    return false;
  }
  if (typeof body.price !== "number" || body.price < 0) {
    res.status(400).json({ error: "price must be a non-negative number" });
    return false;
  }
  if (!body.city || typeof body.city !== "string") {
    res.status(400).json({ error: "city is required" });
    return false;
  }
  return true;
}

function buildResaleFields(body: ResaleBody) {
  return {
    title: body.title!,
    description: body.description ?? "",
    price: body.price!,
    propertyType: body.propertyType!,
    city: body.city!,
    location: body.location ?? body.city!,
    mapLink: body.mapLink ?? null,
    area: body.area ?? "",
    bedrooms: body.bedrooms ?? null,
    bathrooms: body.bathrooms ?? null,
    floor: body.floor ?? null,
    totalFloors: body.totalFloors ?? null,
    amenities: body.amenities ?? [],
    possession: body.possession ?? null,
    images: body.images ?? [],
  };
}

// Public: list all Listed resale properties (no auth required)
app.get("/resale", async (req, res) => {
  try {
    const { city, type, q } = req.query as Record<string, string>;

    const snapshot = await collections.resaleProperties
      .where("status", "==", "Listed")
      .orderBy("created_at", "desc")
      .get()
      .catch((error) => {
        if (isPermissionDeniedError(error)) return null;
        throw error;
      });

    let results = snapshot ? snapshot.docs.map(mapResaleDoc) : [];

    if (q) {
      const lq = q.toLowerCase();
      results = results.filter(
        (p) =>
          p.title?.toLowerCase().includes(lq) ||
          p.location?.toLowerCase().includes(lq) ||
          p.city?.toLowerCase().includes(lq) ||
          p.description?.toLowerCase().includes(lq)
      );
    }
    if (city) {
      results = results.filter(
        (p) => p.city?.toLowerCase() === city.toLowerCase()
      );
    }
    if (type) {
      results = results.filter(
        (p) => p.propertyType?.toLowerCase() === type.toLowerCase()
      );
    }

    res.json({ resaleProperties: results });
  } catch (error: any) {
    console.error("Error fetching resale properties:", error);
    res.status(500).json({
      error: "Failed to fetch resale properties",
      detail: error?.message ?? String(error),
    });
  }
});

// Authenticated: get current user's own resale submissions
// NOTE: must be registered BEFORE /resale/:id to avoid route collision
app.get("/resale/mine", requireAuth, async (req, res) => {
  try {
    const userEmail = req.user?.email?.toLowerCase();
    if (!userEmail) {
      res.status(400).json({ error: "User email not found in token" });
      return;
    }

    const snapshot = await collections.resaleProperties
      .where("submittedBy", "==", userEmail)
      .orderBy("created_at", "desc")
      .get();

    const results = snapshot.docs.map(mapResaleDoc);
    res.json({ resaleProperties: results });
  } catch (error: any) {
    console.error("Error fetching user resale properties:", error);
    res.status(500).json({ error: "Failed to fetch your resale properties" });
  }
});

// Public: single Listed resale property by ID (no auth required)
app.get("/resale/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await collections.resaleProperties
      .doc(id)
      .get()
      .catch((error) => {
        if (isPermissionDeniedError(error)) return null;
        throw error;
      });

    if (!doc?.exists) {
      res.status(404).json({ error: "Resale property not found" });
      return;
    }

    const mapped = mapResaleDoc(doc as FirebaseFirestore.QueryDocumentSnapshot);
    if (mapped.status !== "Listed") {
      res.status(404).json({ error: "Resale property not found" });
      return;
    }

    res.json({ resaleProperty: mapped });
  } catch (error: any) {
    console.error("Error fetching resale property:", error);
    res.status(500).json({ error: "Failed to fetch resale property" });
  }
});

// Authenticated: client (or any role) submits a resale property → status Pending
app.post("/resale", requireAuth, async (req, res) => {
  try {
    if (!validateResaleBody(req.body, res)) return;

    const docRef = collections.resaleProperties.doc();
    await docRef.set({
      id: docRef.id,
      ...buildResaleFields(req.body),
      submittedBy: req.user?.email?.toLowerCase() ?? "",
      submittedByUid: req.user?.uid ?? "",
      submittedByRole: req.user?.role ?? "client",
      status: "Pending",
      remarks: null,
      approvedBy: null,
      approvedAt: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });

    res.status(201).json({ success: true, id: docRef.id });
  } catch (error: any) {
    console.error("Error submitting resale property:", error);
    res.status(500).json({ error: "Failed to submit resale property" });
  }
});

// Admin: list all resale properties with optional filters
app.get("/admin/resale", ...requireAdmin, async (req, res) => {
  try {
    const { status, city, email } = req.query as Record<string, string>;

    let query: FirebaseFirestore.Query = collections.resaleProperties.orderBy(
      "created_at",
      "desc"
    );

    if (status) query = query.where("status", "==", status);
    if (city) query = query.where("city", "==", city);
    if (email) query = query.where("submittedBy", "==", email.toLowerCase());

    const snapshot = await query.get();
    res.json({ resaleProperties: snapshot.docs.map(mapResaleDoc) });
  } catch (error: any) {
    console.error("Error fetching admin resale properties:", error);
    res.status(500).json({ error: "Failed to fetch resale properties" });
  }
});

// Admin: directly create a Listed resale property (bypasses approval)
app.post("/admin/resale", ...requireAdmin, async (req, res) => {
  try {
    if (!validateResaleBody(req.body, res)) return;

    const adminEmail = req.user?.email?.toLowerCase() ?? "";
    const docRef = collections.resaleProperties.doc();
    await docRef.set({
      id: docRef.id,
      ...buildResaleFields(req.body),
      submittedBy: adminEmail,
      submittedByUid: req.user?.uid ?? "",
      submittedByRole: req.user?.role ?? "admin",
      status: "Listed",
      remarks: null,
      approvedBy: adminEmail,
      approvedAt: FieldValue.serverTimestamp(),
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });

    res.status(201).json({ success: true, id: docRef.id });
  } catch (error: any) {
    console.error("Error creating admin resale property:", error);
    res.status(500).json({ error: "Failed to create resale property" });
  }
});

// Admin: approve or reject a resale property
app.patch("/admin/resale/:id/status", ...requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, remarks } = req.body;

    const allowedStatuses = ["Approved", "Rejected", "Listed"];
    if (!status || !allowedStatuses.includes(status)) {
      res.status(400).json({
        error: `status must be one of: ${allowedStatuses.join(", ")}`,
      });
      return;
    }

    const docRef = collections.resaleProperties.doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      res.status(404).json({ error: "Resale property not found" });
      return;
    }

    const updateData: Record<string, any> = {
      status,
      remarks: remarks ?? null,
      updated_at: FieldValue.serverTimestamp(),
    };

    if (status === "Approved" || status === "Listed") {
      updateData.status = "Listed";
      updateData.approvedBy = req.user?.email?.toLowerCase() ?? "";
      updateData.approvedAt = FieldValue.serverTimestamp();
    }

    await docRef.update(updateData);
    res.json({ success: true, id, status: updateData.status });
  } catch (error: any) {
    console.error("Error updating resale property status:", error);
    res.status(500).json({ error: "Failed to update resale property status" });
  }
});

// Admin: update resale property details
app.patch("/admin/resale/:id", ...requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const docRef = collections.resaleProperties.doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      res.status(404).json({ error: "Resale property not found" });
      return;
    }

    const updates: Record<string, any> = { updated_at: FieldValue.serverTimestamp() };
    for (const field of RESALE_EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (updates.propertyType && !ALLOWED_RESALE_PROPERTY_TYPES.has(updates.propertyType)) {
      res.status(400).json({
        error: `propertyType must be one of: ${[...ALLOWED_RESALE_PROPERTY_TYPES].join(", ")}`,
      });
      return;
    }

    await docRef.update(updates);
    res.json({ success: true, id });
  } catch (error: any) {
    console.error("Error updating resale property:", error);
    res.status(500).json({ error: "Failed to update resale property" });
  }
});

// Super Admin: hard delete a resale property
app.delete(
  "/admin/resale/:id",
  requireAuth,
  requireRole("super_admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const docRef = collections.resaleProperties.doc(id);
      const doc = await docRef.get();
      if (!doc.exists) {
        res.status(404).json({ error: "Resale property not found" });
        return;
      }

      await docRef.delete();
      res.json({ success: true, id });
    } catch (error: any) {
      console.error("Error deleting resale property:", error);
      res.status(500).json({ error: "Failed to delete resale property" });
    }
  }
);
// ─────────────────────────────────────────────────────────────────────────────
// CHAT AGENT ENDPOINTS
// All endpoints require authentication. Only clients may create/use sessions.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MESSAGES_PER_SESSION = 50;

/** Build the Firestore update payload, merging newly-collected contact fields. */
function buildSessionUpdate(
  userMsg: ChatMessage,
  aiMsg: ChatMessage,
  aiResult: import("../lib/chatAgent").ProcessMessageResult,
  session: ReturnType<typeof serializeChatSession>
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    messages: FieldValue.arrayUnion(userMsg, aiMsg),
    updated_at: FieldValue.serverTimestamp(),
  };
  const c = aiResult.collected_contact;
  if (c) {
    if (c.name && !session.user_name) update.user_name = c.name;
    if (c.phone && !session.user_phone) update.user_phone = c.phone;
    if (c.city && !session.user_city) update.user_city = c.city;
    if (c.email && !session.user_email) update.user_email = c.email;
  }
  return update;
}

/** Map Gemini / internal errors to an appropriate HTTP response. */
function handleChatError(error: any, res: import("express").Response): void {
  console.error("Error processing chat message:", error?.message ?? error);
  if (error?.message === "GEMINI_API_KEY is not configured") {
    res.status(503).json({ error: "AI service is not configured" });
  } else if (error?.status === 429 || error?.message?.includes("429") || error?.message?.includes("quota")) {
    res.status(503).json({ error: "AI service is temporarily busy. Please try again in a moment." });
  } else {
    res.status(500).json({ error: "Failed to process message" });
  }
}

/**
 * Fetch a chat session. For anonymous sessions (user_id === null) any caller
 * who knows the session ID may access it. For authenticated sessions the
 * provided uid must match.
 */
async function getChatSessionForUser(
  sessionId: string,
  uid: string | null
): Promise<
  | { session: ReturnType<typeof serializeChatSession>; error?: never }
  | { session?: never; error: { status: number; message: string } }
> {
  const doc = await collections.chatSessions.doc(sessionId).get();
  if (!doc.exists) {
    return { error: { status: 404, message: "Session not found" } };
  }
  const session = serializeChatSession(doc);
  // Anonymous sessions are accessible by session ID alone
  if (session.user_id !== null && session.user_id !== uid) {
    return { error: { status: 403, message: "Access denied" } };
  }
  return { session };
}

// ─── Neural TTS voice map ──────────────────────────────────────────────────────
const TTS_VOICES: Record<string, { name: string; ssmlGender: string }> = {
  "en-IN": { name: "en-IN-Neural2-A", ssmlGender: "FEMALE" },
  "en-IN-Neural2-D": { name: "en-IN-Neural2-D", ssmlGender: "FEMALE" },
  "hi-IN": { name: "hi-IN-Neural2-A", ssmlGender: "FEMALE" },
  "ta-IN": { name: "ta-IN-Neural2-A", ssmlGender: "FEMALE" },
  "te-IN": { name: "te-IN-Standard-A", ssmlGender: "FEMALE" },
  "kn-IN": { name: "kn-IN-Wavenet-A",  ssmlGender: "FEMALE" },
};

// POST /chat/tts — convert text to speech using Google Cloud TTS Neural2 (no auth required)
app.post("/chat/tts", async (req, res) => {
  try {
    const { text, languageCode = "en-IN", voiceName } = req.body as {
      text?: string; languageCode?: string; voiceName?: string;
    };
    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const defaultVoice = TTS_VOICES[languageCode] ?? TTS_VOICES["en-IN"];
    const resolvedVoiceName = voiceName ?? defaultVoice.name;

    const credential = (await import("firebase-admin/app")).getApp().options.credential!;
    const { access_token: accessToken } = await credential.getAccessToken();

    const ttsRes = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text: text.slice(0, 4500) },
        voice: { languageCode, name: resolvedVoiceName, ssmlGender: defaultVoice.ssmlGender },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1, pitch: 0 },
      }),
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      console.error("Google TTS error:", errText);
      res.status(502).json({ error: "TTS generation failed" });
      return;
    }

    const data = await ttsRes.json() as { audioContent: string };
    res.json({ audioContent: data.audioContent });
  } catch (error: any) {
    console.error("Error in TTS endpoint:", error?.message ?? error);
    res.status(500).json({ error: "TTS generation failed" });
  }
});

// POST /chat/sessions — create a new chat session (no auth required)
app.post(
  "/chat/sessions",
  optionalAuth,
  async (req, res) => {
    try {
      const uid = req.user?.uid ?? null;
      const email = req.user?.email ?? "";

      // Fetch profile for authenticated users
      let userName = "";
      let userPhone = "";
      if (uid) {
        const userDoc = await collections.users.doc(uid).get().catch(() => null);
        if (userDoc?.exists) {
          const ud = userDoc.data() || {};
          userName = ud.name ?? ud.displayName ?? "";
          userPhone = ud.phone ?? ud.phoneNumber ?? "";
        }
      }

      const ref = collections.chatSessions.doc();
      await ref.set({
        id: ref.id,
        user_id: uid,
        user_name: userName,
        user_email: email,
        user_phone: userPhone,
        user_city: "",
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
        messages: [],
        enquiry_ids: [],
      });

      res.status(201).json({ session_id: ref.id });
    } catch (error: any) {
      console.error("Error creating chat session:", error);
      res.status(500).json({ error: "Failed to create chat session" });
    }
  }
);

// GET /chat/sessions — list the authenticated client's sessions
app.get(
  "/chat/sessions",
  requireAuth,
  requireRole("client"),
  async (req, res) => {
    try {
      const uid = req.user!.uid;
      const snap = await collections.chatSessions
        .where("user_id", "==", uid)
        .orderBy("updated_at", "desc")
        .limit(20)
        .get();

      const sessions = snap.docs.map((doc) => {
        const s = serializeChatSession(doc);
        return {
          id: s.id,
          created_at: s.created_at,
          updated_at: s.updated_at,
          message_count: s.messages.length,
          enquiry_count: s.enquiry_ids.length,
          // Include only the last message as preview
          last_message: s.messages.at(-1) ?? null,
        };
      });

      res.json({ sessions });
    } catch (error: any) {
      console.error("Error fetching chat sessions:", error);
      res.status(500).json({ error: "Failed to fetch chat sessions" });
    }
  }
);

// GET /chat/sessions/:id — get a session with full message history
app.get(
  "/chat/sessions/:id",
  requireAuth,
  requireRole("client"),
  async (req, res) => {
    try {
      const uid = req.user!.uid;
      const result = await getChatSessionForUser(req.params.id, uid);
      if (result.error) {
        res.status(result.error.status).json({ error: result.error.message });
        return;
      }

      res.json({ session: result.session });
    } catch (error: any) {
      console.error("Error fetching chat session:", error);
      res.status(500).json({ error: "Failed to fetch chat session" });
    }
  }
);

// DELETE /chat/sessions/:id — delete a session
app.delete(
  "/chat/sessions/:id",
  requireAuth,
  requireRole("client"),
  async (req, res) => {
    try {
      const uid = req.user!.uid;
      const result = await getChatSessionForUser(req.params.id, uid);
      if (result.error) {
        res.status(result.error.status).json({ error: result.error.message });
        return;
      }

      await collections.chatSessions.doc(req.params.id).delete();
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting chat session:", error);
      res.status(500).json({ error: "Failed to delete chat session" });
    }
  }
);

// POST /chat/sessions/:id/message — send a message and get AI reply (no auth required)
app.post(
  "/chat/sessions/:id/message",
  optionalAuth,
  async (req, res) => {
    try {
      const uid = req.user?.uid ?? null;
      const { id } = req.params;
      const { message } = req.body as { message?: string };

      if (!message || typeof message !== "string" || message.trim() === "") {
        res.status(400).json({ error: "message is required" });
        return;
      }
      if (message.length > 2000) {
        res.status(400).json({ error: "message too long (max 2000 characters)" });
        return;
      }

      const sessionResult = await getChatSessionForUser(id, uid);
      if (sessionResult.error) {
        res.status(sessionResult.error.status).json({ error: sessionResult.error.message });
        return;
      }
      const session = sessionResult.session;

      if (session.messages.length >= MAX_MESSAGES_PER_SESSION) {
        res.status(429).json({
          error: "Session message limit reached. Please start a new session.",
        });
        return;
      }

      // Gather user info for enquiry creation (AI collects these via conversation)
      const userName = session.user_name || req.user?.name || req.user?.email || "";
      const userPhone = session.user_phone || "";
      const userEmail = req.user?.email ?? session.user_email ?? "";

      const userMsg: ChatMessage = {
        role: "user",
        content: message.trim(),
        timestamp: new Date().toISOString(),
      };

      // Process with Gemini
      const aiResult = await processMessage(id, message.trim(), {
        uid: uid ?? "",
        name: userName,
        phone: userPhone,
        email: userEmail,
      }, session.messages);

      const aiMsg: ChatMessage = {
        role: "model",
        content: aiResult.reply,
        timestamp: new Date().toISOString(),
        ...(aiResult.tool_results ? { tool_results: aiResult.tool_results } : {}),
      };

      // Build session update: persist messages + any contact info collected this turn
      const sessionUpdate = buildSessionUpdate(userMsg, aiMsg, aiResult, session);
      await collections.chatSessions.doc(id).update(sessionUpdate);

      res.json({
        reply: aiResult.reply,
        tool_results: aiResult.tool_results ?? null,
      });
    } catch (error: any) {
      handleChatError(error, res);
    }
  }
);

// ── Export as Cloud Function ─────────────────────────────────────────

export const api = onRequest(
  {
    serviceAccount: "howzy-api@appspot.gserviceaccount.com",
    secrets: [
      "GEMINI_API_KEY",
      "CLOUD_SQL_INSTANCE",
      "DB_NAME",
      "DB_USER",
      "BACKUP_SHEET_ID",
    ],
  },
  app
);
