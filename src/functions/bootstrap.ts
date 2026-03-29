import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { db, auth, FieldValue } from "../lib/firestore";

const bootstrapKey = defineSecret("HOWZY_BOOTSTRAP_KEY");

export const bootstrapSuperAdmin = onRequest(
  { secrets: [bootstrapKey] },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).json({ error: "Method not allowed." });
      return;
    }

    const providedKey = request.headers["x-bootstrap-key"];
    if (providedKey !== bootstrapKey.value()) {
      response.status(403).json({ error: "Invalid bootstrap key." });
      return;
    }

    const email = request.body?.email?.toString().trim().toLowerCase();
    if (!email) {
      response.status(400).json({ error: "email is required." });
      return;
    }

    let user;
    try {
      user = await auth.getUserByEmail(email);
    } catch {
      user = await auth.createUser({
        email,
        emailVerified: true,
        displayName: email,
      });
    }
    await auth.setCustomUserClaims(user.uid, { role: "super_admin" });

    await db
      .collection("users")
      .doc(user.uid)
      .set(
        {
          email,
          displayName: user.displayName ?? email,
          role: "super_admin",
          status: "active",
          bootstrap: true,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    response.status(200).json({ success: true, uid: user.uid });
  }
);
