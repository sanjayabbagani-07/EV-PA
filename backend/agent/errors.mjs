// Shared error types. `code` is stable and machine-readable; `message` is safe to show to the user.
export class AgentError extends Error {
  constructor(code, message, { retryable = false, status = 500, details } = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.details = details;
  }
}

export class ToolError extends AgentError {
  constructor(code, message, opts) {
    super(code, message, opts);
    this.name = 'ToolError';
  }
}
