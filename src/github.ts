import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { HostConfig } from './config';
import { RepoVisibility } from './types';

// Path to the gei binary when running in container
const GEI_BINARY_PATH = '/app/.local/share/gh/extensions/gh-gei/gh-gei';

export interface Repository {
  name: string;
  visibility: RepoVisibility;
}

interface GraphQLResponse {
  data: {
    organization: {
      repositories: {
        nodes: Array<{
          name: string;
          visibility: string;
          isArchived: boolean;
          isDisabled: boolean;
          isFork: boolean;
        }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    };
  };
}

export async function fetchRepositories(hostConfig: HostConfig): Promise<Repository[]> {
  const repos: Repository[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($org: String!, $cursor: String) {
        organization(login: $org) {
          repositories(first: 100, after: $cursor, orderBy: { field: NAME, direction: ASC }) {
            nodes {
              name
              visibility
              isArchived
              isDisabled
              isFork
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;

    const variables = {
      org: hostConfig.org,
      cursor
    };

    try {
      const args = ['api', 'graphql'];
      
      // Add hostname if not github.com
      if (hostConfig.hostLabel !== 'github.com') {
        args.push('--hostname', hostConfig.hostLabel);
      }
      
      args.push('-f', `query=${query}`, '-F', `org=${hostConfig.org}`);
      
      if (cursor) {
        args.push('-F', `cursor=${cursor}`);
      }

      const result = await runGh(args, { GH_TOKEN: hostConfig.token });
      
      if (result.code !== 0) {
        throw new Error(`Failed to fetch repositories: ${result.stderr}`);
      }

      const response: GraphQLResponse = JSON.parse(result.stdout);
      const nodes = response.data.organization.repositories.nodes;

      for (const node of nodes) {
        if (!node.isDisabled) {
          repos.push({
            name: node.name,
            visibility: node.visibility.toLowerCase() as RepoVisibility
          });
        }
      }

      hasNextPage = response.data.organization.repositories.pageInfo.hasNextPage;
      cursor = response.data.organization.repositories.pageInfo.endCursor;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error fetching repositories:`, error);
      throw error;
    }
  }

  return repos;
}

export async function runGh(args: string[], envExtra?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...envExtra };
    const child = spawn('gh', args, { env });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code || 0 });
    });

    child.on('error', (error) => {
      stderr += error.message;
      resolve({ stdout, stderr, code: 1 });
    });
  });
}

export async function checkGhCli(): Promise<boolean> {
  try {
    const result = await runGh(['--version']);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Check if gei is available - either as direct binary or gh extension
 */
export async function checkGeiExtension(): Promise<boolean> {
  // First check if direct binary exists (container mode)
  if (existsSync(GEI_BINARY_PATH)) {
    try {
      const result = await runGei(['--help']);
      return result.code === 0;
    } catch {
      return false;
    }
  }
  // Fallback to gh extension
  try {
    const result = await runGh(['gei', '--help']);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Run the gei command - uses direct binary if available, otherwise gh extension
 */
export async function runGei(args: string[], envExtra?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  // Use direct binary if it exists (container mode)
  if (existsSync(GEI_BINARY_PATH)) {
    return new Promise((resolve) => {
      const env = { ...process.env, ...envExtra };
      const child = spawn(GEI_BINARY_PATH, args, { env });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve({ stdout, stderr, code: code || 0 });
      });

      child.on('error', (error) => {
        stderr += error.message;
        resolve({ stdout, stderr, code: 1 });
      });
    });
  }
  
  // Fallback to gh gei extension
  return runGh(['gei', ...args], envExtra);
}

export interface OrgAccessResult {
  authorized: boolean;
  orgName: string;
  error?: string;
}

export async function checkOrgAccess(hostConfig: HostConfig): Promise<OrgAccessResult> {
  try {
    // Query org AND try to list repos to verify full access
    const query = `
      query($org: String!) {
        organization(login: $org) {
          login
          name
          repositories(first: 1) {
            totalCount
            nodes {
              name
            }
          }
        }
      }
    `;

    const args = ['api', 'graphql'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push('-f', `query=${query}`, '-F', `org=${hostConfig.org}`);

    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      // Check for common auth errors
      const stderr = result.stderr.toLowerCase();
      if (stderr.includes('401') || stderr.includes('unauthorized') || stderr.includes('bad credentials')) {
        return { authorized: false, orgName: hostConfig.org, error: 'Token is invalid or expired' };
      }
      if (stderr.includes('403') || stderr.includes('forbidden')) {
        return { authorized: false, orgName: hostConfig.org, error: 'Token does not have access to this organization' };
      }
      if (stderr.includes('404') || stderr.includes('not found') || stderr.includes('could not resolve')) {
        return { authorized: false, orgName: hostConfig.org, error: `Organization '${hostConfig.org}' not found or token lacks access` };
      }
      if (stderr.includes('saml') || stderr.includes('sso')) {
        return { authorized: false, orgName: hostConfig.org, error: 'Token requires SSO authorization for this organization' };
      }
      return { authorized: false, orgName: hostConfig.org, error: result.stderr || 'Unknown error checking org access' };
    }

    const response = JSON.parse(result.stdout);
    
    if (response.errors) {
      const errorMsg = response.errors[0]?.message || 'GraphQL error';
      const errorType = response.errors[0]?.type || '';
      
      if (errorMsg.toLowerCase().includes('could not resolve')) {
        return { authorized: false, orgName: hostConfig.org, error: `Organization '${hostConfig.org}' not found or token lacks access` };
      }
      if (errorMsg.toLowerCase().includes('saml') || errorMsg.toLowerCase().includes('sso')) {
        return { authorized: false, orgName: hostConfig.org, error: 'Token requires SSO authorization for this organization' };
      }
      if (errorType === 'FORBIDDEN' || errorMsg.toLowerCase().includes('forbidden')) {
        return { authorized: false, orgName: hostConfig.org, error: 'Token lacks permission to access this organization\'s repositories' };
      }
      return { authorized: false, orgName: hostConfig.org, error: errorMsg };
    }
    
    if (!response.data?.organization) {
      return { authorized: false, orgName: hostConfig.org, error: `Organization '${hostConfig.org}' not found or token lacks access` };
    }

    // Check if we can actually access repositories
    const repos = response.data.organization.repositories;
    if (repos === null) {
      return { authorized: false, orgName: hostConfig.org, error: 'Token cannot list repositories - check "repo" scope and SSO authorization' };
    }

    return { authorized: true, orgName: hostConfig.org };
  } catch (error) {
    return { authorized: false, orgName: hostConfig.org, error: String(error) };
  }
}

export function extractMigrationId(output: string): string | null {
  const patterns = [
    /migration\s+id[:\s]+([0-9]+)/i,
    /queued\s+migration(?:s)?(?:\s+with)?\s+id[:\s]+([0-9]+)/i,
    /\(ID:\s*([RM_0-9A-Za-z]+)\)/i,
    /id[:\s]+([0-9]+)/i
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

export async function getMigrationStatus(
  hostConfig: HostConfig,
  migrationId: string
): Promise<{ state: string; createdAt?: string; updatedAt?: string; failureReason?: string; rawResponse?: string } | null> {
  try {
    // Use GraphQL API to query migration status
    const query = `query($id: ID!) { node(id: $id) { ... on RepositoryMigration { id state createdAt failureReason sourceUrl } } }`;

    const apiUrl = hostConfig.hostLabel === 'github.com' 
      ? 'https://api.github.com/graphql'
      : `https://${hostConfig.hostLabel}/api/graphql`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hostConfig.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { id: migrationId }
      })
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as any;
    
    if (!data?.data?.node) {
      // Migration not found or completed
      return null;
    }

    const migration = data.data.node;
    return {
      state: migration.state,
      createdAt: migration.createdAt,
      updatedAt: undefined,
      failureReason: migration.failureReason,
      rawResponse: JSON.stringify(data)
    };
  } catch (error) {
    // Silently return null - migrations completing successfully will cause this
    return null;
  }
}


export async function getMigrationLogUrl(
  hostConfig: HostConfig,
  migrationId: string
): Promise<string | null> {
  try {
    const query = `query($id: ID!) { node(id: $id) { ... on RepositoryMigration { migrationLogUrl } } }`;

    const apiUrl = hostConfig.hostLabel === 'github.com' 
      ? 'https://api.github.com/graphql'
      : `https://${hostConfig.hostLabel}/api/graphql`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hostConfig.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { id: migrationId }
      })
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as any;
    return data?.data?.node?.migrationLogUrl || null;
  } catch (error) {
    return null;
  }
}

export async function checkRepoExists(hostConfig: HostConfig, repoName: string): Promise<boolean> {
  try {
    const apiUrl = hostConfig.hostLabel === 'github.com' 
      ? `https://api.github.com/repos/${hostConfig.org}/${repoName}`
      : `https://${hostConfig.hostLabel}/api/v3/repos/${hostConfig.org}/${repoName}`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${hostConfig.token}`,
        'Accept': 'application/vnd.github+json',
      }
    });

    return response.ok;
  } catch (error) {
    return false;
  }
}

export async function getRepoLastUpdated(hostConfig: HostConfig, repoName: string): Promise<string | null> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/repos/${hostConfig.org}/${repoName}`);

    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      return null;
    }

    const response = JSON.parse(result.stdout);
    return response.pushed_at || response.updated_at;
  } catch (error) {
    return null;
  }
}

export async function needsMigration(sourceConfig: HostConfig, targetConfig: HostConfig, repoName: string): Promise<{ needs: boolean; lastPushed?: string }> {
  // Check if repo exists in target
  const existsInTarget = await checkRepoExists(targetConfig, repoName);
  
  // Get source last updated time
  const sourceLastUpdated = await getRepoLastUpdated(sourceConfig, repoName);
  
  if (!existsInTarget) {
    return { needs: true, lastPushed: sourceLastUpdated || undefined };
  }

  // Get target last updated time
  const targetLastUpdated = await getRepoLastUpdated(targetConfig, repoName);

  if (!sourceLastUpdated || !targetLastUpdated) {
    return { needs: true, lastPushed: sourceLastUpdated || undefined };
  }

  const sourceDate = new Date(sourceLastUpdated).getTime();
  const targetDate = new Date(targetLastUpdated).getTime();

  if (sourceDate > targetDate) {
    return { needs: true, lastPushed: sourceLastUpdated };
  }

  return { needs: false, lastPushed: sourceLastUpdated };
}

export interface RepoMetadata {
  description?: string;
  primaryLanguage?: string;
  languages?: Array<{ name: string; size: number }>;
  size?: number;
  commitCount?: number;
  branchCount?: number;
  archived?: boolean;
}

export async function getRepoMetadata(hostConfig: HostConfig, repoName: string): Promise<RepoMetadata | null> {
  try {
    const query = `
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          description
          primaryLanguage {
            name
          }
          languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
            edges {
              size
              node {
                name
              }
            }
          }
          diskUsage
          isArchived
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 0) {
                  totalCount
                }
              }
            }
          }
          refs(refPrefix: "refs/heads/", first: 0) {
            totalCount
          }
        }
      }
    `;

    const args = ['api', 'graphql'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push('-f', `query=${query}`, '-F', `owner=${hostConfig.org}`, '-F', `name=${repoName}`);

    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      return null;
    }

    const response = JSON.parse(result.stdout);
    const repo = response?.data?.repository;
    
    if (!repo) {
      return null;
    }

    const languages = repo.languages?.edges?.map((edge: any) => ({
      name: edge.node.name,
      size: edge.size
    })) || [];

    return {
      description: repo.description || undefined,
      primaryLanguage: repo.primaryLanguage?.name || undefined,
      languages: languages.length > 0 ? languages : undefined,
      size: repo.diskUsage || undefined,
      commitCount: repo.defaultBranchRef?.target?.history?.totalCount || undefined,
      branchCount: repo.refs?.totalCount || undefined,
      archived: repo.isArchived || false
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching metadata for ${repoName}:`, error);
    return null;
  }
}
