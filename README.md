# AEGIS Router

MCP Proxy with Role-based Routing and Virtual Tool Table.

## Features

- **Router Core** - Central routing system for multi-server MCP management
- **Virtual Tool Table** - Dynamic tool aggregation and filtering based on roles
- **Role/Agent Management** - `get_agent_manifest` tool for role switching
- **Persona + Skills Architecture** - Combine agent personas with backend skill servers
- **Remote Instruction Fetching** - Fetch prompts/instructions from backend MCP servers
- **Connection Pooling** - Efficient management of upstream MCP server connections

## Architecture

```
┌─────────────────────────────────────────────┐
│              MCP Client                     │
│         (Claude Desktop, etc.)              │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│            AEGIS Router                     │
│  ┌─────────────────────────────────────────┐│
│  │         Router Core (司令塔)             ││
│  │  - Role-based tool filtering            ││
│  │  - get_agent_manifest tool              ││
│  │  - tools/list_changed notifications     ││
│  └─────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────┐│
│  │         Connection Manager              ││
│  │  - Upstream server pooling              ││
│  │  - stdio/HTTP transport                 ││
│  └─────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────┐│
│  │       Virtual Tool Table                ││
│  │  - Tool aggregation from backends       ││
│  │  - Prefix-based namespacing             ││
│  └─────────────────────────────────────────┘│
└─────────────────┬───────────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│  Backend MCP  │   │  Backend MCP  │
│   Server A    │   │   Server B    │
└───────────────┘   └───────────────┘
```

## Installation

```bash
npm install
npm run build
```

## Usage

### Basic Setup

```typescript
import { AegisRouterCore, createAegisRouterCore } from 'aegis-router';
import { createLogger } from 'aegis-router';

const logger = createLogger({ service: 'my-app' });
const router = createAegisRouterCore(logger);

// Add backend servers
await router.addServer('filesystem', {
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/path/to/files']
});

// Initialize
await router.initialize();

// Get available tools for current role
const tools = router.getAvailableTools();
```

### Role Configuration

Create `roles/aegis-roles.json`:

```json
{
  "version": "1.0.0",
  "defaultRole": "default",
  "roles": [
    {
      "id": "default",
      "name": "Default Role",
      "description": "Full access to all servers",
      "allowedServers": ["*"],
      "systemInstruction": "You have full access to all tools."
    }
  ]
}
```

### Persona + Skills Architecture

Create `roles/aegis-agents.json`:

```json
{
  "version": "1.0.0",
  "agents": [
    {
      "id": "reviewer",
      "displayName": "Senior Reviewer",
      "description": "Code review specialist",
      "persona": "You are a strict but fair senior engineer...",
      "sourceBackend": "code-review-server",
      "includeSkillInstruction": true,
      "skillPromptName": "default_instruction"
    }
  ]
}
```

## License

MIT
