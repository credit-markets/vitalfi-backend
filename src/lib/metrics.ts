/**
 * Metrics Tracking
 *
 * In-memory metrics for monitoring and alerting.
 * Designed for serverless - metrics reset on cold start.
 * For persistent metrics, consider external service (Datadog, Prometheus).
 */

export interface RequestMetric {
  count: number;
  errors: number;
  latencies: number[];
  rateLimitHits: number;
}

export interface WebhookMetric {
  count: number;
  errors: number;
  latencies: number[];
  vaultsProcessed: number;
  positionsProcessed: number;
  activitiesProcessed: number;
}

interface MetricsStore {
  requests: Record<string, RequestMetric>;
  webhook: WebhookMetric;
  startTime: number;
}

// In-memory metrics store
const store: MetricsStore = {
  requests: {},
  webhook: {
    count: 0,
    errors: 0,
    latencies: [],
    vaultsProcessed: 0,
    positionsProcessed: 0,
    activitiesProcessed: 0,
  },
  startTime: Date.now(),
};

// Keep only last N latencies to prevent memory growth
const MAX_LATENCIES = 1000;

/**
 * Record a request metric
 */
export function recordRequest(
  endpoint: string,
  status: number,
  durationMs: number,
  rateLimitHit: boolean = false
): void {
  if (!store.requests[endpoint]) {
    store.requests[endpoint] = {
      count: 0,
      errors: 0,
      latencies: [],
      rateLimitHits: 0,
    };
  }

  const metric = store.requests[endpoint];
  metric.count++;

  if (status >= 500) {
    metric.errors++;
  }

  if (rateLimitHit) {
    metric.rateLimitHits++;
  }

  metric.latencies.push(durationMs);
  if (metric.latencies.length > MAX_LATENCIES) {
    metric.latencies.shift();
  }
}

/**
 * Record webhook processing metric
 */
export function recordWebhook(
  durationMs: number,
  vaults: number,
  positions: number,
  activities: number,
  isError: boolean = false
): void {
  store.webhook.count++;
  store.webhook.vaultsProcessed += vaults;
  store.webhook.positionsProcessed += positions;
  store.webhook.activitiesProcessed += activities;

  if (isError) {
    store.webhook.errors++;
  }

  store.webhook.latencies.push(durationMs);
  if (store.webhook.latencies.length > MAX_LATENCIES) {
    store.webhook.latencies.shift();
  }
}

/**
 * Calculate percentile from array of values
 */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Calculate statistics from latency array
 */
function calculateStats(latencies: number[]): {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
} {
  if (latencies.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...latencies),
    max: Math.max(...latencies),
    avg: Math.round(sum / latencies.length),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };
}

/**
 * Get all metrics for reporting
 */
export function getMetrics(): {
  uptime: number;
  requests: Record<string, {
    count: number;
    errors: number;
    errorRate: number;
    rateLimitHits: number;
    latency: ReturnType<typeof calculateStats>;
  }>;
  webhook: {
    count: number;
    errors: number;
    errorRate: number;
    vaultsProcessed: number;
    positionsProcessed: number;
    activitiesProcessed: number;
    latency: ReturnType<typeof calculateStats>;
  };
  totals: {
    requests: number;
    errors: number;
    errorRate: number;
  };
} {
  const requestMetrics: Record<string, any> = {};
  let totalRequests = 0;
  let totalErrors = 0;

  for (const [endpoint, metric] of Object.entries(store.requests)) {
    const errorRate = metric.count > 0 ? metric.errors / metric.count : 0;
    requestMetrics[endpoint] = {
      count: metric.count,
      errors: metric.errors,
      errorRate: Math.round(errorRate * 10000) / 100, // percentage with 2 decimals
      rateLimitHits: metric.rateLimitHits,
      latency: calculateStats(metric.latencies),
    };
    totalRequests += metric.count;
    totalErrors += metric.errors;
  }

  const webhookErrorRate = store.webhook.count > 0
    ? store.webhook.errors / store.webhook.count
    : 0;

  const totalErrorRate = totalRequests > 0
    ? totalErrors / totalRequests
    : 0;

  return {
    uptime: Math.round((Date.now() - store.startTime) / 1000),
    requests: requestMetrics,
    webhook: {
      count: store.webhook.count,
      errors: store.webhook.errors,
      errorRate: Math.round(webhookErrorRate * 10000) / 100,
      vaultsProcessed: store.webhook.vaultsProcessed,
      positionsProcessed: store.webhook.positionsProcessed,
      activitiesProcessed: store.webhook.activitiesProcessed,
      latency: calculateStats(store.webhook.latencies),
    },
    totals: {
      requests: totalRequests,
      errors: totalErrors,
      errorRate: Math.round(totalErrorRate * 10000) / 100,
    },
  };
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetMetrics(): void {
  store.requests = {};
  store.webhook = {
    count: 0,
    errors: 0,
    latencies: [],
    vaultsProcessed: 0,
    positionsProcessed: 0,
    activitiesProcessed: 0,
  };
  store.startTime = Date.now();
}
