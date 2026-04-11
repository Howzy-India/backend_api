import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db, auth, FieldValue } from "../lib/firestore";

const bootstrapKey = defineSecret("HOWZY_BOOTSTRAP_KEY");

export type AppRole =
  | "super_admin"
  | "admin"
  | "sales_agent"
  | "sourcing_agent"
  | "howzer_sourcing"
  | "howzer_sales"
  | "client";

const VALID_ROLES: AppRole[] = [
  "super_admin",
  "admin",
  "sales_agent",
  "sourcing_agent",
  "howzer_sourcing",
  "howzer_sales",
  "client",
];

function toValidRole(raw: unknown): AppRole {
  return (VALID_ROLES as string[]).includes(raw as string)
    ? (raw as AppRole)
    : "client";
}

async function migratePendingDoc(
  uid: string,
  phone: string,
  firebaseUser: { phoneNumber?: string | null; email?: string | null; displayName?: string | null }
): Promise<AppRole | null> {
  const pendingId = `pending_${phone.replaceAll(/\D/g, "")}`;
  const pendingSnap = await db.collection("users").doc(pendingId).get();
  if (!pendingSnap.exists) return null;

  const pendingData = pendingSnap.data()!;
  const role = toValidRole(pendingData.role);

  await db.collection("users").doc(uid).set({
    ...pendingData,
    uid,
    phone: firebaseUser.phoneNumber ?? null,
    email: firebaseUser.email ?? null,
    createdAt: pendingData.createdAt ?? FieldValue.serverTimestamp(),
    lastLoginAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await db.collection("users").doc(pendingId).delete();

  // Sync name into Firebase Auth displayName so the profile badge shows the real name
  const pendingName = (pendingData.name as string | undefined) ?? null;
  if (pendingName && !firebaseUser.displayName) {
    await auth.updateUser(uid, { displayName: pendingName });
  }

  return role;
}

async function registerNewClient(
  uid: string,
  firebaseUser: { phoneNumber?: string | null; email?: string | null; displayName?: string | null }
): Promise<void> {
  await db.collection("users").doc(uid).set({
    uid,
    phone: firebaseUser.phoneNumber ?? null,
    email: firebaseUser.email ?? null,
    displayName: firebaseUser.displayName ?? null,
    role: "client",
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    lastLoginAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Called by the frontend immediately after OTP verification.
 * Reads the user's role from Firestore `users/{uid}`:
 *   - If the doc exists → syncs the role as a Firebase custom claim.
 *   - If no doc exists  → creates one with role="client" and sets the claim.
 * Returns { role, profile } so the client knows which dashboard to show.
 */
export const syncUserRole = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const uid = request.auth.uid;
  const firebaseUser = await auth.getUser(uid);
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();

  let role: AppRole = "client";

  if (snap.exists) {
    role = toValidRole(snap.data()!.role);
    await userRef.set({ lastLoginAt: FieldValue.serverTimestamp() }, { merge: true });
  } else {
    const phone = firebaseUser.phoneNumber;
    const migratedRole = phone ? await migratePendingDoc(uid, phone, firebaseUser) : null;

    if (migratedRole === null) {
      await registerNewClient(uid, firebaseUser);
    } else {
      role = migratedRole;
    }
  }

  const current = firebaseUser.customClaims ?? {};
  if (current.role !== role) {
    await auth.setCustomUserClaims(uid, { role });
  }

  const profile = (await userRef.get()).data();
  return { role, profile };
});

/**
 * One-time HTTP endpoint to pre-create / update a user's role in Firestore.
 * Protected by HOWZY_BOOTSTRAP_KEY.
 *
 * Body: { phone, role, displayName }
 * Example: { "phone": "+918919325458", "role": "super_admin", "displayName": "Super Admin" }
 */
export const seedUserRole = onRequest(
  { secrets: [bootstrapKey] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only." });
      return;
    }

    const provided = String(req.headers["x-bootstrap-key"] ?? "").trim();
    if (provided !== bootstrapKey.value().trim()) {
      res.status(403).json({ error: "Invalid bootstrap key." });
      return;
    }

    const { phone, role, displayName } = req.body ?? {};
    if (!phone || !role) {
      res.status(400).json({ error: "phone and role are required." });
      return;
    }
    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` });
      return;
    }

    // Try to find an existing Firebase Auth user by phone
    let uid: string | null = null;
    try {
      const existing = await auth.getUserByPhoneNumber(phone);
      uid = existing.uid;
      await auth.setCustomUserClaims(uid, { role });
    } catch {
      // User hasn't logged in yet — that's fine, claims are set on first syncUserRole call
    }

    const docId = uid ?? `pending_${phone.replaceAll(/\D/g, "")}`;
    await db
      .collection("users")
      .doc(docId)
      .set(
        {
          phone,
          displayName: displayName ?? role,
          role,
          status: "active",
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    res.status(200).json({
      success: true,
      uid: docId,
      phone,
      role,
      claimsSet: uid !== null,
    });
  }
);

