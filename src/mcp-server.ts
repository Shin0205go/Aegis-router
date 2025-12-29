#!/usr/bin/env node
// ============================================================================
// AEGIS Router - MCP Server Entry Point
// stdio-based MCP server for Claude Desktop / Claude Code integration
// ============================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './utils/logger.js';
import { AegisRouterCore, createAegisRouterCore } from './router/aegis-router-core.js';

// Get the directory of this script (works with ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const logger = new Logger('info');

async function main() {
  logger.info('Starting AEGIS Router MCP Server...', { projectRoot: PROJECT_ROOT });

  // Create MCP Server
  const server = new Server(
    {
      name: 'aegis-router',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    }
  );

  // Initialize Router Core with explicit paths
  const routerCore = createAegisRouterCore(logger, {
    rolesDir: join(PROJECT_ROOT, 'roles'),
  });

  // Load server configuration from environment or default config file
  const configPath = process.env.AEGIS_CONFIG_PATH || join(PROJECT_ROOT, 'config.json');
  logger.info(`Loading backend servers from: ${configPath}`);

  try {
    const fs = await import('fs/promises');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        logger.info(`Adding backend server: ${name}`);
        await routerCore.addServer(name, serverConfig as any);
      }
      logger.info(`Loaded ${Object.keys(config.mcpServers).length} backend server configurations`);

      // Start all backend servers immediately (eager loading)
      logger.info('Starting all backend servers...');
      await routerCore.startServers();
      logger.info('All backend servers started');
    }
  } catch (error) {
    logger.warn(`Failed to load config from ${configPath}:`, error);
  }

  // Initialize router
  await routerCore.initialize();

  // List Tools Handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.info('ListTools request received');

    // Add the get_agent_manifest tool (always available)
    const manifestTool = {
      name: 'get_agent_manifest',
      description: 'Switch agent role and get the manifest with available tools and system instruction',
      inputSchema: {
        type: 'object' as const,
        properties: {
          role_id: {
            type: 'string',
            description: 'The role ID to switch to. Use "list" to see available roles.',
          },
        },
        required: ['role_id'],
      },
    };

    // Get tools from backend servers via router
    let backendTools: any[] = [];
    try {
      const response = await routerCore.routeRequest({ method: 'tools/list' });
      backendTools = response?.result?.tools || response?.tools || [];
      logger.info(`Got ${backendTools.length} tools from backend servers`);
    } catch (error) {
      logger.warn('Failed to get tools from backend servers:', error);
    }

    const allTools = [manifestTool, ...backendTools];
    logger.info(`Returning ${allTools.length} total tools`);

    return {
      tools: allTools,
    };
  });

  // Call Tool Handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'get_agent_manifest') {
      const roleId = (args as any)?.role_id;

      if (roleId === 'list') {
        const roles = routerCore.listRoles();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(roles, null, 2),
            },
          ],
        };
      }

      try {
        // Start required servers for this role (lazy loading)
        logger.info(`Switching to role: ${roleId}, starting required servers...`);
        await routerCore.startServersForRole(roleId);

        // Notify client that tools have changed
        try {
          await server.sendToolListChanged();
          logger.info('Sent tools/list_changed notification');
        } catch (notifyError) {
          logger.warn('Failed to send tools/list_changed notification:', notifyError);
        }

        const manifest = await routerCore.getAgentManifest({ role: roleId });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(manifest, null, 2),
            },
          ],
        };
      } catch (error: any) {
        logger.error(`Failed to switch to role ${roleId}:`, error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Route to backend server
    try {
      const result = await routerCore.routeToolCall(name, args as Record<string, unknown>);
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // List Prompts Handler
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: 'current_role',
          description: 'Get information about the current active role',
        },
      ],
    };
  });

  // Get Prompt Handler
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === 'current_role') {
      const state = routerCore.getState();
      return {
        description: 'Current role information',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Current Role: ${state.currentRole || 'default'}\n\nSystem Instruction:\n${state.systemInstruction || 'No instruction set'}`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('AEGIS Router MCP Server running on stdio');
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
