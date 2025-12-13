import { SyncRuntimeConfig } from '../types';
import * as state from '../state-index';
import { fetchRepositories } from '../github';

/**
 * Discover repositories from source org and add new ones to state
 */
export async function discoverRepositoriesForSync(
  config: SyncRuntimeConfig, 
  onUpdate?: () => void
): Promise<void> {
  console.log(`[${new Date().toISOString()}] Discovering repositories for sync "${config.name}" from ${config.source.org}...`);
  
  const repos = await fetchRepositories(config.source);
  console.log(`[${new Date().toISOString()}] Found ${repos.length} repositories in ${config.source.org}`);

  let newRepoCount = 0;
  let archivedRepoCount = 0;
  
  // Create a set of current repo names from source
  const sourceRepoNames = new Set(repos.map(r => r.name));
  
  // Mark repos not in source as archived (soft delete)
  const syncRepos = state.listActiveBySyncId(config.id);
  for (const stateRepo of syncRepos) {
    if (!sourceRepoNames.has(stateRepo.name) && stateRepo.status !== 'deleted') {
      await state.archiveRepo(stateRepo.id);
      archivedRepoCount++;
      console.log(`[${new Date().toISOString()}] Archived ${stateRepo.name} (no longer in source)`);
    }
  }
  
  // Update state with discovered repos (only add new ones)
  for (const repo of repos) {
    const existing = state.getRepoByName(config.id, repo.name);
    if (!existing) {
      await state.upsertRepoByName(config.id, repo.name, {
        visibility: repo.visibility,
        status: 'unknown'
      });
      newRepoCount++;
    }
  }

  if (newRepoCount > 0) {
    console.log(`[${new Date().toISOString()}] Added ${newRepoCount} new repositories for sync "${config.name}"`);
  }
  if (archivedRepoCount > 0) {
    console.log(`[${new Date().toISOString()}] Archived ${archivedRepoCount} repositories for sync "${config.name}"`);
  }
  if (newRepoCount === 0 && archivedRepoCount === 0) {
    console.log(`[${new Date().toISOString()}] No changes to repository list for sync "${config.name}"`);
  }

  await state.saveState();
  if (onUpdate) {
    onUpdate();
  }
}
