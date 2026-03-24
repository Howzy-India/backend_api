// ── Callable Cloud Functions ─────────────────────────────────────────
export {
  createUserWithRole,
  updateUserRole,
  setUserDisabled,
  deleteUser,
} from "./functions/users";

export {
  submitBuilderForApproval,
  approveBuilder,
  rejectBuilder,
  deleteBuilderIfUnapproved,
} from "./functions/builders";

export { bootstrapSuperAdmin } from "./functions/bootstrap";

// ── HTTP API (Express on Cloud Functions) ────────────────────────────
export { api } from "./api/index";
