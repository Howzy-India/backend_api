import { onRequest } from "firebase-functions/v2/https";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomInt } from "node:crypto";
import { google } from "googleapis";
import { collections, FieldValue, db, storage, auth } from "../lib/firestore";
import {
  mapProjectDoc,
  mapSubmissionDoc,
  submissionToProperty,
  mapLeadDoc,
  mapEnquiryDoc,
  mapBookingDoc,
  mapLoginDoc,
  mapUserDoc,
} from "../lib/mappers";
import {
  allowedSubmissionTypes,
  chunkArray,
  formatCurrency,
  toISODate,
} from "../lib/helpers";
import { requireAuth, requireAdmin, requireRole } from "../middleware/auth";

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
  return trimmed ? trimmed : undefined;
};

const assertManageableAdminUser = async (uid: string) => {
  if (!uid) {
    throw new ApiHttpError(400, "uid is required");
  }

  const [authUser, userDoc] = await Promise.all([
    auth.getUser(uid),
    collections.users.doc(uid).get(),
  ]);

  const existingRole =
    (authUser.customClaims?.role as string | undefined) ??
    (userDoc.data()?.role as string | undefined);

  if (existingRole !== "admin") {
    throw new ApiHttpError(
      400,
      "Only admin users can be managed from this endpoint"
    );
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

app.get("/projects", async (req, res) => {
  try {
    const { location, type, city, q } = req.query as Record<string, string>;

    const [projectsSnapshot, submissionsSnapshot] = await Promise.all([
      collections.projects
        .orderBy("created_at", "desc")
        .get()
        .catch((error) => {
          if (isPermissionDeniedError(error)) {
            console.warn(
              "Projects read denied while fetching public projects. Returning empty projects list."
            );
            return null;
          }
          return collections.projects.get().catch((fallbackError) => {
            if (isPermissionDeniedError(fallbackError)) {
              console.warn(
                "Projects read denied while fetching public projects. Returning empty projects list."
              );
              return null;
            }
            throw fallbackError;
          });
        }),
      collections.submissions
        .where("status", "==", "Approved")
        .get()
        .catch((error) => {
          if (isPermissionDeniedError(error)) {
            console.warn(
              "Submissions read denied while fetching public projects. Returning projects only."
            );
            return null;
          }
          throw error;
        }),
    ]);

    const mappedProjects = projectsSnapshot ? projectsSnapshot.docs.map(mapProjectDoc) : [];
    const mappedSubmissions = submissionsSnapshot
      ? submissionsSnapshot.docs
          .map(mapSubmissionDoc)
          .filter((s) => allowedSubmissionTypes.has(s.type))
          .map(submissionToProperty)
      : [];

    let combined = [...mappedProjects, ...mappedSubmissions].sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Apply optional public search/filter params
    if (q) {
      const lq = q.toLowerCase();
      combined = combined.filter(
        (p) =>
          p.name?.toLowerCase().includes(lq) ||
          p.location?.toLowerCase().includes(lq) ||
          p.city?.toLowerCase().includes(lq) ||
          p.developerName?.toLowerCase().includes(lq)
      );
    }
    if (location) {
      const ll = location.toLowerCase();
      combined = combined.filter(
        (p) => p.location?.toLowerCase().includes(ll) || p.city?.toLowerCase().includes(ll)
      );
    }
    if (city) {
      combined = combined.filter((p) => p.city?.toLowerCase() === city.toLowerCase());
    }
    if (type) {
      combined = combined.filter(
        (p) =>
          p.projectType?.toLowerCase() === type.toLowerCase() ||
          p.propertyType?.toLowerCase() === type.toLowerCase()
      );
    }

    res.json({ projects: combined });
  } catch (error: any) {
    console.error("Error fetching projects:", error);
    res.status(500).json({ error: "Failed to fetch projects", detail: error?.message ?? String(error) });
  }
});

// Single project by ID (public)
app.get("/projects/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const projectDoc = await collections.projects
      .doc(id)
      .get()
      .catch((error) => {
        if (isPermissionDeniedError(error)) {
          console.warn(
            "Projects read denied while fetching single public project. Returning not found."
          );
          return null;
        }
        throw error;
      });

    if (projectDoc?.exists) {
      return res.json({ project: mapProjectDoc(projectDoc as any) });
    }

    const submissionDoc = await collections.submissions
      .doc(id)
      .get()
      .catch((error) => {
        if (isPermissionDeniedError(error)) {
          console.warn(
            "Submissions read denied while fetching single public project. Returning projects only."
          );
          return null;
        }
        throw error;
      });

    if (!submissionDoc) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (submissionDoc.exists) {
      const mapped = mapSubmissionDoc(submissionDoc as any);
      if (allowedSubmissionTypes.has(mapped.type)) {
        return res.json({ project: submissionToProperty(mapped) });
      }
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
    const snapshot = await collections.users
      .where("role", "==", "admin")
      .orderBy("createdAt", "desc")
      .get()
      .catch(() => collections.users.where("role", "==", "admin").get());

    const users = snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        uid: doc.id,
        email: data.email ?? "",
        displayName: data.displayName ?? data.name ?? "",
        role: data.role ?? "admin",
        status: data.status ?? "active",
        createdAt: toISODate(data.createdAt ?? data.created_at),
      };
    });

    res.json({ users });
  } catch (error) {
    console.error("Error fetching admin users:", error);
    res.status(500).json({ error: "Failed to fetch admin users" });
  }
});

app.post("/admin/users", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { email, password, displayName } = req.body ?? {};
    if (!email || !password || !displayName) {
      res.status(400).json({ error: "email, password and displayName are required" });
      return;
    }

    const userRecord = await auth.createUser({ email, password, displayName });
    await auth.setCustomUserClaims(userRecord.uid, { role: "admin" });

    await collections.users.doc(userRecord.uid).set({
      email,
      displayName,
      name: displayName,
      role: "admin",
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user?.uid,
    });

    res.json({ success: true, uid: userRecord.uid });
  } catch (error) {
    console.error("Error creating admin user:", error);
    res.status(500).json({ error: "Failed to create admin user" });
  }
});

app.patch("/admin/users/:uid", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { uid } = req.params;
    await assertManageableAdminUser(uid);
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
    res.json({ success: true });
  } catch (error) {
    handleAdminUserApiError("updating admin user", error, res);
  }
});

app.delete("/admin/users/:uid", requireAuth, requireRole("super_admin"), async (req, res) => {
  try {
    const { uid } = req.params;
    await assertManageableAdminUser(uid);

    await auth.deleteUser(uid);
    await collections.users.doc(uid).delete();
    res.json({ success: true });
  } catch (error) {
    handleAdminUserApiError("deleting admin user", error, res);
  }
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
    res.json({ logins });
  } catch (error) {
    console.error("Error fetching client logins:", error);
    res.json({ logins: [] });
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
      .where("status", "==", "Approved")
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
      .filter(
        (doc) =>
          doc.data().email === email && doc.data().status === "Approved"
      )
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

app.get("/partner/assigned-enquiries", requireAuth, requireRole("partner", "admin", "super_admin"), async (_req, res) => {
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
  requireRole("partner", "admin", "super_admin"),
  async (req, res) => {
    try {
      const email = req.user?.email;
      if (!email) {
        res.status(400).json({ error: "Email not found in token" });
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
  requireRole("partner", "admin", "super_admin"),
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

// ── Export as Cloud Function ─────────────────────────────────────────

export const api = onRequest({ serviceAccount: "howzy-api@appspot.gserviceaccount.com" }, app);
