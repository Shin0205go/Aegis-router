// ============================================================================
// AEGIS - MCP stdio ルーター
// 複数の上流MCPサーバーをstdio経由で管理し、ルーティングする
// ============================================================================

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { TIMEOUTS } from '../constants/index.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../types/mcp-types.js';

// MCPServerConfig is exported from types/mcp-types.js

export interface UpstreamServerInfo {
  name: string;
  config: MCPServerConfig;
  process?: ChildProcess;
  connected: boolean;
  buffer: string;
}

export class StdioRouter extends EventEmitter {
  private upstreamServers = new Map<string, UpstreamServerInfo>();
  private logger: Logger;
  private currentRequestId?: string | number;
  private pendingRequests = new Map<string | number, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    targetServer?: string;
  }>();

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  /**
   * Claude Desktop設定形式のサーバーを追加
   */
  addServerFromConfig(name: string, config: MCPServerConfig): void {
    this.upstreamServers.set(name, {
      name,
      config,
      connected: false,
      buffer: ''
    });
    this.logger.info(`Configured upstream server: ${name}`, { 
      command: config.command,
      args: config.args 
    });
  }

  /**
   * claude_desktop_config.jsonの内容から複数サーバーを設定
   */
  loadServersFromDesktopConfig(config: { mcpServers: Record<string, MCPServerConfig> }): void {
    Object.entries(config.mcpServers).forEach(([name, serverConfig]) => {
      // AEGISプロキシ自身は除外
      if (name !== 'aegis-proxy' && name !== 'aegis') {
        this.addServerFromConfig(name, serverConfig);
      }
    });
  }

  /**
   * 設定されたサーバーを起動
   */
  async startServers(): Promise<void> {
    const startPromises = Array.from(this.upstreamServers.entries()).map(
      async ([name, server]) => {
        try {
          await this.startServer(name, server);
        } catch (error) {
          this.logger.error(`Failed to start server ${name}:`, error);
        }
      }
    );

    await Promise.all(startPromises);
  }

  private async startServer(name: string, server: UpstreamServerInfo): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // 環境変数の展開
        const expandedEnv: Record<string, string> = {};
        if (server.config.env) {
          for (const [key, value] of Object.entries(server.config.env)) {
            if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
              const varName = value.slice(2, -1);
              expandedEnv[key] = process.env[varName] || '';
            } else {
              expandedEnv[key] = value as string;
            }
          }
        }
        
        const env = {
          ...process.env,
          ...expandedEnv
        };

        this.logger.info(`🚀 Starting upstream server ${name}`);
        this.logger.debug(`  Command: ${server.config.command}`);
        this.logger.debug(`  Args: ${(server.config.args || []).join(' ')}`);
        this.logger.debug(`  Env: ${JSON.stringify(expandedEnv)}`);
        
        const proc = spawn(server.config.command, server.config.args || [], {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        server.process = proc;
        // connectedはサーバーが実際に応答するまでfalseのまま
        server.connected = false;

        // stdout処理
        proc.stdout?.on('data', (data) => {
          const text = data.toString();
          server.buffer += text;
          
          // 初回データ受信をログ（ただしまだconnectedにはしない）
          if (!server.connected) {
            this.logger.debug(`[${name}] First stdout data received: ${text.substring(0, 200)}`);
            
            // history-mcpの場合は特別にログ
            if (name === 'history-mcp') {
              this.logger.info(`🔍 HISTORY-MCP: First response received (waiting for initialization)`);
            }
          }
          
          // JSON-RPCメッセージを探す
          const lines = server.buffer.split('\n');
          server.buffer = lines.pop() || '';
          
          lines.forEach(line => {
            if (line.trim()) {
              try {
                const message = JSON.parse(line);
                this.handleUpstreamMessage(name, message);
              } catch (error) {
                // JSON以外の出力は無視
                this.logger.debug(`Non-JSON output from ${name}: ${line}`);
              }
            }
          });
        });

        // stderr処理（MCPサーバーの通常のログ出力）
        proc.stderr?.on('data', (data) => {
          const message = data.toString().trim();
          
          // 初期化メッセージをログ（ただし接続状態は変更しない）
          if (!server.connected && (
            message.toLowerCase().includes('running on stdio') ||
            message.toLowerCase().includes('server running') ||
            message.toLowerCase().includes('server started') ||
            message.toLowerCase().includes('listening') ||
            message.toLowerCase().includes('mcp server started') // history-mcp用
          )) {
            this.logger.info(`📝 ${name} startup message detected: ${message}`);
            this.logger.info(`⏳ Waiting for MCP initialization handshake...`);
          }
          
          // エラーレベルのメッセージのみ警告として記録
          if (message.toLowerCase().includes('error') || message.toLowerCase().includes('fail')) {
            this.logger.warn(`[${name}] ${message}`);
          } else {
            // 通常のログはデバッグレベルで記録
            this.logger.debug(`[${name}] ${message}`);
          }
        });

        // プロセス終了処理
        proc.on('close', (code) => {
          this.logger.info(`Server ${name} exited with code ${code}`);
          server.connected = false;
          server.process = undefined;
          
          // 自動再起動
          setTimeout(() => {
            if (this.upstreamServers.has(name)) {
              this.startServer(name, server).catch(err => {
                this.logger.error(`Failed to restart ${name}:`, err);
              });
            }
          }, TIMEOUTS.CONTEXT_ENRICHMENT);
        });

        proc.on('error', (error) => {
          this.logger.error(`Failed to start ${name}:`, error);
          this.logger.error(`Command was: ${server.config.command} ${(server.config.args || []).join(' ')}`);
          server.connected = false;
          reject(error);
        });

        // MCPサーバーの初期化を待つ
        let initTimeout: NodeJS.Timeout;
        const waitForInit = () => {
          return new Promise<void>((waitResolve, waitReject) => {
            let initialized = false;
            
            // MCP標準の初期化ハンドシェイク
            const sendInitializeRequest = () => {
              if (initialized || !server.process || !server.process.stdin) {
                this.logger.debug(`Skipping initialize request for ${name}: initialized=${initialized}, process=${!!server.process}, stdin=${!!server.process?.stdin}`);
                return;
              }
              
              const initRequest = {
                jsonrpc: '2.0',
                id: 0, // 初期化リクエストは常にID 0
                method: 'initialize',
                params: {
                  protocolVersion: LATEST_PROTOCOL_VERSION,
                  clientInfo: {
                    name: 'AEGIS Policy Enforcement Proxy',
                    version: '1.0.0'
                  },
                  capabilities: {} // 空のcapabilitiesオブジェクトを追加
                }
              };
              
              this.logger.info(`Sending initialize request to ${name}`);
              
              // 初期化リクエストをpendingRequestsに登録（resolve/rejectはダミー）
              this.pendingRequests.set(initRequest.id, { 
                resolve: () => {}, 
                reject: () => {},
                targetServer: name 
              });
              
              // 初期化レスポンスハンドラー
              const initResponseHandler = (message: any) => {
                if (message.id === initRequest.id) {
                  // pendingRequestsからの削除はレスポンス処理後に行う
                  
                  if (message.result) {
                    this.logger.info(`✅ ${name} initialized successfully`, {
                      protocolVersion: message.result.protocolVersion,
                      serverInfo: message.result.serverInfo
                    });
                    
                    // initialized通知を送信
                    const initializedNotification = {
                      jsonrpc: '2.0',
                      method: 'initialized',
                      params: {}
                    };
                    if (server.process && server.process.stdin) {
                      server.process.stdin.write(JSON.stringify(initializedNotification) + '\n');
                    }
                    
                    // ここで初めてconnectedをtrueにする
                    server.connected = true;
                    initialized = true;
                    clearTimeout(initTimeout);
                    
                    // イベントリスナーとpendingRequestsのクリーンアップ
                    this.removeListener(`response-${initRequest.id}`, initResponseHandler);
                    this.pendingRequests.delete(initRequest.id);
                    
                    waitResolve();
                  } else if (message.error) {
                    this.logger.error(`${name} initialization failed:`, message.error);
                    this.pendingRequests.delete(initRequest.id);
                    waitReject(new Error(`${name} initialization failed: ${message.error.message}`));
                  }
                }
              };
              
              this.on(`response-${initRequest.id}`, initResponseHandler);
              
              // 実際にリクエストを送信
              if (server.process && server.process.stdin) {
                server.process.stdin.write(JSON.stringify(initRequest) + '\n');
              } else {
                this.logger.warn(`Cannot send initialize request to ${name}: process or stdin not available`);
              }
            };
            
            // タイムアウト設定（10秒に延長）
            initTimeout = setTimeout(() => {
              if (!initialized) {
                // history-mcpなど一部のサーバーは初期化メッセージを送らない場合がある
                // その場合でも接続を許可する
                if (server.process && !server.process.killed) {
                  this.logger.warn(`Server ${name} initialization timeout, but process is running - marking as connected`);
                  server.connected = true;
                  initialized = true;
                  waitResolve();
                } else {
                  waitReject(new Error(`Server ${name} initialization timeout`));
                }
              }
            }, 10000); // 10秒に延長
            
            // プロセスが起動したら初期化リクエストを送信
            setTimeout(sendInitializeRequest, 500); // 500ms待ってから送信
            
            // 初期化完了を検知
            const checkInit = () => {
              if (server.connected) {
                initialized = true;
                clearTimeout(initTimeout);
                this.logger.info(`Successfully started upstream server: ${name}`);
                waitResolve();
              } else {
                // 100ms後に再チェック
                setTimeout(checkInit, 100);
              }
            };
            
            checkInit();
          });
        };
        
        waitForInit()
          .then(() => resolve())
          .catch((err) => reject(err));

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * リクエストを適切な上流サーバーにルーティング
   */
  async routeRequest(request: any): Promise<any> {
    const { method, params, id } = request;
    
    this.logger.debug(`Routing request: ${method} (id: ${id})`);
    
    // デバッグ: 現在の接続状態を表示
    this.logger.info(`Current server connections:`, {
      servers: this.getAvailableServers()
    });
    
    // tools/list と resources/list は全サーバーから集約
    if (method === 'tools/list' || method === 'resources/list') {
      this.logger.debug(`Aggregating ${method} from all servers`);
      return await this.aggregateListResponses(method, params, id);
    }
    
    // その他のリクエストは単一サーバーに転送
    const targetServer = this.selectTargetServer(method, params);
    
    this.logger.info(`Selected target server: ${targetServer} for ${method}`, {
      toolName: params?.name,
      resourceUri: params?.uri
    });
    
    if (!targetServer) {
      throw new Error(`No upstream server available for ${method}`);
    }

    const server = this.upstreamServers.get(targetServer);
    if (!server?.connected || !server.process) {
      this.logger.error(`Server ${targetServer} is not connected`, {
        connected: server?.connected,
        hasProcess: !!server?.process
      });
      throw new Error(`Upstream server ${targetServer} is not connected`);
    }

    // tools/callの場合、プレフィックスを削除
    let modifiedRequest = request;
    if (method === 'tools/call' && params?.name) {
      const toolName = params.name;
      const prefix = `${targetServer}__`;
      if (toolName.startsWith(prefix)) {
        // プレフィックスを削除したリクエストを作成
        modifiedRequest = {
          ...request,
          params: {
            ...params,
            name: toolName.substring(prefix.length)
          }
        };
        this.logger.debug(`Removed prefix from tool name: ${toolName} -> ${modifiedRequest.params.name}`);
      }
    }

    return new Promise((resolve, reject) => {
      this.currentRequestId = id;
      this.pendingRequests.set(id, { resolve, reject, targetServer });
      
      // タイムアウト設定
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${method}`));
      }, 30000);

      // リクエスト送信（修正されたリクエストを使用）
      const requestStr = JSON.stringify(modifiedRequest);
      this.logger.info(`🔄 Sending request to ${targetServer}:`, {
        id: modifiedRequest.id,
        method: modifiedRequest.method,
        params: modifiedRequest.params
      });
      server.process!.stdin?.write(requestStr + '\n');
      
      // レスポンス待ち
      const responseHandler = (response: any) => {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        this.removeListener(`response-${id}`, responseHandler);
        resolve(response);
      };
      this.on(`response-${id}`, responseHandler);
    });
  }

  /**
   * Route a request directly to a specific server
   * Used for targeted requests like prompts/get to a specific backend
   */
  async routeToServer(serverName: string, request: any): Promise<any> {
    const { method, id } = request;

    this.logger.debug(`Routing request directly to server: ${serverName}, method: ${method}`);

    const server = this.upstreamServers.get(serverName);
    if (!server) {
      throw new Error(`Server '${serverName}' not found`);
    }

    if (!server.connected || !server.process) {
      this.logger.error(`Server ${serverName} is not connected`, {
        connected: server.connected,
        hasProcess: !!server.process
      });
      throw new Error(`Server '${serverName}' is not connected`);
    }

    return new Promise((resolve, reject) => {
      this.currentRequestId = id;
      this.pendingRequests.set(id, { resolve, reject, targetServer: serverName });

      // タイムアウト設定
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${method} on server ${serverName}`));
      }, 30000);

      // リクエスト送信
      const requestStr = JSON.stringify(request);
      this.logger.info(`🔄 Sending targeted request to ${serverName}:`, {
        id: request.id,
        method: request.method
      });
      server.process!.stdin?.write(requestStr + '\n');

      // レスポンス待ち
      const responseHandler = (response: any) => {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        this.removeListener(`response-${id}`, responseHandler);
        resolve(response);
      };
      this.on(`response-${id}`, responseHandler);
    });
  }

  /**
   * 複数サーバーからのリスト応答を集約
   */
  private async aggregateListResponses(method: string, params: any, id: number): Promise<any> {
    // デバッグ: 接続中のサーバーを確認
    const connectedServers = Array.from(this.upstreamServers.entries())
      .filter(([_, server]) => server.connected);
    
    this.logger.info(`📊 Aggregating ${method} from ${connectedServers.length} connected servers`);
    connectedServers.forEach(([name, server]) => {
      this.logger.info(`  ✅ ${name}: connected=${server.connected}, hasProcess=${!!server.process}`);
      if (name === 'history-mcp') {
        this.logger.info(`  🔍 HISTORY-MCP STATUS: connected=${server.connected}, pid=${server.process?.pid}`);
      }
    });
    
    // リクエストIDカウンター（標準形式）
    const requestIdBase = typeof id === 'number' ? id : Date.now();
    
    const responses = await Promise.allSettled(
      connectedServers.map(([name, _], index) => 
        this.sendRequestToServer(name, { 
          method, 
          params, 
          id: requestIdBase + index, // シンプルな数値ID
          jsonrpc: '2.0' 
        })
      )
    );

    // デバッグ: レスポンス状況を確認
    responses.forEach((r, i) => {
      const serverName = connectedServers[i][0];
      if (r.status === 'fulfilled') {
        this.logger.debug(`${serverName} response: success`);
      } else {
        this.logger.warn(`${serverName} response: failed - ${r.reason}`);
      }
    });

    const successfulResponses = responses
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<any>).value);

    if (method === 'tools/list') {
      const allTools: any[] = [];
      
      // 各サーバーのツールにプレフィックスを追加
      responses.forEach((response, index) => {
        if (response.status === 'fulfilled') {
          const serverName = connectedServers[index][0];
          const result = (response as PromiseFulfilledResult<any>).value;
          
          if (result.result?.tools) {
            result.result.tools.forEach((tool: any) => {
              // サーバー名をプレフィックスとして追加
              const prefixedName = `${serverName}__${tool.name}`;
              allTools.push({
                ...tool,
                name: prefixedName
              });
              
              // history-mcpツールの場合は特別にログ
              if (serverName === 'history-mcp') {
                this.logger.info(`  🔍 HISTORY-MCP TOOL: ${prefixedName}`);
              }
            });
          }
        }
      });
      
      this.logger.info(`Aggregated ${allTools.length} tools total`);
      
      return { result: { tools: allTools } };
    } else if (method === 'resources/list') {
      const allResources = successfulResponses
        .filter(r => r.result?.resources)
        .flatMap(r => r.result.resources);
      return { result: { resources: allResources } };
    }

    return { result: {} };
  }

  /**
   * 特定のサーバーにリクエストを送信
   */
  private async sendRequestToServer(serverName: string, request: any): Promise<any> {
    const server = this.upstreamServers.get(serverName);
    if (!server?.connected || !server.process) {
      this.logger.error(`Server ${serverName} is not connected`, {
        hasServer: !!server,
        connected: server?.connected,
        hasProcess: !!server?.process
      });
      throw new Error(`Server ${serverName} is not connected`);
    }

    // history-mcpリクエストの場合は詳細ログ
    if (serverName === 'history-mcp') {
      this.logger.info(`🔍 HISTORY-MCP SENDING REQUEST:`, {
        method: request.method,
        id: request.id,
        params: request.params,
        pid: server.process?.pid
      });
    }

    // tools/callの場合、プレフィックスを削除
    let modifiedRequest = request;
    if (request.method === 'tools/call' && request.params?.name) {
      const toolName = request.params.name;
      const prefix = `${serverName}__`;
      if (toolName.startsWith(prefix)) {
        modifiedRequest = {
          ...request,
          params: {
            ...request.params,
            name: toolName.substring(prefix.length)
          }
        };
        this.logger.debug(`[sendRequestToServer] Removed prefix: ${toolName} -> ${modifiedRequest.params.name}`);
        
        if (serverName === 'history-mcp') {
          this.logger.info(`🔍 HISTORY-MCP STRIPPED TOOL NAME: ${modifiedRequest.params.name}`);
        }
      }
    }

    return new Promise((resolve, reject) => {
      const requestId = request.id;
      this.pendingRequests.set(requestId, { resolve, reject, targetServer: serverName });
      
      this.logger.debug(`Pending request registered: ${requestId} -> ${serverName}`);
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.logger.error(`Request timeout for ${serverName} - method: ${modifiedRequest.method}, id: ${requestId}`);
        
        if (serverName === 'history-mcp') {
          this.logger.error(`🔍 HISTORY-MCP TIMEOUT after 30s`);
        }
        
        reject(new Error(`Request timeout for ${serverName}`));
      }, 30000); // 30秒に延長

      const jsonRequest = JSON.stringify(modifiedRequest) + '\n';
      
      if (serverName === 'history-mcp') {
        this.logger.info(`🔍 HISTORY-MCP WRITING TO STDIN:`, jsonRequest.trim());
      }
      
      server.process!.stdin?.write(jsonRequest);
      
      const responseHandler = (response: any) => {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        this.removeListener(`response-${requestId}`, responseHandler);
        
        if (serverName === 'history-mcp') {
          this.logger.info(`🔍 HISTORY-MCP RESPONSE RECEIVED:`, {
            id: response.id,
            hasResult: !!response.result,
            hasError: !!response.error
          });
        }
        
        resolve(response);
      };
      this.on(`response-${requestId}`, responseHandler);
    });
  }

  private selectTargetServer(method: string, params: any): string | null {
    // tools/list と resources/list は全サーバーから集約する必要がある
    // ここでは最初の利用可能なサーバーを返す（後で集約実装を追加）
    if (method === 'tools/list' || method === 'resources/list') {
      for (const [name, server] of this.upstreamServers) {
        if (server.connected) {
          this.logger.debug(`Selected server ${name} for ${method}`);
          return name;
        }
      }
    }
    
    // リソースURIからサーバーを決定
    if (method === 'resources/read') {
      const uri = params?.uri || '';
      
      // URI形式: gmail://... -> gmail サーバー
      const match = uri.match(/^([^:]+):\/\//);
      if (match) {
        const serverName = match[1];
        if (this.upstreamServers.has(serverName)) {
          return serverName;
        }
      }
    }
    
    // ツール名からサーバーを決定
    if (method === 'tools/call') {
      const toolName = params?.name || '';
      
      this.logger.debug(`🔧 Selecting server for tool: ${toolName}`);
      
      // 各サーバーに問い合わせて対応確認
      // プレフィックスでマッチング（__区切りを使用）
      for (const [name, server] of this.upstreamServers) {
        if (toolName.startsWith(name + '__')) {
          this.logger.info(`✅ Matched tool ${toolName} to server ${name}`);
          
          // history-mcpの場合は特別確認
          if (name === 'history-mcp') {
            this.logger.info(`🔍 HISTORY-MCP TOOL CALL: ${toolName}, connected=${server.connected}`);
          }
          
          return name;
        }
      }
      
      this.logger.warn(`⚠️ No server found for tool: ${toolName}`);
    }
    
    // デフォルト: 最初の利用可能なサーバー
    for (const [name, server] of this.upstreamServers) {
      if (server.connected) {
        return name;
      }
    }
    
    return null;
  }

  private handleUpstreamMessage(serverName: string, message: any): void {
    // history-mcpからのメッセージは特別に詳細ログ
    if (serverName === 'history-mcp') {
      this.logger.info(`🔍 HISTORY-MCP MESSAGE:`, JSON.stringify(message));
    } else {
      this.logger.debug(`Received message from ${serverName}:`, JSON.stringify(message).substring(0, 200));
    }
    
    // IDが0の場合も処理するため、undefinedとnullのみを除外
    if (message.id !== undefined && message.id !== null) {
      this.logger.debug(`Checking pending request for ID ${message.id}, has: ${this.pendingRequests.has(message.id)}`);
      
      if (this.pendingRequests.has(message.id)) {
        // レスポンスを対応するリクエストに返す
        this.logger.info(`✅ Response received for request ${message.id} from ${serverName}`);
        
        // history-mcpの場合は詳細確認
        if (serverName === 'history-mcp') {
          this.logger.info(`🔍 HISTORY-MCP RESPONSE ID ${message.id}:`, JSON.stringify(message));
        }
        
        this.emit(`response-${message.id}`, message);
      } else {
        this.logger.warn(`Response for unknown request ID ${message.id} from ${serverName}`);
      }
    } else if (message.method) {
      // 通知メッセージ
      this.logger.debug(`Notification from ${serverName}: ${message.method}`);
      
      // $/notification形式の通知を処理
      if (message.method === '$/notification' && message.params) {
        const notificationMethod = message.params.method;
        const notificationParams = message.params.params || {};
        
        this.logger.info(`📢 Upstream notification from ${serverName}: ${notificationMethod}`, {
          params: notificationParams
        });
        
        // resources/listChangedの場合は特別に処理
        if (notificationMethod === 'resources/listChanged') {
          this.emit('upstreamNotification', {
            serverName,
            notificationMethod,
            notificationParams
          });
        }
      }
      
      // 従来の通知形式もサポート
      this.emit('notification', { from: serverName, message });
    } else {
      this.logger.debug(`Unknown message type from ${serverName}:`, message);
    }
  }

  /**
   * すべての上流サーバーを停止
   */
  async stopServers(): Promise<void> {
    const stopPromises = Array.from(this.upstreamServers.values()).map(server => {
      if (server.process) {
        return new Promise<void>((resolve) => {
          server.process!.on('close', () => resolve());
          server.process!.kill('SIGTERM');
          
          // 強制終了のタイムアウト
          setTimeout(() => {
            if (server.process) {
              server.process.kill('SIGKILL');
            }
            resolve();
          }, 5000);
        });
      }
      return Promise.resolve();
    });

    await Promise.all(stopPromises);
    this.upstreamServers.clear();
  }

  /**
   * 利用可能なサーバーのリストを取得
   */
  getAvailableServers(): Array<{ name: string; connected: boolean }> {
    return Array.from(this.upstreamServers.entries()).map(([name, server]) => ({
      name,
      connected: server.connected
    }));
  }
}