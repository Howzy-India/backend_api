import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, FieldValue } from "../lib/firestore";

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

export const submitBuilderForApproval = onCall(async (request) => {
  const callerRole = request.auth?.token.role as string | undefined;
  assertRole(callerRole, ["admin", "super_admin"]);

  const { builderId } = request.data ?? {};
  if (!builderId) {
    throw new HttpsError("invalid-argument", "builderId is required.");
  }

  const builderRef = db.collection("builders").doc(builderId);
  const builderDoc = await builderRef.get();
  if (!builderDoc.exists) {
    throw new HttpsError("not-found", "Builder not found.");
  }

  await db.runTransaction(async (tx) => {
    tx.update(builderRef, {
      onboardingStatus: "pending",
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(db.collection("approvals").doc(), {
      entityType: "builder",
      entityId: builderId,
      status: "pending",
      requestedBy: request.auth?.uid,
      requestedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const approveBuilder = onCall(async (request) => {
  const callerRole = request.auth?.token.role as string | undefined;
  assertRole(callerRole, ["super_admin"]);

  const { approvalId, remarks } = request.data ?? {};
  if (!approvalId) {
    throw new HttpsError("invalid-argument", "approvalId is required.");
  }

  const approvalRef = db.collection("approvals").doc(approvalId);
  const approvalDoc = await approvalRef.get();
  if (!approvalDoc.exists) {
    throw new HttpsError("not-found", "Approval request not found.");
  }

  const approval = approvalDoc.data();
  if (approval?.status !== "pending") {
    throw new HttpsError(
      "failed-precondition",
      "Approval request already resolved."
    );
  }

  const builderRef = db.collection("builders").doc(approval?.entityId);
  const builderDoc = await builderRef.get();
  const builderData = builderDoc.data();

  await db.runTransaction(async (tx) => {
    tx.update(approvalRef, {
      status: "approved",
      reviewedBy: request.auth?.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      remarks: remarks ?? null,
    });

    tx.update(builderRef, {
      onboardingStatus: "approved",
      approvedByUid: request.auth?.uid,
      approvedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(
      db.collection("projects").doc(approval?.entityId),
      {
        builderId: approval?.entityId,
        name: builderData?.name ?? "Untitled Project",
        city: builderData?.city ?? "",
        location: builderData?.location ?? "",
        developerName:
          builderData?.developerName ?? builderData?.name ?? "",
        visibilityStatus: "listed",
        publishedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(db.collection("auditLogs").doc(), {
      actorUid: request.auth?.uid,
      action: "APPROVE_BUILDER",
      entityType: "builder",
      entityId: approval?.entityId,
      at: FieldValue.serverTimestamp(),
      remarks: remarks ?? null,
    });
  });

  return { success: true };
});

export const rejectBuilder = onCall(async (request) => {
  const callerRole = request.auth?.token.role as string | undefined;
  assertRole(callerRole, ["super_admin"]);

  const { approvalId, remarks } = request.data ?? {};
  if (!approvalId || !remarks) {
    throw new HttpsError(
      "invalid-argument",
      "approvalId and remarks are required."
    );
  }

  const approvalRef = db.collection("approvals").doc(approvalId);
  const approvalDoc = await approvalRef.get();
  if (!approvalDoc.exists) {
    throw new HttpsError("not-found", "Approval request not found.");
  }

  const approval = approvalDoc.data();
  const builderRef = db.collection("builders").doc(approval?.entityId);

  await db.runTransaction(async (tx) => {
    tx.update(approvalRef, {
      status: "rejected",
      reviewedBy: request.auth?.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      remarks,
    });

    tx.update(builderRef, {
      onboardingStatus: "rejected",
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.set(db.collection("auditLogs").doc(), {
      actorUid: request.auth?.uid,
      action: "REJECT_BUILDER",
      entityType: "builder",
      entityId: approval?.entityId,
      at: FieldValue.serverTimestamp(),
      remarks,
    });
  });

  return { success: true };
});

export const deleteBuilderIfUnapproved = onCall(async (request) => {
  const callerRole = request.auth?.token.role as string | undefined;
  assertRole(callerRole, ["admin", "super_admin"]);

  const { builderId } = request.data ?? {};
  if (!builderId) {
    throw new HttpsError("invalid-argument", "builderId is required.");
  }

  const builderRef = db.collection("builders").doc(builderId);
  const doc = await builderRef.get();
  if (!doc.exists) {
    throw new HttpsError("not-found", "Builder not found.");
  }

  const status = doc.data()?.onboardingStatus;
  if (status === "approved") {
    throw new HttpsError(
      "failed-precondition",
      "Approved builders cannot be deleted."
    );
  }

  await builderRef.delete();
  return { success: true };
});
