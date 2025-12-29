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
import { spawn } from 'child_process';
import { Logger } from './utils/logger.js';
import { AegisRouterCore, createAegisRouterCore } from './router/aegis-router-core.js';

// Path to aegis-cli for sub-agent spawning
const AEGIS_CLI_PATH = process.env.AEGIS_CLI_PATH ||
  '/Users/shingo/Develop/aegis-cli/dist/index.js';

// Get the directory of this script (works with ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const logger = new Logger('info');

/**
 * Spawn a sub-agent with a specific role
 * Streams progress to logger for visibility
 */
async function spawnSubAgent(
  role: string,
  task: string,
  model?: string
): Promise<{
  success: boolean;
  role: string;
  result?: string;
  error?: string;
  toolsUsed?: string[];
  usage?: { inputTokens: number; outputTokens: number; costUSD: number };
  streamedOutput?: string;
}> {
  return new Promise((resolve, reject) => {
    // Don't use --json so we can stream output
    const args = ['--role', role];
    if (model) {
      args.push('--model', model);
    }
    args.push(task);

    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`🤖 Sub-Agent [${role}] Starting...`);
    logger.info(`📝 Task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`);
    logger.info(`${'='.repeat(60)}\n`);

    const child = spawn('node', [AEGIS_CLI_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const toolsUsed: string[] = [];

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      // Stream output with prefix
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          // Check for tool usage
          const toolMatch = line.match(/⚙️\s+Using:\s+(\S+)/);
          if (toolMatch) {
            toolsUsed.push(toolMatch[1]);
          }
          logger.info(`[${role}] ${line}`);
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log errors/warnings from sub-agent
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim() && !line.includes('[aegis]')) {
          logger.info(`[${role}:err] ${line.trim()}`);
        }
      }
    });

    child.on('close', (code) => {
      logger.info(`\n${'='.repeat(60)}`);
      logger.info(`🏁 Sub-Agent [${role}] Completed (exit: ${code})`);
      logger.info(`${'='.repeat(60)}\n`);

      // Extract the actual response (after "Claude: ")
      const claudeMatch = stdout.match(/Claude:\s*([\s\S]*?)(?:\n\s*📊|$)/);
      const result = claudeMatch ? claudeMatch[1].trim() : stdout.trim();

      // Extract usage info
      const usageMatch = stdout.match(/Tokens:\s*(\d+)\s*in\s*\/\s*(\d+)\s*out.*\$([0-9.]+)/);
      const usage = usageMatch ? {
        inputTokens: parseInt(usageMatch[1]),
        outputTokens: parseInt(usageMatch[2]),
        costUSD: parseFloat(usageMatch[3])
      } : undefined;

      resolve({
        success: code === 0,
        role,
        result,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
        usage,
        streamedOutput: stdout
      });
    });

    child.on('error', (error) => {
      reject(error);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      child.kill();
      reject(new Error('Sub-agent timeout (5 minutes)'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Spawn an interactive sub-agent in a new terminal window (macOS)
 * Uses AppleScript to open Terminal, start aegis-cli, switch role, and send initial prompt
 */
async function spawnInteractiveSubAgent(
  role: string,
  initialPrompt: string,
  model?: string
): Promise<void> {
  const { exec } = await import('child_process');
  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');

  // Create AppleScript file (easier to handle escaping)
  const tmpDir = os.tmpdir();
  const scriptPath = path.join(tmpDir, `aegis-subagent-${Date.now()}.scpt`);

  // Escape strings for AppleScript
  const escapeForAppleScript = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedRole = escapeForAppleScript(role);
  const escapedPrompt = escapeForAppleScript(initialPrompt);
  const escapedCliPath = escapeForAppleScript(AEGIS_CLI_PATH);

  // Build a prompt that instructs Claude to first switch roles, then execute the task
  const fullPrompt = `まず get_agent_manifest を使って "${role}" ロールに切り替えてください。その後、以下のタスクを実行してください：

${initialPrompt}`;

  // Escape for keystroke (different escaping)
  const keystrokePrompt = fullPrompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const appleScript = `
tell application "Terminal"
    activate

    -- Open new window with aegis-cli
    do script "clear && echo '🤖 AEGIS Sub-Agent [${escapedRole}]' && echo '' && node \\"${escapedCliPath}\\""

    -- Wait for CLI to start
    delay 6

    -- Send the prompt as keystrokes
    tell application "System Events"
        tell process "Terminal"
            keystroke "${keystrokePrompt}"
            keystroke return
        end tell
    end tell
end tell
`;

  await fs.writeFile(scriptPath, appleScript);

  return new Promise((resolve, reject) => {
    exec(`osascript "${scriptPath}"`, (error, stdout, stderr) => {
      // Clean up
      fs.unlink(scriptPath).catch(() => {});

      if (error) {
        logger.error('Failed to open Terminal window:', error);
        reject(error);
      } else {
        logger.info(`Opened interactive sub-agent window for role: ${role}`);
        resolve();
      }
    });
  });
}

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
    }
  } catch (error) {
    logger.warn(`Failed to load config from ${configPath}:`, error);
  }

  // Initialize router FIRST (sets default role for filtering)
  await routerCore.initialize();

  // Start all backend servers AFTER role is set (so filtering works)
  logger.info('Starting all backend servers...');
  await routerCore.startServers();
  logger.info('All backend servers started');

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

    // Add the spawn_sub_agent tool for orchestrating sub-agents
    const spawnSubAgentTool = {
      name: 'spawn_sub_agent',
      description: 'Spawn a sub-agent with a specific role to handle a task. The sub-agent runs independently with its own tools and capabilities based on the role. Use this to delegate specialized tasks to role-specific agents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          role: {
            type: 'string',
            description: 'The role for the sub-agent (e.g., "mentor", "frontend", "guest")',
          },
          task: {
            type: 'string',
            description: 'The task/prompt to send to the sub-agent',
          },
          model: {
            type: 'string',
            description: 'Optional: Model to use (default: claude-3-5-haiku-20241022)',
          },
          interactive: {
            type: 'boolean',
            description: 'If true, opens a new terminal window for interactive session with the sub-agent (macOS only)',
          },
        },
        required: ['role', 'task'],
      },
    };

    // Get tools from backend servers via router
    let backendTools: any[] = [];
    try {
      const response = await routerCore.routeRequest({ method: 'tools/list' });
      const rawTools = response?.result?.tools || response?.tools || [];
      // Filter out get_agent_manifest from backend to avoid duplicates
      backendTools = rawTools.filter((t: any) => t.name !== 'get_agent_manifest');
      logger.info(`Got ${backendTools.length} tools from backend servers`);
    } catch (error) {
      logger.warn('Failed to get tools from backend servers:', error);
    }

    const allTools = [manifestTool, spawnSubAgentTool, ...backendTools];
    logger.info(`Returning ${allTools.length} total tools`);

    return {
      tools: allTools,
    };
  });

  // Call Tool Handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    logger.info(`📥 Tool call received: "${name}"`);

    // Handle spawn_sub_agent
    if (name === 'spawn_sub_agent' || name.endsWith('__spawn_sub_agent')) {
      logger.info(`🚀 Spawning sub-agent`);
      const { role, task, model, interactive } = args as {
        role: string;
        task: string;
        model?: string;
        interactive?: boolean;
      };

      if (!role || !task) {
        return {
          content: [{ type: 'text', text: 'Error: role and task are required' }],
          isError: true,
        };
      }

      try {
        if (interactive) {
          // Open in new terminal window
          await spawnInteractiveSubAgent(role, task, model);
          return {
            content: [{
              type: 'text',
              text: `Opened interactive sub-agent in new terminal window with role: ${role}`,
            }],
          };
        } else {
          const result = await spawnSubAgent(role, task, model);

          // Format output to show sub-agent activity
          let output = `\n${'═'.repeat(50)}\n`;
          output += `🤖 Sub-Agent [${result.role}] Result\n`;
          output += `${'═'.repeat(50)}\n\n`;

          if (result.toolsUsed && result.toolsUsed.length > 0) {
            output += `🔧 Tools Used: ${result.toolsUsed.join(', ')}\n\n`;
          }

          output += result.result || '(no output)';

          if (result.usage) {
            output += `\n\n📊 Usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out | $${result.usage.costUSD.toFixed(4)}`;
          }

          output += `\n${'═'.repeat(50)}\n`;

          return {
            content: [{ type: 'text', text: output }],
          };
        }
      } catch (error: any) {
        logger.error('Sub-agent spawn failed:', error);
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }

    // Handle get_agent_manifest (check both exact match and suffix)
    if (name === 'get_agent_manifest' || name.endsWith('__get_agent_manifest')) {
      logger.info(`✅ Handling get_agent_manifest (matched: ${name})`);
      logger.info(`📋 Arguments: ${JSON.stringify(args)}`);
      const roleId = (args as any)?.role_id;
      logger.info(`🎭 Role ID: ${roleId}`);

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

        // Get manifest (this updates currentRole and visibleTools)
        const manifest = await routerCore.getAgentManifest({ role: roleId });

        // Notify client that tools have changed AFTER role is updated
        try {
          await server.sendToolListChanged();
          logger.info('Sent tools/list_changed notification');
        } catch (notifyError) {
          logger.warn('Failed to send tools/list_changed notification:', notifyError);
        }
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
