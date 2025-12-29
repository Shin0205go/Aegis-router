// ============================================================================
// MCP-specific type definitions
// ============================================================================

import type { 
  JSONRPCRequest,
  JSONRPCResponse,
  CallToolRequest as MCPCallToolRequest,
  ReadResourceRequest as MCPReadResourceRequest,
  ListResourcesRequest,
  ListToolsRequest,
  Tool,
  Resource
} from '@modelcontextprotocol/sdk/types.js';

// Request parameter types
export interface ToolCallParams {
  name: string;
  arguments?: Record<string, any>; // Tool arguments are truly dynamic
}

export interface ResourceReadParams {
  uri: string;
  includeMetadata?: boolean;
}

export interface ResourceListParams {
  filter?: string;
  includeHidden?: boolean;
}

export interface ToolListParams {
  category?: string;
  includeDisabled?: boolean;
}

// Response types
export interface ToolsListResult {
  tools: Tool[];
}

export interface ResourcesListResult {
  resources: Resource[];
}

export interface ResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    data?: string; // base64 encoded
  }>;
}

export interface ToolCallResult {
  content: Array<{
    type: 'text' | 'image' | 'error' | 'data';
    text?: string;
    data?: string | Record<string, any>; // base64 for images, structured data for others
    mimeType?: string;
  }>;
  isError?: boolean;
  metadata?: {
    executionTime?: number;
    toolVersion?: string;
    [key: string]: any;
  };
}

// MCP Request/Response types with proper typing
export interface MCPRequest extends JSONRPCRequest {
  method: string;
  params?: MCPRequestParams;
}

export interface MCPRequestParams {
  _meta?: MCPMetadata;
  [key: string]: any; // Allow additional params for extensibility
}

export interface MCPMetadata {
  progressToken?: string | number;
  correlationId?: string;
  timestamp?: number;
  [key: string]: any;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: MCPResult;
  error?: MCPError;
}

export interface MCPResult {
  _meta?: MCPMetadata;
  [key: string]: any;
}

export interface MCPError {
  code: number;
  message: string;
  data?: {
    details?: string;
    stack?: string;
    cause?: string;
    [key: string]: any;
  };
}

// Typed request variants
export interface TypedToolCallRequest extends MCPRequest {
  method: 'tools/call';
  params: ToolCallParams;
}

export interface TypedResourceReadRequest extends MCPRequest {
  method: 'resources/read';
  params: ResourceReadParams;
}

export interface TypedResourceListRequest extends MCPRequest {
  method: 'resources/list';
  params?: ResourceListParams;
}

export interface TypedToolListRequest extends MCPRequest {
  method: 'tools/list';
  params?: ToolListParams;
}

// Request context type
export interface RequestContext {
  headers: Record<string, string | string[] | undefined>;
  sessionId: string;
  timestamp: number;
  agent?: string;
  purpose?: string;
}

// Upstream server response
export interface UpstreamResponse {
  result?: MCPResult;
  error?: MCPError;
}

// Circuit breaker state
export interface CircuitBreakerState {
  failures: number;
  lastFailure: Date;
  isOpen: boolean;
}

// System stats types
export interface SystemHealthStats {
  upstreamServices: number;
  openCircuits: number;
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
}

export interface CacheStats {
  hitRate: number;
  totalHits: number;
  totalMisses: number;
  size: number;
  maxSize: number;
  missRate: number;
  evictionRate: number;
  compressionRatio?: number;
}

export interface BatchJudgmentStats {
  totalBatches: number;
  averageBatchSize: number;
  processingTime: number;
  totalRequests: number;
  batchedRequests: number;
  averageResponseTime: number;
}

export interface QueueStatus {
  pending: number;
  processing: number;
  completed: number;
  waitingRequests: number;
  processingRequests: number;
  isProcessing: boolean;
  priorityDistribution: Record<string, number>;
}

export interface AnomalyStats {
  totalAnomalies: number;
  recentAnomalies: number;
  severity: Record<string, number>;
}

export interface AuditSystemStats {
  totalEntries: number;
  recentEntries: number;
  storageSize: number;
  oldestEntry?: Date;
  newestEntry?: Date;
}

export interface SystemPerformanceStats {
  audit: AuditSystemStats;
  cache: CacheStats;
  batchJudgment: BatchJudgmentStats;
  queueStatus: QueueStatus;
  anomalyStats: AnomalyStats;
  circuitBreaker: Record<string, CircuitBreakerState>;
  systemHealth: SystemHealthStats;
}

// Desktop config types
export interface DesktopConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}