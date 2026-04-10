import { Request, Response, NextFunction } from "express";
import * as admin from "firebase-admin";

/**
 * Verifies the Firebase ID token from the Authorization header and attaches
 * the decoded claims to `req.user`. Returns 401 if the token is missing or
 * invalid, 403 if the token is revoked.
 */
export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: missing token" });
    return;
  }

  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      role: decoded.role as string | undefined,
    };
    next();
  } catch (err: any) {
    const isRevoked =
      err?.code === "auth/id-token-revoked" ||
      err?.code === "auth/user-disabled";
    res
      .status(isRevoked ? 403 : 401)
      .json({ error: isRevoked ? "Forbidden: token revoked" : "Unauthorized: invalid token" });
  }
};

/**
 * Returns an Express middleware that ensures the authenticated user holds one
 * of the specified roles (stored as a custom claim). Must be used after
 * `requireAuth`.
 */
export const requireRole =
  (...roles: string[]) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const userRole = req.user?.role;
    if (!userRole || !roles.includes(userRole)) {
      res.status(403).json({
        error: `Forbidden: requires one of [${roles.join(", ")}]`,
      });
      return;
    }
    next();
  };

/** Shorthand — admin or super_admin */
export const requireAdmin = [
  requireAuth,
  requireRole("admin", "super_admin"),
];

/**
 * Optional auth — if a Bearer token is present, verify it and attach the user
 * to `req.user`. If no token is provided, continue as anonymous (req.user
 * remains undefined). Never returns 401.
 */
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const idToken = authHeader.split("Bearer ")[1];
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.user = {
        uid: decoded.uid,
        email: decoded.email,
        role: decoded.role as string | undefined,
      };
    } catch {
      // Invalid token — treat as anonymous
    }
  }
  next();
};
