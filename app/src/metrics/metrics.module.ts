import { Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

@Module({
  imports: [
    PrometheusModule.register({
      // Exposes GET /metrics with default Node.js process metrics
      // (memory, event loop lag, GC) plus whatever custom metrics you
      // register elsewhere (e.g. queue depth, replica lag) as this
      // grows. Prometheus (see docker-compose.yml) scrapes this on an
      // interval; Grafana visualizes what Prometheus collects.
      path: 'metrics',
      defaultMetrics: { enabled: true },
    }),
  ],
})
export class MetricsModule {}
