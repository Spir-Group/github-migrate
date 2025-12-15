// Organization settings API functions

import { HostConfig } from './types';
import { runGh } from './github';
import { 
  OrgSettings, 
  OrgSettingsComparison, 
  SettingComparison, 
  ApplySettingsRequest, 
  ApplySettingsResult,
  ORG_SETTINGS_CATEGORIES,
  ActionsPermissions,
  OrgWebhook,
  OrgTeam,
  ExtendedOrgComparison,
  EnterpriseSecuritySettings,
  CopilotOrgSettings,
  EnterpriseSettingComparison,
  CopilotSettingComparison,
  ENTERPRISE_SECURITY_SETTINGS,
  COPILOT_SETTINGS
} from './settings-types';
import { serverLog } from './logger';

/**
 * Fetch organization settings via REST API
 */
export async function fetchOrgSettings(hostConfig: HostConfig): Promise<OrgSettings | null> {
  const args = ['api'];
  
  if (hostConfig.hostLabel !== 'github.com') {
    args.push('--hostname', hostConfig.hostLabel);
  }
  
  args.push(`/orgs/${hostConfig.org}`);
  
  const result = await runGh(args, { GH_TOKEN: hostConfig.token });
  
  if (result.code !== 0) {
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes('saml') || stderr.includes('sso')) {
      serverLog.warn(`SAML/SSO authorization required for org ${hostConfig.org}. Authorize PAT at: https://github.com/settings/tokens`);
    } else if (stderr.includes('403') || stderr.includes('forbidden')) {
      serverLog.warn(`Access denied to org ${hostConfig.org}. Check PAT scopes (needs admin:org).`);
    } else {
      serverLog.error(`Failed to fetch org settings for ${hostConfig.org}: ${result.stderr}`);
    }
    return null;
  }
  
  const data = JSON.parse(result.stdout);
  
  // Map API response to our OrgSettings interface
  const settings: OrgSettings = {
    // Basic Info
    name: data.name,
    description: data.description,
    company: data.company,
    blog: data.blog,
    location: data.location,
    email: data.email,
    twitter_username: data.twitter_username,
    
    // Repository defaults
    default_repository_permission: data.default_repository_permission,
    default_repository_branch: data.default_repository_branch,
    
    // Member permissions - Repository creation
    members_can_create_repositories: data.members_can_create_repositories,
    members_can_create_public_repositories: data.members_can_create_public_repositories,
    members_can_create_private_repositories: data.members_can_create_private_repositories,
    members_can_create_internal_repositories: data.members_can_create_internal_repositories,
    members_allowed_repository_creation_type: data.members_allowed_repository_creation_type,
    
    // Member permissions - Other
    members_can_fork_private_repositories: data.members_can_fork_private_repositories,
    members_can_create_pages: data.members_can_create_pages,
    members_can_create_public_pages: data.members_can_create_public_pages,
    members_can_create_private_pages: data.members_can_create_private_pages,
    members_can_delete_repositories: data.members_can_delete_repositories,
    members_can_change_repo_visibility: data.members_can_change_repo_visibility,
    members_can_invite_outside_collaborators: data.members_can_invite_outside_collaborators,
    members_can_delete_issues: data.members_can_delete_issues,
    members_can_create_teams: data.members_can_create_teams,
    members_can_view_dependency_insights: data.members_can_view_dependency_insights,
    
    // Projects
    has_organization_projects: data.has_organization_projects,
    has_repository_projects: data.has_repository_projects,
    
    // Security features
    advanced_security_enabled_for_new_repositories: data.advanced_security_enabled_for_new_repositories,
    dependabot_alerts_enabled_for_new_repositories: data.dependabot_alerts_enabled_for_new_repositories,
    dependabot_security_updates_enabled_for_new_repositories: data.dependabot_security_updates_enabled_for_new_repositories,
    dependency_graph_enabled_for_new_repositories: data.dependency_graph_enabled_for_new_repositories,
    secret_scanning_enabled_for_new_repositories: data.secret_scanning_enabled_for_new_repositories,
    secret_scanning_push_protection_enabled_for_new_repositories: data.secret_scanning_push_protection_enabled_for_new_repositories,
    secret_scanning_push_protection_custom_link_enabled: data.secret_scanning_push_protection_custom_link_enabled,
    secret_scanning_push_protection_custom_link: data.secret_scanning_push_protection_custom_link,
    
    // Other settings
    two_factor_requirement_enabled: data.two_factor_requirement_enabled,
    web_commit_signoff_required: data.web_commit_signoff_required,
    deploy_keys_enabled_for_repositories: data.deploy_keys_enabled_for_repositories,
    readers_can_create_discussions: data.readers_can_create_discussions,
    display_commenter_full_name_setting_enabled: data.display_commenter_full_name_setting_enabled,
    
    // Read-only info
    is_verified: data.is_verified,
    public_repos: data.public_repos,
    total_private_repos: data.total_private_repos,
    owned_private_repos: data.owned_private_repos,
    collaborators: data.collaborators,
    billing_email: data.billing_email,
    plan: data.plan,
  };
  
  return settings;
}

/**
 * Update organization settings via REST API
 */
export async function updateOrgSettings(
  hostConfig: HostConfig, 
  settings: Partial<OrgSettings>
): Promise<OrgSettings> {
  const args = ['api'];
  
  if (hostConfig.hostLabel !== 'github.com') {
    args.push('--hostname', hostConfig.hostLabel);
  }
  
  args.push('-X', 'PATCH', `/orgs/${hostConfig.org}`);
  
  // Add each setting as a field
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined && value !== null) {
      if (typeof value === 'boolean') {
        args.push('-F', `${key}=${value}`);
      } else if (typeof value === 'string') {
        args.push('-f', `${key}=${value}`);
      } else if (typeof value === 'number') {
        args.push('-F', `${key}=${value}`);
      }
    }
  }
  
  const result = await runGh(args, { GH_TOKEN: hostConfig.token });
  
  if (result.code !== 0) {
    throw new Error(`Failed to update org settings: ${result.stderr}`);
  }
  
  return JSON.parse(result.stdout);
}

/**
 * Fetch Actions permissions for an organization
 */
export async function fetchActionsPermissions(hostConfig: HostConfig): Promise<ActionsPermissions | null> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/orgs/${hostConfig.org}/actions/permissions`);
    
    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      return null;
    }
    
    const data = JSON.parse(result.stdout);
    return {
      enabled_repositories: data.enabled_repositories,
      allowed_actions: data.allowed_actions,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch organization webhooks count
 */
export async function fetchOrgWebhooksCount(hostConfig: HostConfig): Promise<number> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/orgs/${hostConfig.org}/hooks`);
    
    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      return 0;
    }
    
    const data = JSON.parse(result.stdout);
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch organization teams count
 */
export async function fetchOrgTeamsCount(hostConfig: HostConfig): Promise<number> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/orgs/${hostConfig.org}/teams`);
    
    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      return 0;
    }
    
    const data = JSON.parse(result.stdout);
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch enterprise code security and analysis settings
 * Requires enterprise admin access and the enterprise slug
 */
export async function fetchEnterpriseSecuritySettings(
  enterprise: string,
  hostConfig: HostConfig
): Promise<EnterpriseSecuritySettings | null> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/enterprises/${enterprise}/code_security_and_analysis`);
    
    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      serverLog.warn(`Failed to fetch enterprise security settings for ${enterprise}: ${result.stderr}`);
      return null;
    }
    
    const data = JSON.parse(result.stdout);
    return {
      advanced_security_enabled_for_new_repositories: data.advanced_security_enabled_for_new_repositories,
      advanced_security_enabled_new_user_namespace_repos: data.advanced_security_enabled_new_user_namespace_repos,
      dependabot_alerts_enabled_for_new_repositories: data.dependabot_alerts_enabled_for_new_repositories,
      secret_scanning_enabled_for_new_repositories: data.secret_scanning_enabled_for_new_repositories,
      secret_scanning_push_protection_enabled_for_new_repositories: data.secret_scanning_push_protection_enabled_for_new_repositories,
      secret_scanning_push_protection_custom_link: data.secret_scanning_push_protection_custom_link,
      secret_scanning_non_provider_patterns_enabled_for_new_repositories: data.secret_scanning_non_provider_patterns_enabled_for_new_repositories,
      secret_scanning_validity_checks_enabled: data.secret_scanning_validity_checks_enabled,
    };
  } catch (err) {
    serverLog.warn(`Error fetching enterprise security settings: ${err}`);
    return null;
  }
}

/**
 * Update enterprise code security and analysis settings
 */
export async function updateEnterpriseSecuritySettings(
  enterprise: string,
  hostConfig: HostConfig,
  settings: Partial<EnterpriseSecuritySettings>
): Promise<boolean> {
  try {
    const args = ['api', '-X', 'PATCH'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/enterprises/${enterprise}/code_security_and_analysis`);
    
    // Add each setting as a field
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined && value !== null) {
        if (typeof value === 'boolean') {
          args.push('-F', `${key}=${value}`);
        } else if (typeof value === 'string') {
          args.push('-f', `${key}=${value}`);
        }
      }
    }
    
    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      serverLog.error(`Failed to update enterprise security settings: ${result.stderr}`);
      return false;
    }
    
    return true;
  } catch (err) {
    serverLog.error(`Error updating enterprise security settings: ${err}`);
    return false;
  }
}

/**
 * Compare enterprise security settings
 */
export function compareEnterpriseSecuritySettings(
  source: EnterpriseSecuritySettings | null,
  target: EnterpriseSecuritySettings | null
): EnterpriseSettingComparison[] {
  if (!source || !target) {
    return [];
  }
  
  return ENTERPRISE_SECURITY_SETTINGS.map(setting => {
    const key = setting.key.replace(' as keyof OrgSettings', '') as keyof EnterpriseSecuritySettings;
    const sourceValue = source[key];
    const targetValue = target[key];
    
    return {
      key: key,
      label: setting.label,
      sourceValue,
      targetValue,
      isEqual: JSON.stringify(sourceValue) === JSON.stringify(targetValue),
      canSync: setting.type !== 'readonly',
    };
  });
}

/**
 * Fetch Copilot settings for an organization
 */
export async function fetchCopilotSettings(hostConfig: HostConfig): Promise<CopilotOrgSettings | null> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/orgs/${hostConfig.org}/copilot/billing`);
    
    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      // Check for common error cases
      const stderr = result.stderr.toLowerCase();
      if (stderr.includes('403') || stderr.includes('forbidden') || stderr.includes('scope')) {
        // Missing manage_billing:copilot scope - requires classic PAT
        serverLog.info(`Copilot API requires 'manage_billing:copilot' scope (classic PAT only) for ${hostConfig.org}`);
      } else if (stderr.includes('404') || stderr.includes('not found')) {
        // Copilot not enabled for org
        serverLog.info(`Copilot not enabled for ${hostConfig.org}`);
      } else {
        serverLog.info(`Copilot not available for ${hostConfig.org}: ${result.stderr}`);
      }
      return null;
    }
    
    const data = JSON.parse(result.stdout);
    return {
      seat_breakdown: data.seat_breakdown,
      seat_management_setting: data.seat_management_setting,
      ide_chat: data.ide_chat,
      platform_chat: data.platform_chat,
      cli: data.cli,
      public_code_suggestions: data.public_code_suggestions,
      plan_type: data.plan_type,
    };
  } catch (err) {
    serverLog.info(`Error fetching Copilot settings: ${err}`);
    return null;
  }
}

/**
 * Compare Copilot settings between organizations
 */
export function compareCopilotSettings(
  source: CopilotOrgSettings | null,
  target: CopilotOrgSettings | null
): CopilotSettingComparison[] {
  if (!source && !target) {
    return [];
  }
  
  return COPILOT_SETTINGS.map(setting => {
    const sourceValue = source?.[setting.key];
    const targetValue = target?.[setting.key];
    
    return {
      key: setting.key,
      label: setting.label,
      sourceValue,
      targetValue,
      isEqual: JSON.stringify(sourceValue) === JSON.stringify(targetValue),
    };
  });
}

/**
 * Get all settings that are writable (not readonly)
 */
function getWritableSettings(): Set<keyof OrgSettings> {
  const writable = new Set<keyof OrgSettings>();
  
  for (const category of ORG_SETTINGS_CATEGORIES) {
    for (const setting of category.settings) {
      if (setting.type !== 'readonly') {
        writable.add(setting.key);
      }
    }
  }
  
  return writable;
}

/**
 * Compare settings between source and target organizations
 */
export function compareOrgSettings(
  sourceSettings: OrgSettings | null,
  targetSettings: OrgSettings | null
): SettingComparison[] {
  const comparisons: SettingComparison[] = [];
  const writableSettings = getWritableSettings();
  
  // If neither org has settings, return empty
  if (!sourceSettings && !targetSettings) {
    return comparisons;
  }
  
  // Get all defined settings from categories
  for (const category of ORG_SETTINGS_CATEGORIES) {
    for (const setting of category.settings) {
      const sourceValue = sourceSettings?.[setting.key];
      const targetValue = targetSettings?.[setting.key];
      
      comparisons.push({
        key: setting.key,
        sourceValue,
        targetValue,
        isEqual: JSON.stringify(sourceValue) === JSON.stringify(targetValue),
        canSync: writableSettings.has(setting.key) && setting.type !== 'readonly' && sourceSettings !== null && targetSettings !== null,
        selected: false,
      });
    }
  }
  
  return comparisons;
}

/**
 * Fetch and compare settings for a sync configuration
 */
export async function fetchSettingsComparison(
  syncId: string,
  syncName: string,
  sourceConfig: HostConfig,
  targetConfig: HostConfig,
  sourceEnterprise?: string,
  targetEnterprise?: string
): Promise<ExtendedOrgComparison> {
  const errors: string[] = [];
  
  // Fetch org settings in parallel - each function handles its own errors
  const [
    sourceSettings,
    targetSettings,
    sourceActions,
    targetActions,
    sourceWebhooks,
    targetWebhooks,
    sourceTeams,
    targetTeams,
    sourceCopilot,
    targetCopilot
  ] = await Promise.all([
    fetchOrgSettings(sourceConfig),
    fetchOrgSettings(targetConfig),
    fetchActionsPermissions(sourceConfig),
    fetchActionsPermissions(targetConfig),
    fetchOrgWebhooksCount(sourceConfig),
    fetchOrgWebhooksCount(targetConfig),
    fetchOrgTeamsCount(sourceConfig),
    fetchOrgTeamsCount(targetConfig),
    fetchCopilotSettings(sourceConfig),
    fetchCopilotSettings(targetConfig),
  ]);
  
  // Track errors for user feedback
  if (!sourceSettings) {
    errors.push(`Could not fetch settings for source org ${sourceConfig.org} (check PAT authorization for SAML/SSO)`);
  }
  if (!targetSettings) {
    errors.push(`Could not fetch settings for target org ${targetConfig.org} (check PAT authorization for SAML/SSO)`);
  }
  
  const settings = compareOrgSettings(sourceSettings, targetSettings);
  const copilotSettingsComparison = compareCopilotSettings(sourceCopilot, targetCopilot);
  
  // Build the base result
  const result: ExtendedOrgComparison = {
    syncId,
    syncName,
    sourceOrg: sourceConfig.org,
    targetOrg: targetConfig.org,
    sourceHost: sourceConfig.hostLabel,
    targetHost: targetConfig.hostLabel,
    fetchedAt: new Date().toISOString(),
    settings,
    sourceActionsPermissions: sourceActions ?? undefined,
    targetActionsPermissions: targetActions ?? undefined,
    sourceWebhooksCount: sourceWebhooks,
    targetWebhooksCount: targetWebhooks,
    sourceTeamsCount: sourceTeams,
    targetTeamsCount: targetTeams,
    sourceCopilotSettings: sourceCopilot ?? undefined,
    targetCopilotSettings: targetCopilot ?? undefined,
    sourceCopilotSeats: sourceCopilot?.seat_breakdown,
    targetCopilotSeats: targetCopilot?.seat_breakdown,
    copilotSettingsComparison: copilotSettingsComparison.length > 0 ? copilotSettingsComparison : undefined,
    sourceEnterprise: sourceEnterprise,
    targetEnterprise: targetEnterprise,
    warnings: errors.length > 0 ? errors : undefined,
  };
  
  // Fetch enterprise settings if enterprise slugs are provided
  if (sourceEnterprise && targetEnterprise) {
    try {
      const [sourceEnterpriseSettings, targetEnterpriseSettings] = await Promise.all([
        fetchEnterpriseSecuritySettings(sourceEnterprise, sourceConfig),
        fetchEnterpriseSecuritySettings(targetEnterprise, targetConfig),
      ]);
      
      if (sourceEnterpriseSettings || targetEnterpriseSettings) {
        result.sourceEnterpriseSettings = sourceEnterpriseSettings ?? undefined;
        result.targetEnterpriseSettings = targetEnterpriseSettings ?? undefined;
        result.enterpriseSettingsComparison = compareEnterpriseSecuritySettings(
          sourceEnterpriseSettings,
          targetEnterpriseSettings
        );
      }
    } catch (err) {
      result.enterpriseSettingsError = `Failed to fetch enterprise settings: ${err}`;
    }
  }
  
  return result;
}

/**
 * Apply selected settings from source to target organization
 */
export async function applySettings(
  sourceConfig: HostConfig,
  targetConfig: HostConfig,
  settingsToApply: (keyof OrgSettings)[]
): Promise<ApplySettingsResult> {
  const applied: (keyof OrgSettings)[] = [];
  const failed: { key: keyof OrgSettings; error: string }[] = [];
  
  if (settingsToApply.length === 0) {
    return { success: true, applied, failed };
  }
  
  // Fetch current source settings
  const sourceSettings = await fetchOrgSettings(sourceConfig);
  
  if (!sourceSettings) {
    return { 
      success: false, 
      applied, 
      failed: settingsToApply.map(key => ({ key, error: 'Could not fetch source org settings (SAML/SSO authorization required)' }))
    };
  }
  
  // Build the update payload with only selected settings
  const updatePayload: Partial<OrgSettings> = {};
  const writableSettings = getWritableSettings();
  
  for (const key of settingsToApply) {
    if (!writableSettings.has(key)) {
      failed.push({ key, error: 'Setting is read-only' });
      continue;
    }
    
    const value = sourceSettings[key];
    if (value !== undefined) {
      (updatePayload as Record<string, unknown>)[key] = value;
    }
  }
  
  if (Object.keys(updatePayload).length === 0) {
    return { success: failed.length === 0, applied, failed };
  }
  
  try {
    await updateOrgSettings(targetConfig, updatePayload);
    applied.push(...(Object.keys(updatePayload) as (keyof OrgSettings)[]));
  } catch (error) {
    // If batch update fails, try one by one
    serverLog.warn('Batch update failed, trying individual updates');
    
    for (const [key, value] of Object.entries(updatePayload)) {
      try {
        await updateOrgSettings(targetConfig, { [key]: value } as Partial<OrgSettings>);
        applied.push(key as keyof OrgSettings);
      } catch (err) {
        failed.push({ key: key as keyof OrgSettings, error: String(err) });
      }
    }
  }
  
  return {
    success: failed.length === 0,
    applied,
    failed
  };
}
