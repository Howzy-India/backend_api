import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, auth, FieldValue } from "../lib/firestore";

function assertRole(
  contextRole: string | undefined,
  allowed: string[]
): void {
  if (!contextRole || !allowed.includes(contextRole)) {
    throw new HttpsError(
      "permission-denied",
      "You do not have permission for this operation."
    );
  }
}

export const createUserWithRole = onCall(async (request) => {
  const callerRole = request.auth?.token.role as string | undefined;
  assertRole(callerRole, ["super_admin"]);

  const { email, password, displayName, role } = request.data ?? {};
  if (!email || !password || !displayName || !role) {
    throw new HttpsError(
      "invalid-argument",
      "email, password, displayName and role are required."
    );
  }

  if (!["admin", "agent"].includes(role)) {
    throw new HttpsError(
      "invalid-argument",
      "Only admin and agent roles can be created."
    );
  }

  const userRecord = await auth.createUser({ email, password, displayName });
  await auth.setCustomUserClaims(userRecord.uid, { role });
  await db
    .collection("users")
    .doc(userRecord.uid)
    .set({
      email,
      displayName,
      role,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: request.auth?.uid,
    });

  return { uid: userRecord.uid };
});

export const updateUserRole = onCall(async (request) => {
  const callerRole = request.auth?.token.role as string | undefined;
  assertRole(callerRole, ["super_admin"]);

  const { uid, role } = request.data ?? {};
  if (!uid || !role) {
    throw new HttpsError("invalid-argument", "uid and role are required.");
  }

  if (!["admin", "agent"].includes(role)) {
    throw new HttpsError(
      "invalid-argument",
      "Only admin and agent roles are allowed."
    );
  }

  await auth.setCustomUserClaims(uid, { role });
  await db.collection("users").doc(uid).set(
    {
      role,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: request.auth?.uid,
    },
    { merge: true }
  );

  return { success: true };
});

export const setUserDisabled = onCall(async (request) => {
  const callerRole = request.auth?.token.role as string | undefined;
  assertRole(callerRole, ["super_admin"]);

  const { uid, disabled } = request.data ?? {};
  if (!uid || typeof disabled !== "boolean") {
    throw new HttpsError(
      "invalid-argument",
      "uid and disabled are required."
    );
  }

  await auth.updateUser(uid, { disabled });
  await db
    .collection("users")
    .doc(uid)
    .set(
      {
        status: disabled ? "disabled" : "active",
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: request.auth?.uid,
      },
      { merge: true }
    );

  return { success: true };
});

export const deleteUser = onCall(async (request) => {
  const callerRole = request.auth?.token.role as string | undefined;
  assertRole(callerRole, ["super_admin"]);

  const { uid } = request.data ?? {};
  if (!uid) {
    throw new HttpsError("invalid-argument", "uid is required.");
  }

  const userDoc = await db.collection("users").doc(uid).get();
  const role = userDoc.data()?.role;
  if (!["admin", "agent"].includes(role)) {
    throw new HttpsError(
      "failed-precondition",
      "Only admin or agent users can be deleted."
    );
  }

  await auth.deleteUser(uid);
  await db.collection("users").doc(uid).delete();
  return { success: true };
});
