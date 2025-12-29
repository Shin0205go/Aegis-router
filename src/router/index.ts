// ============================================================================
// AEGIS Router Module
// Exports for role-based routing and tool management
// ============================================================================

// Core router
export { AegisRouterCore, createAegisRouterCore } from './aegis-router-core.js';

// Role configuration
export { RoleConfigManager, createRoleConfigManager } from './role-config.js';

// Remote prompt fetching
export {
  RemotePromptFetcher,
  createRemotePromptFetcher,
  type PromptRouter,
  type FetchPromptResult
} from './remote-prompt-fetcher.js';

// Router adapter for proxy integration
export { RouterAdapter, createRouterAdapter } from './router-adapter.js';

// Types are exported from ../types/index.js to avoid duplicate exports
