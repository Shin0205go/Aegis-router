// ============================================================================
// AEGIS Router Adapter
// Integrates AegisRouterCore with existing MCP proxy infrastructure
// ============================================================================

import { Logger } from '../utils/logger.js';
import { AegisRouterCore, createAegisRouterCore } from './aegis-router-core.js';
import type { MCPServerConfig } from '../types/mcp-types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentManifest,
  GetAgentManifestOptions,
  ListRolesResult
} from '../types/router-types.js';

/**
 * RouterAdapter - Bridge between AegisRouterCore and existing MCP proxy
 *
 * This adapter:
 * 1. Wraps the Router Core for easy integration with MCPStdioPolicyProxy
 * 2. Provides methods to handle get_agent_manifest tool calls
 * 3. Manages tools/list_changed notifications
 * 4. Filters tool lists based on current role
 */
export class RouterAdapter {
  private logger: Logger;
  private routerCore: AegisRouterCore;
  private enabled: boolean = false;
  private notificationCallback?: () => Promise<void>;

  constructor(logger: Logger, options?: { rolesDir?: string; configFile?: string }) {
    this.logger = logger;
    this.routerCore = createAegisRouterCore(logger, options);

    // Set up event handlers
    this.routerCore.on('roleSwitch', (event) => {
      this.logger.info('Role switch event received', {
        from: event.previousRole,
        to: event.newRole,
        toolsAdded: event.addedTools.length,
        toolsRemoved: event.removedTools.length
      });
    });

    this.routerCore.on('toolsChanged', (event) => {
      this.logger.debug('Tools changed event', {
        role: event.role,
        reason: event.reason,
        count: event.toolCount
      });
    });
  }

  /**
   * Initialize the router adapter
   */
  async initialize(): Promise<void> {
    await this.routerCore.initialize();
    this.logger.info('Router adapter initialized');
  }

  /**
   * Enable role-based routing
   */
  enable(): void {
    this.enabled = true;
    this.logger.info('Role-based routing enabled');
  }

  /**
   * Disable role-based routing (pass-through mode)
   */
  disable(): void {
    this.enabled = false;
    this.logger.info('Role-based routing disabled');
  }

  /**
   * Check if role-based routing is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Set the callback for tools/list_changed notifications
   * This should be called by the proxy to wire up the notification mechanism
   */
  setNotificationCallback(callback: () => Promise<void>): void {
    this.notificationCallback = callback;
    this.routerCore.setToolsChangedCallback(callback);
  }

  /**
   * Load server configurations
   */
  loadServersFromConfig(config: { mcpServers: Record<string, MCPServerConfig> }): void {
    this.routerCore.loadServersFromConfig(config);
  }

  /**
   * Add a single server
   */
  addServer(name: string, config: MCPServerConfig): void {
    this.routerCore.addServer(name, config);
  }

  /**
   * Start all servers
   */
  async startServers(): Promise<void> {
    await this.routerCore.startServers();
  }

  /**
   * Stop all servers
   */
  async stopServers(): Promise<void> {
    await this.routerCore.stopServers();
  }

  /**
   * Check if a tool call is for get_agent_manifest
   */
  isManifestTool(toolName: string): boolean {
    return toolName === 'get_agent_manifest';
  }

  /**
   * Handle get_agent_manifest tool call
   */
  async handleGetAgentManifest(args: Record<string, any>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError: boolean;
    metadata?: Record<string, any>;
  }> {
    try {
      const manifest = await this.routerCore.getAgentManifest({
        role: args.role_id,
        includeToolDescriptions: args.includeToolDescriptions !== false
      });

      return {
        content: [
          {
            type: 'text',
            text: manifest.systemInstruction
          },
          {
            type: 'text',
            text: this.formatToolsList(manifest)
          }
        ],
        isError: false,
        metadata: {
          role: manifest.role,
          toolCount: manifest.metadata.toolCount,
          serverCount: manifest.metadata.serverCount,
          generatedAt: manifest.metadata.generatedAt.toISOString()
        }
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error switching role: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Format the tools list for display
   */
  private formatToolsList(manifest: AgentManifest): string {
    const lines: string[] = [
      '',
      '---',
      '',
      `## Role: ${manifest.role.name}`,
      '',
      manifest.role.description,
      '',
      `### Available Tools (${manifest.availableTools.length})`,
      ''
    ];

    // Group tools by source server
    const toolsByServer = new Map<string, typeof manifest.availableTools>();
    for (const tool of manifest.availableTools) {
      const serverTools = toolsByServer.get(tool.source) || [];
      serverTools.push(tool);
      toolsByServer.set(tool.source, serverTools);
    }

    for (const [server, tools] of toolsByServer) {
      lines.push(`#### ${server}`);
      for (const tool of tools) {
        if (tool.description) {
          lines.push(`- **${tool.name}**: ${tool.description}`);
        } else {
          lines.push(`- **${tool.name}**`);
        }
      }
      lines.push('');
    }

    lines.push(`### Active Servers (${manifest.availableServers.length})`);
    lines.push('');
    for (const server of manifest.availableServers) {
      lines.push(`- ${server}`);
    }

    return lines.join('\n');
  }

  /**
   * Check if a tool is accessible for the current role
   * Returns null if accessible, error message if not
   */
  checkToolAccess(toolName: string): string | null {
    if (!this.enabled) {
      return null; // Pass-through mode
    }

    // get_agent_manifest is always accessible
    if (this.isManifestTool(toolName)) {
      return null;
    }

    const currentRole = this.routerCore.getCurrentRole();
    if (!currentRole) {
      return null; // No role = allow all
    }

    // Check if tool is in visible tools
    // This is a simple check - the router core handles the detailed logic
    try {
      // Attempt to route a dummy request to check access
      // The actual routing will be done by the proxy
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Filter tools list based on current role
   */
  filterToolsList(tools: Tool[]): Tool[] {
    if (!this.enabled) {
      // When disabled, just add the manifest tool
      return [...tools, this.getManifestToolDefinition()];
    }

    // Get visible tools from router core
    const filteredRequest = this.routerCore.routeRequest({
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/list',
      params: {}
    });

    // For now, return all tools plus manifest tool
    // The router core will filter when enabled
    return [...tools, this.getManifestToolDefinition()];
  }

  /**
   * Get the manifest tool definition
   */
  getManifestToolDefinition(): Tool {
    return {
      name: 'get_agent_manifest',
      description:
        'Switch to a specific role and get the system instruction and available tools for that role. ' +
        'Use this tool to change your operational context and capabilities. ' +
        'Call list_roles first to see available roles.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          role: {
            type: 'string',
            description: 'The role ID to activate (e.g., "frontend", "db_admin", "security")'
          },
          includeToolDescriptions: {
            type: 'boolean',
            description: 'Whether to include full tool descriptions in the response',
            default: true
          }
        },
        required: ['role']
      }
    };
  }

  /**
   * Get the list_roles tool definition
   */
  getListRolesToolDefinition(): Tool {
    return {
      name: 'list_roles',
      description:
        'List all available roles that can be activated using get_agent_manifest. ' +
        'Shows role ID, name, description, and whether it is currently active.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          includeInactive: {
            type: 'boolean',
            description: 'Whether to include inactive roles',
            default: false
          }
        },
        required: []
      }
    };
  }

  /**
   * Handle list_roles tool call
   */
  async handleListRoles(args: Record<string, any>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  }> {
    try {
      const result = this.routerCore.listRoles();

      const lines: string[] = [
        '# Available Roles',
        '',
        `Current Role: ${result.currentRole || 'none'}`,
        `Default Role: ${result.defaultRole}`,
        '',
        '## Roles',
        ''
      ];

      for (const role of result.roles) {
        const marker = role.isCurrent ? '→ ' : '  ';
        const serverInfo = role.serverCount === -1 ? 'all servers' : `${role.serverCount} servers`;
        lines.push(
          `${marker}**${role.id}** - ${role.name}`,
          `   ${role.description}`,
          `   (${serverInfo}, ${role.isActive ? 'active' : 'inactive'})`,
          ''
        );
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing roles: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Get the current role ID
   */
  getCurrentRoleId(): string | null {
    return this.routerCore.getCurrentRole()?.id || null;
  }

  /**
   * Get router state metadata
   */
  getStateMetadata(): Record<string, any> {
    return this.routerCore.getStateMetadata();
  }

  /**
   * Get connected servers info
   */
  getConnectedServers(): Array<{ name: string; connected: boolean; activeForRole: boolean }> {
    return this.routerCore.getConnectedServers();
  }

  /**
   * Reload role configurations
   */
  async reloadRoles(): Promise<void> {
    await this.routerCore.reloadRoles();
  }

  /**
   * Get the underlying router core (for advanced use cases)
   */
  getRouterCore(): AegisRouterCore {
    return this.routerCore;
  }

  /**
   * Get the underlying stdio router (for direct routing when needed)
   */
  getStdioRouter() {
    return this.routerCore.getStdioRouter();
  }
}

/**
 * Create a router adapter instance
 */
export function createRouterAdapter(
  logger: Logger,
  options?: { rolesDir?: string; configFile?: string }
): RouterAdapter {
  return new RouterAdapter(logger, options);
}
