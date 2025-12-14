/**
 * Authentication and Authorization middleware for ALB OIDC integration.
 * 
 * When running behind AWS ALB with OIDC authentication, the ALB sets these headers:
 * - x-amzn-oidc-accesstoken: The access token from the IdP
 * - x-amzn-oidc-identity: The user identity (usually email or sub)
 * - x-amzn-oidc-data: JWT containing user claims (base64url encoded payload)
 * 
 * For local development without ALB:
 * - Set LOCAL_DEV_USER env var to simulate a logged-in user
 * - Example: LOCAL_DEV_USER=developer@example.com npm run dev
 */

import { Request, Response, NextFunction } from 'express';
import { UserInfo, AdminConfig } from './types';
import * as state from './state-index';
import { serverLog } from './logger';

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: UserInfo;
      isAdmin?: boolean;
    }
  }
}

/**
 * Decode a base64url string (used in JWTs)
 */
function base64urlDecode(str: string): string {
  // Replace base64url chars with base64 chars
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  const padded = base64 + '=='.slice(0, (4 - base64.length % 4) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Extract user info from ALB OIDC headers
 */
function extractUserFromHeaders(req: Request): UserInfo | undefined {
  // For local development, use LOCAL_DEV_USER env var
  if (process.env.LOCAL_DEV_USER) {
    return {
      email: process.env.LOCAL_DEV_USER,
      name: process.env.LOCAL_DEV_USER.split('@')[0],
      sub: process.env.LOCAL_DEV_USER
    };
  }

  // Check for ALB OIDC data header (JWT with claims)
  const oidcData = req.headers['x-amzn-oidc-data'] as string | undefined;
  if (oidcData) {
    try {
      // JWT format: header.payload.signature
      const parts = oidcData.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(base64urlDecode(parts[1]));
        return {
          email: payload.email || payload.preferred_username || payload.upn,
          name: payload.name || payload.given_name,
          sub: payload.sub,
          raw: payload
        };
      }
    } catch (error) {
      serverLog.warn(`Failed to parse OIDC data header: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Fallback to x-amzn-oidc-identity header (simpler, just the identity)
  const identity = req.headers['x-amzn-oidc-identity'] as string | undefined;
  if (identity) {
    return {
      email: identity,
      sub: identity
    };
  }

  return undefined;
}

/**
 * Get user identifier for admin list (prefer email, fallback to sub)
 */
export function getUserIdentifier(user: UserInfo | undefined): string | undefined {
  if (!user) return undefined;
  return user.email || user.sub;
}

/**
 * Middleware to extract user info and check admin status
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.user = extractUserFromHeaders(req);
  
  // Check if user is admin
  const adminConfig = state.getAdminConfig();
  const userIdentifier = getUserIdentifier(req.user);
  
  if (!adminConfig.enabled) {
    // Admin mode not enabled, everyone is effectively an admin
    req.isAdmin = true;
  } else if (userIdentifier && adminConfig.admins.includes(userIdentifier)) {
    req.isAdmin = true;
  } else {
    req.isAdmin = false;
  }

  next();
}

/**
 * Middleware to require admin access for write operations
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminConfig = state.getAdminConfig();
  
  // If admin mode is not enabled, allow all
  if (!adminConfig.enabled) {
    return next();
  }

  // Check if user is an admin
  if (req.isAdmin) {
    return next();
  }

  // Not authorized
  const userIdentifier = getUserIdentifier(req.user);
  serverLog.warn(`Unauthorized access attempt by ${userIdentifier || 'unknown user'} to ${req.method} ${req.path}`);
  
  res.status(403).json({
    error: 'Forbidden',
    message: 'Administrator access required. You are in read-only mode.'
  });
}

/**
 * Enable admin mode. Retains existing admin list if re-enabling, adds enabler if not already admin.
 */
export async function enableAdminMode(enablerEmail: string): Promise<{ success: boolean; message: string }> {
  const adminConfig = state.getAdminConfig();
  
  if (adminConfig.enabled) {
    return { success: false, message: 'Admin mode is already enabled' };
  }

  // Preserve existing admin list, add enabler if not already present
  const existingAdmins = adminConfig.admins || [];
  const admins = existingAdmins.includes(enablerEmail) 
    ? existingAdmins 
    : [...existingAdmins, enablerEmail];

  await state.setAdminConfig({
    enabled: true,
    admins
  });

  serverLog.info(`Admin mode enabled by ${enablerEmail}`);
  
  const message = existingAdmins.length > 0 && existingAdmins.includes(enablerEmail)
    ? 'Admin mode enabled. Previous administrator list restored.'
    : existingAdmins.length > 0
    ? `Admin mode enabled. ${enablerEmail} added to existing administrators.`
    : `Admin mode enabled. ${enablerEmail} is now an administrator.`;
  
  return { success: true, message };
}

/**
 * Disable admin mode (requires admin access)
 */
export async function disableAdminMode(): Promise<{ success: boolean; message: string }> {
  const adminConfig = state.getAdminConfig();
  
  if (!adminConfig.enabled) {
    return { success: false, message: 'Admin mode is not enabled' };
  }

  await state.setAdminConfig({
    enabled: false,
    admins: adminConfig.admins // Keep the list for when it's re-enabled
  });

  serverLog.info('Admin mode disabled');
  
  return { success: true, message: 'Admin mode disabled. All users now have full access.' };
}

/**
 * Add an admin (requires admin access)
 */
export async function addAdmin(email: string): Promise<{ success: boolean; message: string }> {
  const adminConfig = state.getAdminConfig();
  
  if (!adminConfig.enabled) {
    return { success: false, message: 'Admin mode is not enabled' };
  }

  if (adminConfig.admins.includes(email)) {
    return { success: false, message: `${email} is already an administrator` };
  }

  await state.setAdminConfig({
    ...adminConfig,
    admins: [...adminConfig.admins, email]
  });

  serverLog.info(`Added admin: ${email}`);
  
  return { success: true, message: `${email} added as administrator` };
}

/**
 * Remove an admin (requires admin access, cannot remove yourself if you're the last admin)
 */
export async function removeAdmin(email: string, currentUserEmail: string): Promise<{ success: boolean; message: string }> {
  const adminConfig = state.getAdminConfig();
  
  if (!adminConfig.enabled) {
    return { success: false, message: 'Admin mode is not enabled' };
  }

  if (!adminConfig.admins.includes(email)) {
    return { success: false, message: `${email} is not an administrator` };
  }

  // Prevent removing the last admin
  if (adminConfig.admins.length === 1) {
    return { success: false, message: 'Cannot remove the last administrator. Disable admin mode instead.' };
  }

  // Prevent removing yourself if you're the last admin (extra safety)
  if (email === currentUserEmail && adminConfig.admins.length === 1) {
    return { success: false, message: 'Cannot remove yourself as the last administrator' };
  }

  await state.setAdminConfig({
    ...adminConfig,
    admins: adminConfig.admins.filter(a => a !== email)
  });

  serverLog.info(`Removed admin: ${email}`);
  
  return { success: true, message: `${email} removed from administrators` };
}
