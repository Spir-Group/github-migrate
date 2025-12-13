import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const SSM_PATS_PARAMETER = process.env.SSM_PATS_PARAMETER || '/container/git-migrate/dev/secrets/github-pats';
const USE_SSM = !!process.env.SSM_PATS_PARAMETER;

// Cache for PATs to avoid frequent SSM calls
let patsCache: GitHubPats | null = null;
let patsCacheExpiry: number = 0;
const PATS_CACHE_TTL_MS = 60000; // 1 minute

let ssmClient: SSMClient | null = null;

function getSSMClient(): SSMClient {
  if (!ssmClient) {
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

export interface GitHubPats {
  syncs: {
    [syncId: string]: {
      sourceToken: string;
      targetToken: string;
    };
  };
}

/**
 * Get PATs from Parameter Store
 * Returns cached value if available and not expired
 */
export async function getPatsFromParameterStore(): Promise<GitHubPats | null> {
  if (!USE_SSM) {
    return null;
  }

  const now = Date.now();
  if (patsCache && now < patsCacheExpiry) {
    return patsCache;
  }

  try {
    const client = getSSMClient();
    const result = await client.send(new GetParameterCommand({
      Name: SSM_PATS_PARAMETER,
      WithDecryption: true
    }));

    if (result.Parameter?.Value) {
      patsCache = JSON.parse(result.Parameter.Value) as GitHubPats;
      patsCacheExpiry = now + PATS_CACHE_TTL_MS;
      return patsCache;
    }
  } catch (error: any) {
    if (error.name === 'ParameterNotFound') {
      console.log(`[${new Date().toISOString()}] PATs parameter not found, will create on first save`);
      return { syncs: {} };
    }
    console.error(`[${new Date().toISOString()}] Error fetching PATs from Parameter Store:`, error);
  }

  return null;
}

/**
 * Update PATs for a specific sync in Parameter Store
 */
export async function updatePatsInParameterStore(
  syncId: string,
  sourceToken: string,
  targetToken: string
): Promise<boolean> {
  if (!USE_SSM) {
    console.log(`[${new Date().toISOString()}] SSM not configured, skipping PAT storage`);
    return false;
  }

  try {
    // Get current PATs
    let pats = await getPatsFromParameterStore();
    if (!pats) {
      pats = { syncs: {} };
    }

    // Update the specific sync
    pats.syncs[syncId] = {
      sourceToken,
      targetToken
    };

    // Save back to Parameter Store
    const client = getSSMClient();
    await client.send(new PutParameterCommand({
      Name: SSM_PATS_PARAMETER,
      Value: JSON.stringify(pats),
      Type: 'SecureString',
      Overwrite: true
    }));

    // Invalidate cache
    patsCache = pats;
    patsCacheExpiry = Date.now() + PATS_CACHE_TTL_MS;

    console.log(`[${new Date().toISOString()}] Updated PATs for sync ${syncId} in Parameter Store`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error updating PATs in Parameter Store:`, error);
    return false;
  }
}

/**
 * Remove PATs for a specific sync from Parameter Store
 */
export async function removePatsFromParameterStore(syncId: string): Promise<boolean> {
  if (!USE_SSM) {
    return false;
  }

  try {
    // Get current PATs
    const pats = await getPatsFromParameterStore();
    if (!pats || !pats.syncs[syncId]) {
      return true; // Already doesn't exist
    }

    // Remove the specific sync
    delete pats.syncs[syncId];

    // Save back to Parameter Store
    const client = getSSMClient();
    await client.send(new PutParameterCommand({
      Name: SSM_PATS_PARAMETER,
      Value: JSON.stringify(pats),
      Type: 'SecureString',
      Overwrite: true
    }));

    // Invalidate cache
    patsCache = pats;
    patsCacheExpiry = Date.now() + PATS_CACHE_TTL_MS;

    console.log(`[${new Date().toISOString()}] Removed PATs for sync ${syncId} from Parameter Store`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error removing PATs from Parameter Store:`, error);
    return false;
  }
}

/**
 * Check if PATs exist for a given sync
 */
export async function hasPatsForSync(syncId: string): Promise<boolean> {
  const pats = await getPatsFromParameterStore();
  return !!(pats?.syncs?.[syncId]?.sourceToken && pats?.syncs?.[syncId]?.targetToken);
}

/**
 * Invalidate the PATs cache (useful after updates)
 */
export function invalidatePatsCache(): void {
  patsCache = null;
  patsCacheExpiry = 0;
}
