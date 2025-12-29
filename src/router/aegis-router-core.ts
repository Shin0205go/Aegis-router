// ============================================================================
// AEGIS Router Core - Central Routing and Role Management
// The "司令塔" (command center) for multi-server MCP routing
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { StdioRouter, UpstreamServerInfo } from '../mcp/stdio-router.js';
import type { MCPServerConfig } from '../types/mcp-types.js';
import { RoleConfigManager, createRoleConfigManager } from './role-config.js';
import type {
  Role,
  AegisRouterState,
  SubServerInfo,
  ToolInfo,
  AgentManifest,
  ManifestTool,
  RoleSwitchEvent,
  ToolsChangedEvent,
  GetAgentManifestOptions,
  ListRolesResult,
  RoleNotFoundError,
  ToolNotAccessibleError,
  ServerNotAccessibleError
} from '../types/router-types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * AegisRouterCore - Central routing system for AEGIS
 *
 * This class serves as the "司令塔" (command center) that:
 * 1. Manages connections to multiple sub-MCP servers
 * 2. Maintains a virtual tool table filtered by current role
 * 3. Handles role switching via get_agent_manifest
 * 4. Emits notifications when tools change
 */
export class AegisRouterCore extends EventEmitter {
  private logger: Logger;
  private stdioRouter: StdioRouter;
  private roleConfigManager: RoleConfigManager;

  // Router state
  private state: AegisRouterState;

  // Track all tools from all servers (unfiltered)
  private allTools: Map<string, ToolInfo> = new Map();

  // Notification callback for tools/list_changed
  private toolsChangedCallback?: () => Promise<void>;

  // Initialization state
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    logger: Logger,
    options?: {
      rolesDir?: string;
      configFile?: string;
    }
  ) {
    super();
    this.logger = logger;

    // Initialize StdioRouter for managing upstream servers
    this.stdioRouter = new StdioRouter(logger);

    // Initialize role configuration manager
    this.roleConfigManager = createRoleConfigManager(logger, options);

    // Initialize state
    this.state = {
      currentRole: null,
      availableRoles: new Map(),
      connectedServers: new Map(),
      visibleTools: new Map(),
      metadata: {
        initializedAt: new Date(),
        roleSwitchCount: 0,
        sessionId: uuidv4()
      }
    };

    this.logger.debug('AegisRouterCore created', {
      sessionId: this.state.metadata.sessionId
    });
  }

  /**
   * Initialize the router core
   * Loads roles and prepares for connections
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.debug('Router core already initialized');
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._doInitialize();
    return this.initializationPromise;
  }

  private async _doInitialize(): Promise<void> {
    this.logger.info('Initializing AEGIS Router Core...');

    try {
      // Initialize role configuration
      await this.roleConfigManager.initialize();

      // Load roles into state
      const allRoles = this.roleConfigManager.getAllRoles();
      for (const role of allRoles) {
        this.state.availableRoles.set(role.id, role);
      }

      this.logger.info(`Loaded ${this.state.availableRoles.size} roles`);

      // Set default role if available
      const defaultRole = this.roleConfigManager.getDefaultRole();
      if (defaultRole) {
        this.state.currentRole = defaultRole;
        this.logger.info(`Default role set to: ${defaultRole.id}`);
      }

      this.initialized = true;
      this.logger.info('AEGIS Router Core initialized successfully');

    } catch (error) {
      this.logger.error('Failed to initialize router core:', error);
      throw error;
    }
  }

  // ============================================================================
  // Connection Manager - Manages sub-MCP server connections
  // ============================================================================

  /**
   * Add a server from configuration
   */
  addServer(name: string, config: MCPServerConfig): void {
    this.stdioRouter.addServerFromConfig(name, config);
    this.logger.debug(`Added server configuration: ${name}`);
  }

  /**
   * Load servers from Claude Desktop config format
   */
  loadServersFromConfig(config: { mcpServers: Record<string, MCPServerConfig> }): void {
    this.stdioRouter.loadServersFromDesktopConfig(config);
    this.logger.info(`Loaded ${Object.keys(config.mcpServers).length} server configurations`);
  }

  /**
   * Start all configured servers
   */
  async startServers(): Promise<void> {
    this.logger.info('Starting upstream MCP servers...');
    await this.stdioRouter.startServers();

    // Update connected servers state
    await this.updateConnectedServersState();

    // Discover tools from all connected servers
    await this.discoverAllTools();

    // Apply role-based filtering
    this.updateVisibleTools();

    // Set up the prompt router for remote instruction fetching
    // This enables roles to fetch their system instructions from MCP servers
    this.roleConfigManager.setPromptRouter(this.createPromptRouter());

    this.logger.info('All upstream servers started and tools discovered');
  }

  /**
   * Create a prompt router that can route prompts/get requests to specific servers
   */
  private createPromptRouter() {
    return {
      routeRequest: async (request: any): Promise<any> => {
        // Check if this is a targeted request (for a specific backend)
        const targetServer = request._aegis_target_server;

        if (targetServer) {
          // Route to specific server
          this.logger.debug(`Routing prompts/get to server: ${targetServer}`);

          // Strip the _aegis_target_server and modify request for specific server
          const { _aegis_target_server, ...cleanRequest } = request;

          // Route through stdioRouter with server prefix
          return await this.stdioRouter.routeToServer(targetServer, cleanRequest);
        }

        // Default routing
        return await this.stdioRouter.routeRequest(request);
      }
    };
  }

  /**
   * Start servers required for a specific role (lazy loading)
   */
  async startServersForRole(roleId: string): Promise<void> {
    const role = this.roleConfigManager.getRole(roleId);
    if (!role) {
      this.logger.warn(`Role not found: ${roleId}`);
      return;
    }

    // Get allowed servers for this role
    const allowedServers = role.allowedServers;

    // If wildcard, start all servers
    if (allowedServers.includes('*')) {
      this.logger.info(`Role ${roleId} allows all servers, starting all...`);
      await this.startServers();
      return;
    }

    // Start only the required servers
    this.logger.info(`Starting servers for role ${roleId}: ${allowedServers.join(', ')}`);
    await this.stdioRouter.startServersByName(allowedServers);

    // Update state and discover tools
    await this.updateConnectedServersState();
    await this.discoverAllTools();
    // Note: Don't call updateVisibleTools() here - let getAgentManifest handle it
    // because currentRole hasn't been updated yet

    // Set up the prompt router
    this.roleConfigManager.setPromptRouter(this.createPromptRouter());

    this.logger.info(`Servers started for role ${roleId}`);
  }

  /**
   * Stop all servers
   */
  async stopServers(): Promise<void> {
    this.logger.info('Stopping upstream MCP servers...');
    await this.stdioRouter.stopServers();

    // Clear state
    this.state.connectedServers.clear();
    this.allTools.clear();
    this.state.visibleTools.clear();

    this.logger.info('All upstream servers stopped');
  }

  /**
   * Update the connected servers state from StdioRouter
   */
  private async updateConnectedServersState(): Promise<void> {
    const servers = this.stdioRouter.getAvailableServers();

    for (const server of servers) {
      const serverInfo: SubServerInfo = {
        name: server.name,
        connected: server.connected,
        activeForRole: this.isServerActiveForRole(server.name),
        tools: [],
        lastActivity: new Date(),
        health: server.connected ? 'healthy' : 'unhealthy'
      };

      this.state.connectedServers.set(server.name, serverInfo);
    }

    this.logger.debug(`Updated ${this.state.connectedServers.size} server states`);
  }

  /**
   * Check if a server is active for the current role
   */
  private isServerActiveForRole(serverName: string): boolean {
    if (!this.state.currentRole) {
      return true; // No role = allow all
    }

    const role = this.state.currentRole;

    // Wildcard allows all servers
    if (role.allowedServers.includes('*')) {
      return true;
    }

    return role.allowedServers.includes(serverName);
  }

  // ============================================================================
  // Virtual Tool Table - Role-based tool filtering
  // ============================================================================

  /**
   * Discover all tools from connected servers
   */
  private async discoverAllTools(): Promise<void> {
    this.logger.debug('Discovering tools from all connected servers...');

    try {
      // Request tools list through the router
      const request = {
        jsonrpc: '2.0' as const,
        id: Date.now(),
        method: 'tools/list',
        params: {}
      };

      const response = await this.stdioRouter.routeRequest(request);

      if (response.result?.tools) {
        this.allTools.clear();

        for (const tool of response.result.tools as Tool[]) {
          // Parse server name from prefixed tool name
          const { serverName, originalName } = this.parseToolName(tool.name);

          const toolInfo: ToolInfo = {
            tool,
            sourceServer: serverName,
            prefixedName: tool.name,
            visible: true, // Will be updated by role filtering
            visibilityReason: 'discovered'
          };

          this.allTools.set(tool.name, toolInfo);

          // Update server's tool list
          const serverInfo = this.state.connectedServers.get(serverName);
          if (serverInfo) {
            serverInfo.tools.push(tool);
          }
        }

        this.logger.info(`Discovered ${this.allTools.size} tools from upstream servers`);
      }
    } catch (error) {
      this.logger.error('Failed to discover tools:', error);
    }
  }

  /**
   * Parse a prefixed tool name into server name and original name
   */
  private parseToolName(prefixedName: string): { serverName: string; originalName: string } {
    const parts = prefixedName.split('__');
    if (parts.length >= 2) {
      return {
        serverName: parts[0],
        originalName: parts.slice(1).join('__')
      };
    }
    return {
      serverName: 'unknown',
      originalName: prefixedName
    };
  }

  /**
   * Update visible tools based on current role
   */
  private updateVisibleTools(): void {
    const previousVisibleTools = new Set(this.state.visibleTools.keys());
    this.state.visibleTools.clear();

    const currentRoleId = this.state.currentRole?.id || 'none';
    const allowedServers = this.state.currentRole?.allowedServers || [];
    this.logger.info(`🔍 Filtering tools for role: ${currentRoleId}, allowedServers: ${JSON.stringify(allowedServers)}`);

    let filtered = 0;
    for (const [name, toolInfo] of this.allTools) {
      const isVisible = this.isToolVisibleForRole(toolInfo);

      if (isVisible) {
        toolInfo.visible = true;
        toolInfo.visibilityReason = 'role_permitted';
        this.state.visibleTools.set(name, toolInfo);
      } else {
        toolInfo.visible = false;
        toolInfo.visibilityReason = 'role_restricted';
        filtered++;
      }
    }

    this.logger.info(`🔍 Filtered out ${filtered} tools, ${this.state.visibleTools.size} visible`);

    // Always add the get_agent_manifest tool
    this.addManifestTool();

    // Check if tools changed
    const currentVisibleTools = new Set(this.state.visibleTools.keys());
    const toolsChanged = !this.setsEqual(previousVisibleTools, currentVisibleTools);

    if (toolsChanged) {
      this.logger.info(`Visible tools updated: ${this.state.visibleTools.size} tools available`);
    }
  }

  /**
   * Check if a tool is visible for the current role
   */
  private isToolVisibleForRole(toolInfo: ToolInfo): boolean {
    if (!this.state.currentRole) {
      return true; // No role = show all
    }

    const role = this.state.currentRole;

    // Check server access first
    if (!this.isServerActiveForRole(toolInfo.sourceServer)) {
      return false;
    }

    // Check tool-level permissions
    return this.roleConfigManager.isToolAllowedForRole(
      role.id,
      toolInfo.prefixedName,
      toolInfo.sourceServer
    );
  }

  /**
   * Add the get_agent_manifest tool to visible tools
   */
  private addManifestTool(): void {
    const manifestTool: Tool = {
      name: 'get_agent_manifest',
      description: 'Switch to a specific role and get the system instruction and available tools for that role. ' +
        'Use this tool to change your operational context and capabilities.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          role_id: {
            type: 'string',
            description: 'The role ID to switch to. Use "list" to see available roles.'
          },
          includeToolDescriptions: {
            type: 'boolean',
            description: 'Whether to include full tool descriptions in the response',
            default: true
          }
        },
        required: ['role_id']
      }
    };

    const toolInfo: ToolInfo = {
      tool: manifestTool,
      sourceServer: 'aegis-router',
      prefixedName: 'get_agent_manifest',
      visible: true,
      visibilityReason: 'system_tool'
    };

    this.state.visibleTools.set('get_agent_manifest', toolInfo);
  }

  /**
   * Compare two sets for equality
   */
  private setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  // ============================================================================
  // get_agent_manifest - Role Switching Implementation
  // ============================================================================

  /**
   * Execute get_agent_manifest - the core role switching function
   *
   * This is the key function that:
   * 1. Fetches remote instruction (SKILL.md) from backend if configured
   * 2. Combines persona + skill instruction for the final system prompt
   * 3. Updates internal state to activate needed sub-servers
   * 4. Sends tools/list_changed notification to clients
   *
   * Flow for agent with remote skill:
   * 1. Client requests role switch
   * 2. AEGIS fetches SKILL.md from backend server via prompts/get
   * 3. AEGIS combines its persona definition with the skill instruction
   * 4. AEGIS sends tools/list_changed to client
   * 5. Client receives combined instruction + available tools
   */
  async getAgentManifest(options: GetAgentManifestOptions): Promise<AgentManifest> {
    const { role: roleId, includeToolDescriptions = true } = options;

    this.logger.info(`🔄 Role switch requested: ${roleId}`);

    // Validate role exists
    const role = this.state.availableRoles.get(roleId);
    if (!role) {
      const availableRoles = Array.from(this.state.availableRoles.keys());
      throw new Error(
        `Role '${roleId}' not found. Available roles: ${availableRoles.join(', ')}`
      );
    }

    // Track previous state for notifications
    const previousRole = this.state.currentRole;
    const previousTools = new Set(this.state.visibleTools.keys());

    // If role has remote instruction, fetch it now
    // This implements the "ask backend for SKILL.md" step
    if (this.roleConfigManager.hasRemoteInstruction(roleId)) {
      this.logger.info(`📡 Fetching remote instruction for role: ${roleId}`);
      const updatedInstruction = await this.roleConfigManager.refreshRoleInstruction(roleId);

      if (updatedInstruction) {
        // Update the role in state with the refreshed instruction
        role.systemInstruction = updatedInstruction;
        this.state.availableRoles.set(roleId, role);
        this.logger.info(`✅ Remote instruction loaded for role: ${roleId}`);
      }
    }

    // Update current role
    this.state.currentRole = role;
    this.state.metadata.lastRoleSwitch = new Date();
    this.state.metadata.roleSwitchCount++;

    // Update server activation status
    for (const [serverName, serverInfo] of this.state.connectedServers) {
      serverInfo.activeForRole = this.isServerActiveForRole(serverName);
    }

    // Update visible tools based on new role
    this.updateVisibleTools();

    // Calculate added/removed tools
    const currentTools = new Set(this.state.visibleTools.keys());
    const addedTools = [...currentTools].filter(t => !previousTools.has(t));
    const removedTools = [...previousTools].filter(t => !currentTools.has(t));

    // Emit role switch event
    const switchEvent: RoleSwitchEvent = {
      type: 'role_switch',
      timestamp: new Date(),
      previousRole: previousRole?.id || null,
      newRole: role.id,
      addedTools,
      removedTools
    };
    this.emit('roleSwitch', switchEvent);

    // Send tools/list_changed notification to client
    if (addedTools.length > 0 || removedTools.length > 0) {
      await this.notifyToolsChanged();
    }

    // Build the manifest response
    const manifest = this.buildManifest(role, includeToolDescriptions);

    this.logger.info(`✅ Role activated: ${role.name}`, {
      toolCount: manifest.availableTools.length,
      serverCount: manifest.availableServers.length
    });

    return manifest;
  }

  /**
   * Build the agent manifest for a role
   */
  private buildManifest(role: Role, includeToolDescriptions: boolean): AgentManifest {
    const availableTools: ManifestTool[] = [];

    for (const [_, toolInfo] of this.state.visibleTools) {
      const manifestTool: ManifestTool = {
        name: toolInfo.prefixedName,
        source: toolInfo.sourceServer
      };

      if (includeToolDescriptions && toolInfo.tool.description) {
        manifestTool.description = toolInfo.tool.description;
      }

      availableTools.push(manifestTool);
    }

    // Get active servers
    const activeServers: string[] = [];
    for (const [serverName, serverInfo] of this.state.connectedServers) {
      if (serverInfo.activeForRole && serverInfo.connected) {
        activeServers.push(serverName);
      }
    }

    return {
      role: {
        id: role.id,
        name: role.name,
        description: role.description
      },
      systemInstruction: role.systemInstruction,
      availableTools,
      availableServers: activeServers,
      metadata: {
        generatedAt: new Date(),
        previousRole: undefined, // Set by caller if needed
        toolsChanged: true,
        toolCount: availableTools.length,
        serverCount: activeServers.length
      }
    };
  }

  /**
   * Notify client that tools list has changed
   */
  private async notifyToolsChanged(): Promise<void> {
    this.logger.info('📢 Sending tools/list_changed notification');

    // Emit event
    const event: ToolsChangedEvent = {
      type: 'tools_changed',
      timestamp: new Date(),
      role: this.state.currentRole?.id || 'none',
      reason: 'role_switch',
      toolCount: this.state.visibleTools.size
    };
    this.emit('toolsChanged', event);

    // Call the registered callback if available
    if (this.toolsChangedCallback) {
      try {
        await this.toolsChangedCallback();
      } catch (error) {
        this.logger.error('Failed to execute tools changed callback:', error);
      }
    }
  }

  /**
   * Set the callback for tools/list_changed notifications
   */
  setToolsChangedCallback(callback: () => Promise<void>): void {
    this.toolsChangedCallback = callback;
  }

  // ============================================================================
  // Request Routing
  // ============================================================================

  /**
   * Route a request through the router
   * Applies role-based access control before forwarding
   */
  async routeRequest(request: any): Promise<any> {
    const { method, params } = request;

    // Handle internal tools
    if (method === 'tools/call' && params?.name === 'get_agent_manifest') {
      return await this.handleGetAgentManifest(params.arguments || {});
    }

    // Handle tools/list - return filtered tools
    if (method === 'tools/list') {
      return this.getFilteredToolsList();
    }

    // Check tool access for tool calls
    if (method === 'tools/call' && params?.name) {
      this.checkToolAccess(params.name);

      // Handle skill filtering for agent-skills tools
      if (params.name === 'agent-skills__list_skills') {
        return await this.handleListSkillsWithFiltering(request);
      }
      if (params.name === 'agent-skills__get_skill') {
        return await this.handleGetSkillWithFiltering(request, params.arguments);
      }
    }

    // Forward to upstream
    return await this.stdioRouter.routeRequest(request);
  }

  /**
   * Handle list_skills with skill filtering for current agent
   */
  private async handleListSkillsWithFiltering(request: any): Promise<any> {
    // Forward to upstream first
    const response = await this.stdioRouter.routeRequest(request);

    // If no current role or not an agent, return unfiltered
    const currentRoleId = this.state.currentRole?.id;
    if (!currentRoleId || !this.roleConfigManager.isAgentRole(currentRoleId)) {
      return response;
    }

    // Get allowed skills for current agent
    const allowedSkills = this.roleConfigManager.getAllowedSkillsForAgent(currentRoleId);
    if (!allowedSkills) {
      // No filtering needed
      return response;
    }

    // Filter the skills in the response
    try {
      const result = response?.result;
      if (result?.content?.[0]?.text) {
        const skills = JSON.parse(result.content[0].text);
        if (Array.isArray(skills)) {
          const filteredSkills = skills.filter((skill: any) =>
            allowedSkills.includes(skill.name)
          );

          this.logger.debug(`Skill filtering applied`, {
            agent: currentRoleId,
            original: skills.length,
            filtered: filteredSkills.length,
            allowed: allowedSkills
          });

          // Return filtered response
          return {
            ...response,
            result: {
              ...result,
              content: [{
                type: 'text',
                text: JSON.stringify(filteredSkills, null, 2)
              }]
            }
          };
        }
      }
    } catch (error) {
      this.logger.warn('Failed to filter list_skills response:', error);
    }

    return response;
  }

  /**
   * Handle get_skill with skill access validation for current agent
   */
  private async handleGetSkillWithFiltering(request: any, args: any): Promise<any> {
    const skillName = args?.name;
    if (!skillName) {
      return await this.stdioRouter.routeRequest(request);
    }

    // If no current role or not an agent, allow all
    const currentRoleId = this.state.currentRole?.id;
    if (!currentRoleId || !this.roleConfigManager.isAgentRole(currentRoleId)) {
      return await this.stdioRouter.routeRequest(request);
    }

    // Check if skill is allowed
    if (!this.roleConfigManager.isSkillAllowedForAgent(currentRoleId, skillName)) {
      this.logger.warn(`Skill access denied`, {
        agent: currentRoleId,
        skill: skillName
      });

      return {
        result: {
          content: [{
            type: 'text',
            text: `Error: Skill '${skillName}' is not available for the current agent. ` +
                  `Use list_skills to see available skills.`
          }],
          isError: true
        }
      };
    }

    // Skill is allowed, forward the request
    return await this.stdioRouter.routeRequest(request);
  }

  /**
   * Handle get_agent_manifest tool call
   */
  private async handleGetAgentManifest(args: Record<string, any>): Promise<any> {
    try {
      const manifest = await this.getAgentManifest({
        role: args.role_id,
        includeToolDescriptions: args.includeToolDescriptions !== false
      });

      // Format as MCP tool result
      return {
        result: {
          content: [
            {
              type: 'text',
              text: manifest.systemInstruction
            },
            {
              type: 'text',
              text: `\n\n---\n\n## Available Tools (${manifest.availableTools.length})\n\n` +
                manifest.availableTools
                  .map(t => `- **${t.name}** (${t.source})${t.description ? `: ${t.description}` : ''}`)
                  .join('\n')
            }
          ],
          isError: false,
          metadata: {
            role: manifest.role,
            toolCount: manifest.metadata.toolCount,
            serverCount: manifest.metadata.serverCount,
            generatedAt: manifest.metadata.generatedAt.toISOString()
          }
        }
      };
    } catch (error) {
      return {
        result: {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        }
      };
    }
  }

  /**
   * Get the filtered tools list for the current role
   */
  private getFilteredToolsList(): any {
    const tools: Tool[] = [];

    // Always include get_agent_manifest (system tool)
    tools.push({
      name: 'get_agent_manifest',
      description: 'Switch to a specific role and get the system instruction and available tools for that role. Use "list" to see available roles.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          role_id: {
            type: 'string',
            description: 'The role ID to switch to. Use "list" to see available roles.'
          }
        },
        required: ['role_id']
      }
    });

    // Add visible tools for current role
    for (const [_, toolInfo] of this.state.visibleTools) {
      tools.push(toolInfo.tool);
    }

    return {
      result: {
        tools
      }
    };
  }

  /**
   * Check if a tool is accessible for the current role
   * Throws an error if access is denied
   */
  private checkToolAccess(toolName: string): void {
    // get_agent_manifest is always accessible
    if (toolName === 'get_agent_manifest') {
      return;
    }

    const toolInfo = this.state.visibleTools.get(toolName);

    if (!toolInfo) {
      const currentRole = this.state.currentRole?.id || 'none';
      throw new Error(
        `Tool '${toolName}' is not accessible for role '${currentRole}'. ` +
        `Use get_agent_manifest to switch roles or check available tools.`
      );
    }
  }

  // ============================================================================
  // Public Accessors
  // ============================================================================

  /**
   * Get current role
   */
  getCurrentRole(): Role | null {
    return this.state.currentRole;
  }

  /**
   * List available roles
   */
  listRoles(): ListRolesResult {
    return this.roleConfigManager.listRoles(
      { includeInactive: false },
      this.state.currentRole?.id
    );
  }

  /**
   * Get visible tools count
   */
  getVisibleToolsCount(): number {
    return this.state.visibleTools.size;
  }

  /**
   * Get connected servers
   */
  getConnectedServers(): Array<{ name: string; connected: boolean; activeForRole: boolean }> {
    return Array.from(this.state.connectedServers.values()).map(s => ({
      name: s.name,
      connected: s.connected,
      activeForRole: s.activeForRole
    }));
  }

  /**
   * Get router state metadata
   */
  getStateMetadata(): AegisRouterState['metadata'] {
    return { ...this.state.metadata };
  }

  /**
   * Get the underlying StdioRouter for direct access if needed
   */
  getStdioRouter(): StdioRouter {
    return this.stdioRouter;
  }

  /**
   * Reload role configuration
   */
  async reloadRoles(): Promise<void> {
    this.logger.info('Reloading role configuration...');

    await this.roleConfigManager.reload();

    // Update state
    this.state.availableRoles.clear();
    const allRoles = this.roleConfigManager.getAllRoles();
    for (const role of allRoles) {
      this.state.availableRoles.set(role.id, role);
    }

    // If current role no longer exists, reset to default
    if (this.state.currentRole && !this.state.availableRoles.has(this.state.currentRole.id)) {
      this.logger.warn(`Current role '${this.state.currentRole.id}' no longer exists, resetting to default`);
      this.state.currentRole = this.roleConfigManager.getDefaultRole() || null;
    }

    // Update visible tools
    this.updateVisibleTools();

    // Notify tools changed
    await this.notifyToolsChanged();

    this.logger.info('Role configuration reloaded');
  }

  /**
   * Route a tool call to the appropriate backend server
   * Convenience method for MCP server integration
   */
  async routeToolCall(toolName: string, args: Record<string, unknown>): Promise<any> {
    const request = {
      jsonrpc: '2.0' as const,
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    };

    const response = await this.routeRequest(request);
    return response?.result ?? response;
  }

  /**
   * Get the current router state for external access
   */
  getState(): {
    currentRole: string | null;
    systemInstruction: string | null;
    visibleToolsCount: number;
    connectedServersCount: number;
  } {
    return {
      currentRole: this.state.currentRole?.id ?? null,
      systemInstruction: this.state.currentRole?.systemInstruction ?? null,
      visibleToolsCount: this.state.visibleTools.size,
      connectedServersCount: this.state.connectedServers.size
    };
  }
}

// Export factory function
export function createAegisRouterCore(
  logger: Logger,
  options?: {
    rolesDir?: string;
    configFile?: string;
  }
): AegisRouterCore {
  return new AegisRouterCore(logger, options);
}
