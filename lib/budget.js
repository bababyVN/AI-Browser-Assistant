/**
 * Budget Tracker — API Request Budget Module
 * Tracks API requests per minute, estimates token costs,
 * and provides quota-awareness to prevent rate limit errors.
 */

export class BudgetTracker {
  constructor() {
    this.requests = { count: 0, resetAt: Date.now() };
  }

  /**
   * Estimate tokens for a string (~4 chars per token)
   */
  estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
  }

  /**
   * Estimate total token cost of an API call before sending
   */
  estimateCallCost(history, tools, systemPrompt) {
    let total = this.estimateTokens(systemPrompt);
    total += this.estimateTokens(JSON.stringify(tools));
    for (const msg of history) {
      total += this.estimateTokens(JSON.stringify(msg));
    }
    return total;
  }

  /**
   * Record a completed API request
   */
  recordRequest() {
    const now = Date.now();
    // Reset counter every 60 seconds
    if (now - this.requests.resetAt > 60000) {
      this.requests = { count: 0, resetAt: now };
    }
    this.requests.count++;
  }

  /**
   * Get current usage stats
   */
  getStats() {
    // Auto-reset if minute has passed
    if (Date.now() - this.requests.resetAt > 60000) {
      this.requests = { count: 0, resetAt: Date.now() };
    }
    return {
      requestsThisMinute: this.requests.count,
      maxRequestsPerMinute: 15,
      remainingThisMinute: Math.max(0, 15 - this.requests.count)
    };
  }

  /**
   * Should we warn the user? (80% of limit)
   */
  shouldWarn() {
    this.getStats(); // Refresh
    return this.requests.count >= 12;
  }

  /**
   * Should we block/delay? (at limit)
   */
  shouldBlock() {
    this.getStats(); // Refresh
    return this.requests.count >= 15;
  }

  /**
   * Wait until rate limit window resets
   * Returns ms to wait, or 0 if safe to proceed
   */
  getWaitTime() {
    if (!this.shouldBlock()) return 0;
    const elapsed = Date.now() - this.requests.resetAt;
    return Math.max(0, 60000 - elapsed);
  }
}
