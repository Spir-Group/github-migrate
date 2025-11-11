import { Config } from '../config';
import * as state from '../state';
import { fetchRepositories } from '../github';

// Discover repositories from source and add new ones to state
export async function discoverRepositories(config: Config, onUpdate?: () => void): Promise<void> {
  console.log(`[${new Date().toISOString()}] Discovering repositories from ${config.source.org}...`);
  
  const repos = await fetchRepositories(config.source);
  console.log(`[${new Date().toISOString()}] Found ${repos.length} repositories`);

  let newRepoCount = 0;
  let deletedRepoCount = 0;
  
  // Create a set of current repo names from source
  const sourceRepoNames = new Set(repos.map(r => r.name));
  
  // Mark repos not in source as deleted
  const allStateRepos = state.listAll();
  for (const stateRepo of allStateRepos) {
    if (!sourceRepoNames.has(stateRepo.name) && stateRepo.status !== 'deleted') {
      state.setStatus(stateRepo.name, 'deleted');
      deletedRepoCount++;
      console.log(`[${new Date().toISOString()}] Marked ${stateRepo.name} as deleted (no longer in source)`);
    }
  }
  
  // Update state with discovered repos (only add new ones)
  for (const repo of repos) {
    const existing = state.getRepo(repo.name);
    if (!existing) {
      state.upsertRepo(repo.name, {
        name: repo.name,
        visibility: repo.visibility,
        status: 'unknown'
      });
      newRepoCount++;
    }
  }

  if (newRepoCount > 0) {
    console.log(`[${new Date().toISOString()}] Added ${newRepoCount} new repositories to state`);
  }
  if (deletedRepoCount > 0) {
    console.log(`[${new Date().toISOString()}] Marked ${deletedRepoCount} repositories as deleted`);
  }
  if (newRepoCount === 0 && deletedRepoCount === 0) {
    console.log(`[${new Date().toISOString()}] No changes to repository list`);
  }

  await state.saveState();
  if (onUpdate) {
    onUpdate();
  }
}
