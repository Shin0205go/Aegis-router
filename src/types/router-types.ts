// ============================================================================
// AEGIS Router Core - Type Definitions
// Defines types for role-based routing and dynamic tool filtering
// ============================================================================

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ============================================================================
// Role Configuration
// ============================================================================

/**
 * Role definition that determines which servers/tools are accessible
 */
export interface Role {
  /** Unique role identifier (e.g., 'frontend', 'db_admin', 'security') */
  id: string;

  /** Human-readable role name */
  name: string;

  /** Role description */
  description: string;

  /** List of allowed upstream server names */
  allowedServers: string[];

  /** System instruction/prompt for this role (loaded from PROMPT.md or remote) */
  systemInstruction: string;

  /**
   * Remote instruction configuration if this role fetches prompt from MCP server
   * Used to refetch the prompt on role activation
   */
  remoteInstruction?: RemoteInstruction;

  /** Optional tool-level permissions within allowed servers */
  toolPermissions?: ToolPermissions;

  /** Role metadata */
  metadata?: RoleMetadata;
}

/**
 * Tool-level permissions for fine-grained access control
 */
export interface ToolPermissions {
  /** Explicitly allowed tools (overrides server-level permissions) */
  allow?: string[];

  /** Explicitly denied tools (overrides allow list) */
  deny?: string[];

  /** Tool patterns to allow (glob-style, e.g., 'filesystem__read*') */
  allowPatterns?: string[];

  /** Tool patterns to deny */
  denyPatterns?: string[];
}

/**
 * Role metadata for management and auditing
 */
export interface RoleMetadata {
  /** Role version */
  version?: string;

  /** When the role was created */
  createdAt?: Date;

  /** Who created the role */
  createdBy?: string;

  /** Last modification time */
  lastModified?: Date;

  /** Role priority (higher = more privileged) */
  priority?: number;

  /** Tags for categorization */
  tags?: string[];

  /** Whether this role is currently active */
  active?: boolean;
}

// ============================================================================
// Role Configuration File Format
// ============================================================================

/**
 * Configuration file format for roles (aegis-roles.json)
 */
export interface RolesConfig {
  /** Configuration version */
  version: string;

  /** Default role when no role is specified */
  defaultRole: string;

  /** Role definitions */
  roles: RoleConfig[];

  /** Server group definitions for easier role configuration */
  serverGroups?: Record<string, string[]>;
}

/**
 * Role configuration as stored in config file
 */
export interface RoleConfig {
  /** Role ID */
  id: string;

  /** Role name */
  name: string;

  /** Role description */
  description: string;

  /** List of allowed servers or server groups (prefixed with @) */
  allowedServers: string[];

  /** Path to PROMPT.md file (relative to roles directory) */
  promptFile?: string;

  /** Inline system instruction (used if promptFile is not specified) */
  systemInstruction?: string;

  /**
   * Remote instruction configuration - fetch prompt from an MCP server
   * This takes precedence over promptFile and systemInstruction when specified
   */
  remoteInstruction?: RemoteInstruction;

  /** Tool permissions */
  toolPermissions?: ToolPermissions;

  /** Metadata */
  metadata?: RoleMetadata;
}

/**
 * Configuration for fetching system instruction from a remote MCP server
 * Uses the MCP prompts/get protocol to retrieve the prompt
 */
export interface RemoteInstruction {
  /** Backend/server name that provides the prompt */
  backend: string;

  /** Name of the prompt to fetch via prompts/get */
  promptName: string;

  /** Optional arguments to pass to the prompt */
  arguments?: Record<string, string>;

  /** Cache TTL in seconds (0 = no cache, default = 300) */
  cacheTtl?: number;

  /** Fallback instruction if remote fetch fails */
  fallback?: string;
}

// ============================================================================
// Agent Configuration (Persona + Skills Architecture)
// ============================================================================

/**
 * Agent configuration - skill-based agent definition
 *
 * Design philosophy:
 * - Agent = skill + access control
 * - Skill provides instruction (SKILL.md) and tools
 * - AEGIS controls which servers/skills/tools are accessible
 */
export interface AgentConfig {
  /** Agent ID for internal reference */
  id: string;

  /** Display name shown to users */
  displayName: string;

  /** Description of what this agent does */
  description: string;

  /** Allowed backend servers for this agent */
  allowedServers: string[];

  /** Allowed skills (filters list_skills/get_skill responses) */
  allowedSkills?: string[];

  /** Tool permissions for fine-grained control */
  toolPermissions?: ToolPermissions;

  /** Agent metadata */
  metadata?: RoleMetadata;
}

/**
 * Backend server configuration
 */
export interface BackendConfig {
  /** Command to run the server */
  command: string;

  /** Command arguments */
  args?: string[];

  /** Environment variables */
  env?: Record<string, string>;

  /** Working directory */
  cwd?: string;

  /** Description of what this backend provides */
  description?: string;
}

/**
 * Extended roles config that supports both legacy roles and new agents
 */
export interface ExtendedRolesConfig extends RolesConfig {
  /**
   * Backend server definitions
   * Maps backend name to its configuration
   */
  backends?: Record<string, BackendConfig>;

  /**
   * Agent definitions (new format)
   * These combine personas with skills from backends
   */
  agents?: AgentConfig[];
}

// ============================================================================
// Router State
// ============================================================================

/**
 * Current state of the AEGIS Router
 */
export interface AegisRouterState {
  /** Currently active role */
  currentRole: Role | null;

  /** All available roles */
  availableRoles: Map<string, Role>;

  /** Connected sub-MCP servers */
  connectedServers: Map<string, SubServerInfo>;

  /** Currently visible tools (filtered by role) */
  visibleTools: Map<string, ToolInfo>;

  /** State metadata */
  metadata: RouterStateMetadata;
}

/**
 * Information about a connected sub-MCP server
 */
export interface SubServerInfo {
  /** Server name/identifier */
  name: string;

  /** Whether the server is connected */
  connected: boolean;

  /** Whether the server is active for current role */
  activeForRole: boolean;

  /** Tools provided by this server */
  tools: Tool[];

  /** Last activity timestamp */
  lastActivity?: Date;

  /** Server health status */
  health?: 'healthy' | 'degraded' | 'unhealthy';
}

/**
 * Extended tool information with source tracking
 */
export interface ToolInfo {
  /** Original tool definition */
  tool: Tool;

  /** Source server name */
  sourceServer: string;

  /** Prefixed tool name (serverName__toolName) */
  prefixedName: string;

  /** Whether this tool is currently visible */
  visible: boolean;

  /** Why this tool is visible/hidden */
  visibilityReason?: string;
}

/**
 * Router state metadata
 */
export interface RouterStateMetadata {
  /** When the router was initialized */
  initializedAt: Date;

  /** Last role switch timestamp */
  lastRoleSwitch?: Date;

  /** Number of role switches in this session */
  roleSwitchCount: number;

  /** Session ID */
  sessionId: string;
}

// ============================================================================
// Agent Manifest (get_agent_manifest result)
// ============================================================================

/**
 * Result of get_agent_manifest tool call
 */
export interface AgentManifest {
  /** Role that was activated */
  role: ManifestRole;

  /** System instruction/prompt for the AI agent */
  systemInstruction: string;

  /** List of available tools for this role */
  availableTools: ManifestTool[];

  /** List of available servers for this role */
  availableServers: string[];

  /** Manifest metadata */
  metadata: ManifestMetadata;
}

/**
 * Role information in manifest
 */
export interface ManifestRole {
  /** Role ID */
  id: string;

  /** Role name */
  name: string;

  /** Role description */
  description: string;
}

/**
 * Tool information in manifest
 */
export interface ManifestTool {
  /** Tool name (prefixed) */
  name: string;

  /** Tool description */
  description?: string;

  /** Source server */
  source: string;

  /** Tool category (if available) */
  category?: string;
}

/**
 * Manifest metadata
 */
export interface ManifestMetadata {
  /** When the manifest was generated */
  generatedAt: Date;

  /** Previous role (if switching) */
  previousRole?: string;

  /** Whether tools list changed */
  toolsChanged: boolean;

  /** Number of tools available */
  toolCount: number;

  /** Number of servers active */
  serverCount: number;
}

// ============================================================================
// Router Events
// ============================================================================

/**
 * Event emitted when role changes
 */
export interface RoleSwitchEvent {
  /** Event type */
  type: 'role_switch';

  /** Timestamp */
  timestamp: Date;

  /** Previous role (null if first switch) */
  previousRole: string | null;

  /** New role */
  newRole: string;

  /** Tools that were added */
  addedTools: string[];

  /** Tools that were removed */
  removedTools: string[];

  /** Who initiated the switch */
  initiatedBy?: string;
}

/**
 * Event emitted when tools list changes
 */
export interface ToolsChangedEvent {
  /** Event type */
  type: 'tools_changed';

  /** Timestamp */
  timestamp: Date;

  /** Current role */
  role: string;

  /** Reason for change */
  reason: 'role_switch' | 'server_connect' | 'server_disconnect' | 'config_update';

  /** Current tool count */
  toolCount: number;
}

// ============================================================================
// Router Errors
// ============================================================================

/**
 * Error thrown when role is not found
 */
export class RoleNotFoundError extends Error {
  constructor(
    public readonly roleId: string,
    public readonly availableRoles: string[]
  ) {
    super(`Role '${roleId}' not found. Available roles: ${availableRoles.join(', ')}`);
    this.name = 'RoleNotFoundError';
  }
}

/**
 * Error thrown when server is not accessible for current role
 */
export class ServerNotAccessibleError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly currentRole: string,
    public readonly allowedServers: string[]
  ) {
    super(
      `Server '${serverName}' is not accessible for role '${currentRole}'. ` +
      `Allowed servers: ${allowedServers.join(', ')}`
    );
    this.name = 'ServerNotAccessibleError';
  }
}

/**
 * Error thrown when tool is not accessible
 */
export class ToolNotAccessibleError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly currentRole: string,
    public readonly reason: string
  ) {
    super(`Tool '${toolName}' is not accessible for role '${currentRole}': ${reason}`);
    this.name = 'ToolNotAccessibleError';
  }
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Options for get_agent_manifest tool
 */
export interface GetAgentManifestOptions {
  /** Role to activate */
  role: string;

  /** Whether to include full tool descriptions */
  includeToolDescriptions?: boolean;

  /** Whether to include server health info */
  includeServerHealth?: boolean;
}

/**
 * Options for listing available roles
 */
export interface ListRolesOptions {
  /** Include inactive roles */
  includeInactive?: boolean;

  /** Filter by tags */
  tags?: string[];
}

/**
 * Result of listing roles
 */
export interface ListRolesResult {
  /** Available roles */
  roles: Array<{
    id: string;
    name: string;
    description: string;
    serverCount: number;
    isActive: boolean;
    isCurrent: boolean;
  }>;

  /** Current role ID */
  currentRole: string | null;

  /** Default role ID */
  defaultRole: string;
}
