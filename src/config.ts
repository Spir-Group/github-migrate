import * as dotenv from 'dotenv';
import { SyncRuntimeConfig, HostConfig } from './types';

dotenv.config();

// Re-export types for backwards compatibility
export type { SyncRuntimeConfig, HostConfig };

// Legacy Config type for backwards compatibility during transition
export interface Config {
  source: HostConfig;
  target: HostConfig;
  port: number;
  pollSeconds: number;
  sseHeartbeatSeconds: number;
}

export interface ServerConfig {
  port: number;
  pollSeconds: number;
  sseHeartbeatSeconds: number;
}

/**
 * Load server configuration from CLI args and defaults
 */
export function loadServerConfig(cliPort?: number, cliPollSeconds?: number): ServerConfig {
  return {
    port: cliPort || parseInt(process.env.PORT || '3000', 10),
    pollSeconds: cliPollSeconds || parseInt(process.env.POLL_SECONDS || '60', 10),
    sseHeartbeatSeconds: 15
  };
}

/**
 * Derive host endpoints from an optional GHES URL
 */
function deriveEndpoints(url: string | undefined): { 
  restBase: string; 
  graphqlUrl: string; 
  hostLabel: string 
} {
  if (!url || url.trim() === '') {
    return {
      restBase: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
      hostLabel: 'github.com'
    };
  }

  const urlObj = new URL(url);
  const host = urlObj.hostname;
  
  return {
    restBase: url,
    graphqlUrl: `${urlObj.protocol}//${host}/api/graphql`,
    hostLabel: host
  };
}

/**
 * Validate a sync configuration by testing API access
 * Returns null if valid, or an error message if invalid
 */
export async function validateSyncConfig(syncConfig: SyncRuntimeConfig): Promise<{
  sourceValid: boolean;
  targetValid: boolean;
  sourceError?: string;
  targetError?: string;
}> {
  const timestamp = () => `[${new Date().toISOString()}]`;
  console.log(`${timestamp()} Starting sync validation for "${syncConfig.source.org}" → "${syncConfig.target.org}"`);
  
  const result = {
    sourceValid: false,
    targetValid: false,
    sourceError: undefined as string | undefined,
    targetError: undefined as string | undefined
  };
  
  // Test source access
  console.log(`${timestamp()} Validating SOURCE: ${syncConfig.source.org} @ ${syncConfig.source.restBase}`);
  try {
    const sourceResult = await testOrgAccess(syncConfig.source, 'source');
    result.sourceValid = sourceResult.valid;
    result.sourceError = sourceResult.error;
    if (sourceResult.valid) {
      console.log(`${timestamp()} SOURCE: ✓ All checks passed`);
    } else {
      console.log(`${timestamp()} SOURCE: ✗ Failed - ${sourceResult.error}`);
    }
  } catch (error) {
    result.sourceError = String(error);
    console.log(`${timestamp()} SOURCE: ✗ Exception - ${error}`);
  }
  
  // Test target access
  console.log(`${timestamp()} Validating TARGET: ${syncConfig.target.org} @ ${syncConfig.target.restBase}`);
  try {
    const targetResult = await testOrgAccess(syncConfig.target, 'target');
    result.targetValid = targetResult.valid;
    result.targetError = targetResult.error;
    if (targetResult.valid) {
      console.log(`${timestamp()} TARGET: ✓ All checks passed`);
    } else {
      console.log(`${timestamp()} TARGET: ✗ Failed - ${targetResult.error}`);
    }
  } catch (error) {
    result.targetError = String(error);
    console.log(`${timestamp()} TARGET: ✗ Exception - ${error}`);
  }
  
  console.log(`${timestamp()} Validation complete: source=${result.sourceValid ? 'PASS' : 'FAIL'}, target=${result.targetValid ? 'PASS' : 'FAIL'}`);
  return result;
}

/**
 * Required scopes for migration (source)
 */
const SOURCE_REQUIRED_SCOPES = ['repo', 'admin:org', 'workflow', 'admin:repo_hook'];

/**
 * Required scopes for migration (target) - includes delete_repo
 */
const TARGET_REQUIRED_SCOPES = ['repo', 'admin:org', 'workflow', 'admin:repo_hook', 'delete_repo'];

/**
 * Test if we can access an organization with the given host config
 * This checks that the token is valid, has required scopes, AND has access to the org
 */
async function testOrgAccess(hostConfig: HostConfig, type: 'source' | 'target'): Promise<{ valid: boolean; error?: string }> {
  const requiredScopes = type === 'source' ? SOURCE_REQUIRED_SCOPES : TARGET_REQUIRED_SCOPES;
  const label = type.toUpperCase();
  const timestamp = () => `[${new Date().toISOString()}]`;
  const log = (msg: string) => console.log(`${timestamp()} ${label}: ${msg}`);
  
  // Step 1: Verify the token is valid and check scopes
  log(`Step 1/3: Validating token via /user endpoint...`);
  try {
    const userResponse = await fetch(`${hostConfig.restBase}/user`, {
      headers: {
        'Authorization': `Bearer ${hostConfig.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!userResponse.ok) {
      if (userResponse.status === 401) {
        log(`Step 1/3: ✗ Token is invalid or expired (HTTP 401)`);
        return { valid: false, error: 'Token is invalid or expired' };
      }
      log(`Step 1/3: ✗ Token validation failed (HTTP ${userResponse.status})`);
      return { valid: false, error: `Token validation failed: HTTP ${userResponse.status}` };
    }

    const userData = await userResponse.json() as { login?: string };
    log(`Step 1/3: ✓ Token valid, authenticated as "${userData.login || 'unknown'}"`);

    // Check scopes from response header
    const scopesHeader = userResponse.headers.get('X-OAuth-Scopes');
    if (scopesHeader === null) {
      log(`Step 1/3: ✗ No X-OAuth-Scopes header - fine-grained PAT detected`);
      return { valid: false, error: 'Fine-grained PATs are not supported for migration. Please use a classic PAT.' };
    }
    
    // Classic PAT - check scopes
    const scopes = scopesHeader.split(',').map(s => s.trim().toLowerCase());
    log(`Step 1/3: Token scopes: ${scopes.join(', ')}`);
    log(`Step 1/3: Required scopes: ${requiredScopes.join(', ')}`);
    
    const missingScopes: string[] = [];
    
    for (const required of requiredScopes) {
      const hasScope = scopes.some(s => s === required || s.startsWith(required + ':') || required.startsWith(s + ':'));
      if (!hasScope && !scopes.includes(required)) {
        missingScopes.push(required);
      }
    }
    
    if (missingScopes.length > 0) {
      log(`Step 1/3: ✗ Missing scopes: ${missingScopes.join(', ')}`);
      return { valid: false, error: `Token missing required scopes: ${missingScopes.join(', ')}` };
    }
    log(`Step 1/3: ✓ All required scopes present`);
  } catch (error) {
    log(`Step 1/3: ✗ Exception: ${error}`);
    return { valid: false, error: `Token validation failed: ${error}` };
  }

  // Step 2: Check organization access
  log(`Step 2/3: Checking organization access for "${hostConfig.org}"...`);
  try {
    const orgResponse = await fetch(`${hostConfig.restBase}/orgs/${hostConfig.org}`, {
      headers: {
        'Authorization': `Bearer ${hostConfig.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    // Check for SSO header - GitHub returns this when SSO authorization is required
    const ssoHeader = orgResponse.headers.get('X-GitHub-SSO');
    if (ssoHeader) {
      log(`Step 2/3: ✗ SSO authorization required (X-GitHub-SSO header present)`);
      log(`Step 2/3: SSO Header: ${ssoHeader}`);
      const ssoUrl = ssoHeader.match(/url=([^;,\s]+)/)?.[1];
      const errorMsg = ssoUrl 
        ? `Token requires SSO authorization for '${hostConfig.org}'. <a href="${ssoUrl}" target="_blank">Click here to authorize</a>`
        : `Token requires SSO authorization for '${hostConfig.org}'`;
      return { valid: false, error: errorMsg };
    }

    if (!orgResponse.ok) {
      if (orgResponse.status === 404) {
        log(`Step 2/3: ✗ Organization not found (HTTP 404)`);
        return { valid: false, error: `Organization '${hostConfig.org}' not found` };
      }
      if (orgResponse.status === 403) {
        const responseText = await orgResponse.text();
        log(`Step 2/3: 403 response body: ${responseText.substring(0, 200)}`);
        if (responseText.toLowerCase().includes('saml') || responseText.toLowerCase().includes('sso')) {
          log(`Step 2/3: ✗ SSO authorization required (HTTP 403)`);
          return { valid: false, error: `Token requires SSO authorization for '${hostConfig.org}'` };
        }
        log(`Step 2/3: ✗ Access denied to organization (HTTP 403)`);
        return { valid: false, error: `Token does not have access to organization '${hostConfig.org}'` };
      }
      log(`Step 2/3: ✗ Failed to access org (HTTP ${orgResponse.status})`);
      return { valid: false, error: `Failed to access org: HTTP ${orgResponse.status}` };
    }
    log(`Step 2/3: ✓ Organization accessible`);

    // Step 3: Check if we can list repos
    log(`Step 3/3: Checking repository list access...`);
    const reposResponse = await fetch(`${hostConfig.restBase}/orgs/${hostConfig.org}/repos?per_page=1`, {
      headers: {
        'Authorization': `Bearer ${hostConfig.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    // Check for SSO header on repos endpoint too
    const reposSsoHeader = reposResponse.headers.get('X-GitHub-SSO');
    if (reposSsoHeader) {
      log(`Step 3/3: ✗ SSO authorization required for repos (X-GitHub-SSO header present)`);
      log(`Step 3/3: SSO Header: ${reposSsoHeader}`);
      const ssoUrl = reposSsoHeader.match(/url=([^;,\s]+)/)?.[1];
      const errorMsg = ssoUrl 
        ? `Token requires SSO authorization for '${hostConfig.org}'. <a href="${ssoUrl}" target="_blank">Click here to authorize</a>`
        : `Token requires SSO authorization for '${hostConfig.org}'`;
      return { valid: false, error: errorMsg };
    }

    if (!reposResponse.ok) {
      if (reposResponse.status === 403) {
        const responseText = await reposResponse.text();
        log(`Step 3/3: 403 response body: ${responseText.substring(0, 200)}`);
        if (responseText.toLowerCase().includes('saml') || responseText.toLowerCase().includes('sso')) {
          log(`Step 3/3: ✗ SSO authorization required for repos (HTTP 403)`);
          return { valid: false, error: `Token requires SSO authorization for '${hostConfig.org}'` };
        }
        log(`Step 3/3: ✗ Cannot read repositories (HTTP 403)`);
        return { valid: false, error: `Token cannot read repositories in '${hostConfig.org}' - check permissions` };
      }
      log(`Step 3/3: ✗ Cannot list repos (HTTP ${reposResponse.status})`);
      return { valid: false, error: `Cannot list repos: HTTP ${reposResponse.status}` };
    }
    log(`Step 3/3: ✓ Repository access confirmed`);

    return { valid: true };
  } catch (error) {
    log(`Step 2-3: ✗ Exception: ${error}`);
    return { valid: false, error: String(error) };
  }
}

/**
 * Legacy function for backwards compatibility
 * Loads config from environment variables (single sync mode)
 */
export function loadConfig(cliPort?: number, cliPollSeconds?: number): Config {
  const sourceToken = process.env.GH_SOURCE_TOKEN;
  const targetToken = process.env.GH_TARGET_TOKEN;
  const sourceEnt = process.env.GH_SOURCE_ENT;
  const targetEnt = process.env.GH_TARGET_ENT;
  const sourceOrg = process.env.GH_SOURCE_ORG;
  const targetOrg = process.env.GH_TARGET_ORG;

  if (!sourceToken) {
    console.error('Error: GH_SOURCE_TOKEN environment variable must be set');
    process.exit(1);
  }

  if (!targetToken) {
    console.error('Error: GH_TARGET_TOKEN environment variable must be set');
    process.exit(1);
  }

  if (!sourceEnt) {
    console.error('Error: GH_SOURCE_ENT environment variable must be set');
    process.exit(1);
  }

  if (!targetEnt) {
    console.error('Error: GH_TARGET_ENT environment variable must be set');
    process.exit(1);
  }

  if (!sourceOrg) {
    console.error('Error: GH_SOURCE_ORG environment variable must be set');
    process.exit(1);
  }

  if (!targetOrg) {
    console.error('Error: GH_TARGET_ORG environment variable must be set');
    process.exit(1);
  }

  const sourceUrl = process.env.GH_SOURCE_URL;
  const targetUrl = process.env.GH_TARGET_URL;

  const sourceEndpoints = deriveEndpoints(sourceUrl);
  const targetEndpoints = deriveEndpoints(targetUrl);

  return {
    source: {
      ...sourceEndpoints,
      token: sourceToken,
      enterprise: sourceEnt,
      org: sourceOrg
    },
    target: {
      ...targetEndpoints,
      token: targetToken,
      enterprise: targetEnt,
      org: targetOrg
    },
    port: cliPort || 3000,
    pollSeconds: cliPollSeconds || 60,
    sseHeartbeatSeconds: 15
  };
}
