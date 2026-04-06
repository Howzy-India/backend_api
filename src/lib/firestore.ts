import * as admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();
export const storage: admin.storage.Storage = admin.storage();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;

export const collections = {
  projects: db.collection("projects"),
  leads: db.collection("leads"),
  bookings: db.collection("bookings"),
  submissions: db.collection("submissions"),
  enquiries: db.collection("enquiries"),
  enquiryTimeline: db.collection("enquiry_timeline"),
  clientLogins: db.collection("client_logins"),
  users: db.collection("users"),
  builders: db.collection("builders"),
  approvals: db.collection("approvals"),
  auditLogs: db.collection("auditLogs"),
  attendance: db.collection("attendance"),
  locationLogs: db.collection("location_logs"),
  resaleProperties: db.collection("resale_properties"),
};
