import "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      uid: string;
      email?: string;
      phone?: string;
      role?: string;
      name?: string;
    };
  }
}
