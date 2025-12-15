// Types for organization and enterprise settings sync

/**
 * Organization settings that can be synced via the REST API
 * Based on GET/PATCH /orgs/{org} endpoints
 */
export interface OrgSettings {
  // Basic Info
  name?: string;
  description?: string;
  company?: string;
  blog?: string;
  location?: string;
  email?: string;
  twitter_username?: string;
  
  // Repository defaults
  default_repository_permission?: 'read' | 'write' | 'admin' | 'none';
  default_repository_branch?: string;
  
  // Member permissions - Repository creation
  members_can_create_repositories?: boolean;
  members_can_create_public_repositories?: boolean;
  members_can_create_private_repositories?: boolean;
  members_can_create_internal_repositories?: boolean;
  members_allowed_repository_creation_type?: 'all' | 'private' | 'none';
  
  // Member permissions - Other
  members_can_fork_private_repositories?: boolean;
  members_can_create_pages?: boolean;
  members_can_create_public_pages?: boolean;
  members_can_create_private_pages?: boolean;
  members_can_delete_repositories?: boolean;
  members_can_change_repo_visibility?: boolean;
  members_can_invite_outside_collaborators?: boolean;
  members_can_delete_issues?: boolean;
  members_can_create_teams?: boolean;
  members_can_view_dependency_insights?: boolean;
  
  // Projects
  has_organization_projects?: boolean;
  has_repository_projects?: boolean;
  
  // Security features (for new repositories)
  advanced_security_enabled_for_new_repositories?: boolean;
  dependabot_alerts_enabled_for_new_repositories?: boolean;
  dependabot_security_updates_enabled_for_new_repositories?: boolean;
  dependency_graph_enabled_for_new_repositories?: boolean;
  secret_scanning_enabled_for_new_repositories?: boolean;
  secret_scanning_push_protection_enabled_for_new_repositories?: boolean;
  secret_scanning_push_protection_custom_link_enabled?: boolean;
  secret_scanning_push_protection_custom_link?: string;
  
  // Other settings
  two_factor_requirement_enabled?: boolean;
  web_commit_signoff_required?: boolean;
  deploy_keys_enabled_for_repositories?: boolean;
  readers_can_create_discussions?: boolean;
  display_commenter_full_name_setting_enabled?: boolean;
  
  // Read-only info (not settable)
  is_verified?: boolean;
  public_repos?: number;
  total_private_repos?: number;
  owned_private_repos?: number;
  collaborators?: number;
  billing_email?: string;
  plan?: {
    name: string;
    space: number;
    private_repos: number;
    filled_seats?: number;
    seats?: number;
  };
}

/**
 * Settings categories for UI grouping
 */
export interface SettingsCategory {
  id: string;
  name: string;
  description: string;
  settings: SettingDefinition[];
}

/**
 * Definition of a single setting
 */
export interface SettingDefinition {
  key: keyof OrgSettings;
  label: string;
  description: string;
  type: 'boolean' | 'string' | 'select' | 'readonly';
  options?: { value: string; label: string }[];
  requiresAdmin?: boolean;
  deprecated?: boolean;
}

/**
 * All organization settings categories
 */
export const ORG_SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'basic',
    name: 'Basic Information',
    description: 'Organization profile and contact information',
    settings: [
      { key: 'name', label: 'Display Name', description: 'The display name of the organization', type: 'string' },
      { key: 'description', label: 'Description', description: 'A short description of the organization (max 160 chars)', type: 'string' },
      { key: 'company', label: 'Company', description: 'The company name', type: 'string' },
      { key: 'blog', label: 'Blog URL', description: 'The organization blog URL', type: 'string' },
      { key: 'location', label: 'Location', description: 'The location', type: 'string' },
      { key: 'email', label: 'Email', description: 'The publicly visible email address', type: 'string' },
      { key: 'twitter_username', label: 'Twitter Username', description: 'The Twitter username', type: 'string' },
    ]
  },
  {
    id: 'repository-defaults',
    name: 'Repository Defaults',
    description: 'Default settings for new repositories',
    settings: [
      { key: 'default_repository_permission', label: 'Base Permission', description: 'Default permission level members have for organization repositories', type: 'select', options: [
        { value: 'read', label: 'Read' },
        { value: 'write', label: 'Write' },
        { value: 'admin', label: 'Admin' },
        { value: 'none', label: 'None' }
      ]},
      { key: 'default_repository_branch', label: 'Default Branch', description: 'The default branch name for new repositories', type: 'string' },
    ]
  },
  {
    id: 'member-repo-creation',
    name: 'Member Repository Creation',
    description: 'Controls what types of repositories members can create',
    settings: [
      { key: 'members_can_create_repositories', label: 'Allow Repository Creation', description: 'Whether non-admin members can create repositories', type: 'boolean' },
      { key: 'members_can_create_public_repositories', label: 'Allow Public Repos', description: 'Whether members can create public repositories', type: 'boolean' },
      { key: 'members_can_create_private_repositories', label: 'Allow Private Repos', description: 'Whether members can create private repositories', type: 'boolean' },
      { key: 'members_can_create_internal_repositories', label: 'Allow Internal Repos', description: 'Whether members can create internal repositories (Enterprise only)', type: 'boolean' },
    ]
  },
  {
    id: 'member-permissions',
    name: 'Member Permissions',
    description: 'Additional permissions granted to organization members',
    settings: [
      { key: 'members_can_fork_private_repositories', label: 'Fork Private Repos', description: 'Whether members can fork private organization repositories', type: 'boolean' },
      { key: 'members_can_delete_repositories', label: 'Delete Repositories', description: 'Whether members can delete or transfer repositories', type: 'boolean' },
      { key: 'members_can_change_repo_visibility', label: 'Change Visibility', description: 'Whether members can change repository visibility', type: 'boolean' },
      { key: 'members_can_invite_outside_collaborators', label: 'Invite Collaborators', description: 'Whether members can invite outside collaborators', type: 'boolean' },
      { key: 'members_can_delete_issues', label: 'Delete Issues', description: 'Whether members can delete issues', type: 'boolean' },
      { key: 'members_can_create_teams', label: 'Create Teams', description: 'Whether members can create teams', type: 'boolean' },
      { key: 'members_can_view_dependency_insights', label: 'View Dependencies', description: 'Whether members can view dependency insights', type: 'boolean' },
    ]
  },
  {
    id: 'pages',
    name: 'GitHub Pages',
    description: 'GitHub Pages creation permissions',
    settings: [
      { key: 'members_can_create_pages', label: 'Allow Pages', description: 'Whether members can create GitHub Pages sites', type: 'boolean' },
      { key: 'members_can_create_public_pages', label: 'Allow Public Pages', description: 'Whether members can create public GitHub Pages sites', type: 'boolean' },
      { key: 'members_can_create_private_pages', label: 'Allow Private Pages', description: 'Whether members can create private GitHub Pages sites', type: 'boolean' },
    ]
  },
  {
    id: 'projects',
    name: 'Projects',
    description: 'Project board settings',
    settings: [
      { key: 'has_organization_projects', label: 'Organization Projects', description: 'Whether the organization can use organization projects', type: 'boolean' },
      { key: 'has_repository_projects', label: 'Repository Projects', description: 'Whether repositories can use repository projects', type: 'boolean' },
    ]
  },
  {
    id: 'security',
    name: 'Security Features',
    description: 'Security features for new repositories (use Code Security Configurations for better control)',
    settings: [
      { key: 'two_factor_requirement_enabled', label: '2FA Required', description: 'Whether all members must have two-factor authentication enabled', type: 'readonly' },
      { key: 'web_commit_signoff_required', label: 'Commit Sign-off Required', description: 'Whether contributors must sign off on web-based commits', type: 'boolean' },
      { key: 'advanced_security_enabled_for_new_repositories', label: 'Advanced Security (New Repos)', description: 'Whether Advanced Security is enabled for new repositories', type: 'boolean', deprecated: true },
      { key: 'dependabot_alerts_enabled_for_new_repositories', label: 'Dependabot Alerts (New Repos)', description: 'Whether Dependabot alerts are enabled for new repositories', type: 'boolean', deprecated: true },
      { key: 'dependabot_security_updates_enabled_for_new_repositories', label: 'Dependabot Updates (New Repos)', description: 'Whether Dependabot security updates are enabled for new repositories', type: 'boolean', deprecated: true },
      { key: 'dependency_graph_enabled_for_new_repositories', label: 'Dependency Graph (New Repos)', description: 'Whether dependency graph is enabled for new repositories', type: 'boolean', deprecated: true },
      { key: 'secret_scanning_enabled_for_new_repositories', label: 'Secret Scanning (New Repos)', description: 'Whether secret scanning is enabled for new repositories', type: 'boolean', deprecated: true },
      { key: 'secret_scanning_push_protection_enabled_for_new_repositories', label: 'Push Protection (New Repos)', description: 'Whether secret scanning push protection is enabled for new repositories', type: 'boolean', deprecated: true },
    ]
  },
  {
    id: 'other',
    name: 'Other Settings',
    description: 'Miscellaneous organization settings',
    settings: [
      { key: 'deploy_keys_enabled_for_repositories', label: 'Deploy Keys', description: 'Whether deploy keys can be added to repositories', type: 'boolean' },
      { key: 'readers_can_create_discussions', label: 'Readers Create Discussions', description: 'Whether users with read access can create discussions', type: 'boolean' },
    ]
  },
  {
    id: 'readonly',
    name: 'Read-Only Information',
    description: 'Information that cannot be changed via API',
    settings: [
      { key: 'is_verified', label: 'Verified', description: 'Whether the organization is verified', type: 'readonly' },
      { key: 'public_repos', label: 'Public Repos', description: 'Number of public repositories', type: 'readonly' },
      { key: 'total_private_repos', label: 'Private Repos', description: 'Total number of private repositories', type: 'readonly' },
    ]
  }
];

/**
 * Comparison result for a single setting
 */
export interface SettingComparison {
  key: keyof OrgSettings;
  sourceValue: unknown;
  targetValue: unknown;
  isEqual: boolean;
  canSync: boolean;
  selected: boolean;
}

/**
 * Full comparison result for an organization pair
 */
export interface OrgSettingsComparison {
  syncId: string;
  syncName: string;
  sourceOrg: string;
  targetOrg: string;
  sourceHost: string;
  targetHost: string;
  fetchedAt: string;
  settings: SettingComparison[];
  error?: string;
}

/**
 * Request to apply settings from source to target
 */
export interface ApplySettingsRequest {
  syncId: string;
  settingsToApply: (keyof OrgSettings)[];
}

/**
 * Result of applying settings
 */
export interface ApplySettingsResult {
  success: boolean;
  applied: (keyof OrgSettings)[];
  failed: { key: keyof OrgSettings; error: string }[];
}

/**
 * Actions permissions settings
 */
export interface ActionsPermissions {
  enabled_repositories?: 'all' | 'none' | 'selected';
  allowed_actions?: 'all' | 'local_only' | 'selected';
}

/**
 * Webhook definition
 */
export interface OrgWebhook {
  id: number;
  name: string;
  active: boolean;
  events: string[];
  config: {
    url?: string;
    content_type?: string;
    insecure_ssl?: string;
  };
}

/**
 * Team definition for comparison
 */
export interface OrgTeam {
  id: number;
  node_id: string;
  name: string;
  slug: string;
  description: string | null;
  privacy: 'secret' | 'closed';
  permission: 'pull' | 'push' | 'admin' | 'maintain' | 'triage';
  parent: { id: number; name: string } | null;
}

/**
 * Role definition
 */
export interface OrgRole {
  id: number;
  name: string;
  description: string;
  permissions: string[];
  base_role?: string;
}

/**
 * Enterprise-level code security and analysis settings
 * Available via GET/PATCH /enterprises/{enterprise}/code_security_and_analysis
 */
export interface EnterpriseSecuritySettings {
  advanced_security_enabled_for_new_repositories?: boolean;
  advanced_security_enabled_new_user_namespace_repos?: boolean;
  dependabot_alerts_enabled_for_new_repositories?: boolean;
  secret_scanning_enabled_for_new_repositories?: boolean;
  secret_scanning_push_protection_enabled_for_new_repositories?: boolean;
  secret_scanning_push_protection_custom_link?: string | null;
  secret_scanning_non_provider_patterns_enabled_for_new_repositories?: boolean;
  secret_scanning_validity_checks_enabled?: boolean;
}

/**
 * Enterprise security settings categories
 */
export const ENTERPRISE_SECURITY_SETTINGS: SettingDefinition[] = [
  { key: 'advanced_security_enabled_for_new_repositories' as keyof OrgSettings, label: 'Advanced Security (New Repos)', description: 'Auto-enable GHAS for new repos', type: 'boolean' },
  { key: 'advanced_security_enabled_new_user_namespace_repos' as keyof OrgSettings, label: 'Advanced Security (User Namespace)', description: 'Auto-enable GHAS for user namespace repos', type: 'boolean' },
  { key: 'dependabot_alerts_enabled_for_new_repositories' as keyof OrgSettings, label: 'Dependabot Alerts (New Repos)', description: 'Auto-enable Dependabot alerts for new repos', type: 'boolean' },
  { key: 'secret_scanning_enabled_for_new_repositories' as keyof OrgSettings, label: 'Secret Scanning (New Repos)', description: 'Auto-enable secret scanning for new repos', type: 'boolean' },
  { key: 'secret_scanning_push_protection_enabled_for_new_repositories' as keyof OrgSettings, label: 'Push Protection (New Repos)', description: 'Auto-enable push protection for new repos', type: 'boolean' },
  { key: 'secret_scanning_non_provider_patterns_enabled_for_new_repositories' as keyof OrgSettings, label: 'Non-Provider Patterns (New Repos)', description: 'Scan for non-provider patterns in new repos', type: 'boolean' },
  { key: 'secret_scanning_validity_checks_enabled' as keyof OrgSettings, label: 'Secret Validity Checks', description: 'Enable secret validity checks', type: 'boolean' },
];

/**
 * Copilot settings for an organization
 * Available via GET /orgs/{org}/copilot/billing
 */
export interface CopilotOrgSettings {
  seat_breakdown?: {
    total: number;
    added_this_cycle: number;
    pending_invitation: number;
    pending_cancellation: number;
    active_this_cycle: number;
    inactive_this_cycle: number;
  };
  seat_management_setting?: 'assign_all' | 'assign_selected' | 'disabled' | 'unconfigured';
  ide_chat?: 'enabled' | 'disabled' | 'unconfigured';
  platform_chat?: 'enabled' | 'disabled' | 'unconfigured';
  cli?: 'enabled' | 'disabled' | 'unconfigured';
  public_code_suggestions?: 'allow' | 'block' | 'unconfigured';
  plan_type?: 'business' | 'enterprise' | 'unknown';
}

/**
 * Copilot settings definitions for comparison
 */
export const COPILOT_SETTINGS: { key: keyof CopilotOrgSettings; label: string; description: string; type: 'string' | 'readonly' }[] = [
  { key: 'seat_management_setting', label: 'Seat Management', description: 'How Copilot seats are assigned', type: 'readonly' },
  { key: 'ide_chat', label: 'IDE Chat', description: 'Copilot Chat in IDE', type: 'readonly' },
  { key: 'platform_chat', label: 'Platform Chat', description: 'Copilot Chat on github.com', type: 'readonly' },
  { key: 'cli', label: 'CLI', description: 'Copilot in CLI', type: 'readonly' },
  { key: 'public_code_suggestions', label: 'Public Code Suggestions', description: 'Allow suggestions matching public code', type: 'readonly' },
  { key: 'plan_type', label: 'Plan Type', description: 'Copilot subscription plan', type: 'readonly' },
];

/**
 * Comparison result for enterprise settings
 */
export interface EnterpriseSettingComparison {
  key: string;
  label: string;
  sourceValue: unknown;
  targetValue: unknown;
  isEqual: boolean;
  canSync: boolean;
}

/**
 * Comparison result for Copilot settings
 */
export interface CopilotSettingComparison {
  key: keyof CopilotOrgSettings;
  label: string;
  sourceValue: unknown;
  targetValue: unknown;
  isEqual: boolean;
}

/**
 * Extended sync comparison including additional resources
 */
export interface ExtendedOrgComparison extends OrgSettingsComparison {
  // Actions
  sourceActionsPermissions?: ActionsPermissions;
  targetActionsPermissions?: ActionsPermissions;
  
  // Webhooks (count only - can't sync these directly)
  sourceWebhooksCount?: number;
  targetWebhooksCount?: number;
  
  // Teams (for reference)
  sourceTeamsCount?: number;
  targetTeamsCount?: number;
  
  // Custom roles (GitHub Enterprise)
  sourceRolesCount?: number;
  targetRolesCount?: number;
  
  // Enterprise info
  sourceEnterprise?: string;
  targetEnterprise?: string;
  
  // Enterprise security settings (if available)
  sourceEnterpriseSettings?: EnterpriseSecuritySettings;
  targetEnterpriseSettings?: EnterpriseSecuritySettings;
  enterpriseSettingsComparison?: EnterpriseSettingComparison[];
  enterpriseSettingsError?: string;
  
  // Copilot settings (organization level)
  sourceCopilotSettings?: CopilotOrgSettings;
  targetCopilotSettings?: CopilotOrgSettings;
  copilotSettingsComparison?: CopilotSettingComparison[];
  copilotSettingsError?: string;
  
  // Copilot seat breakdown for extra info display
  sourceCopilotSeats?: { total: number; active_this_cycle: number };
  targetCopilotSeats?: { total: number; active_this_cycle: number };
  
  // Warnings for partial failures (SAML, missing scopes, etc.)
  warnings?: string[];
}
