// ============================================================================
// AEGIS - ロガーユーティリティ
// ============================================================================

import winston from 'winston';

export class Logger {
  private logger: winston.Logger;

  constructor(level: string = 'info') {
    // In MCP stdio mode, all logs must go to stderr
    const isStdioMode = process.env.MCP_TRANSPORT === 'stdio' || 
                       process.argv.includes('--stdio') || 
                       process.argv.includes('--transport') && process.argv[process.argv.indexOf('--transport') + 1] === 'stdio';
    const isSilent = process.env.LOG_SILENT === 'true';
    
    this.logger = winston.createLogger({
      level: level,
      format: winston.format.combine(
        winston.format.timestamp({
          format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'aegis' },
      transports: [
        // コンソール出力（サイレントモードでは完全に無効化）
        new winston.transports.Console({
          silent: isSilent,
          stderrLevels: isStdioMode ? ['error', 'warn', 'info', 'debug'] : ['error'],
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple(),
            winston.format.printf(({ timestamp, level, message, service, ...metadata }) => {
              let msg = `${timestamp} [${service}] ${level}: ${message}`;
              if (Object.keys(metadata).length > 0) {
                msg += ` ${JSON.stringify(metadata)}`;
              }
              return msg;
            })
          )
        })
      ]
    });

    // ファイル出力（プロダクション環境）
    if (process.env.NODE_ENV === 'production') {
      this.logger.add(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
      this.logger.add(new winston.transports.File({ filename: 'logs/combined.log' }));
    }
  }

  private shouldLog(): boolean {
    return process.env.LOG_SILENT !== 'true';
  }

  info(message: string, metadata?: any) {
    if (this.shouldLog()) {
      this.logger.info(message, metadata);
    }
  }

  warn(message: string, metadata?: any) {
    if (this.shouldLog()) {
      this.logger.warn(message, metadata);
    }
  }

  error(message: string, metadata?: any) {
    if (this.shouldLog()) {
      this.logger.error(message, metadata);
    }
  }

  debug(message: string, metadata?: any) {
    if (this.shouldLog()) {
      this.logger.debug(message, metadata);
    }
  }
  
  // Critical messages that should be visible even in stdio mode
  critical(message: string, metadata?: any) {
    const isStdioMode = process.env.MCP_TRANSPORT === 'stdio' || 
                       process.argv.includes('--stdio') || 
                       process.argv.includes('--transport') && process.argv[process.argv.indexOf('--transport') + 1] === 'stdio';
    
    // In stdio mode with LOG_SILENT, do not output anything
    if (isStdioMode && process.env.LOG_SILENT === 'true') {
      return;
    }
    
    if (isStdioMode) {
      console.error(`[AEGIS CRITICAL] ${message}`, metadata ? JSON.stringify(metadata) : '');
    } else {
      this.error(message, metadata);
    }
  }

  // AEGIS専用ログメソッド
  decision(agentId: string, decision: string, resource: string, reason: string) {
    this.info('Access Decision', {
      type: 'DECISION',
      agentId,
      decision,
      resource,
      reason,
      timestamp: new Date().toISOString()
    });
  }

  violation(agentId: string, resource: string, reason: string) {
    this.warn('Policy Violation', {
      type: 'VIOLATION',
      agentId,
      resource,
      reason,
      timestamp: new Date().toISOString()
    });
  }

  audit(action: string, details: any) {
    this.info('Audit Log', {
      type: 'AUDIT',
      action,
      details,
      timestamp: new Date().toISOString()
    });
  }
}

// デフォルトloggerインスタンスをエクスポート
export const logger = new Logger();