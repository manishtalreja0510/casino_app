/// Health/readiness responses, mirroring `packages/contracts/src/health.ts`.
library;

enum HealthStatus { ok, degraded, down, unknown }

HealthStatus _statusFrom(Object? value) => switch (value) {
      'ok' => HealthStatus.ok,
      'degraded' => HealthStatus.degraded,
      'down' => HealthStatus.down,
      _ => HealthStatus.unknown,
    };

class HealthResponse {
  const HealthResponse({
    required this.status,
    required this.version,
    required this.environment,
    required this.uptimeSeconds,
  });

  final HealthStatus status;
  final String version;
  final String environment;
  final int uptimeSeconds;

  factory HealthResponse.fromJson(Map<String, dynamic> json) => HealthResponse(
        status: _statusFrom(json['status']),
        version: json['version'] as String? ?? 'unknown',
        environment: json['environment'] as String? ?? 'unknown',
        uptimeSeconds: json['uptimeSeconds'] as int? ?? 0,
      );
}

class DependencyHealth {
  const DependencyHealth({required this.name, required this.status});

  final String name;
  final HealthStatus status;
}

class ReadinessResponse {
  const ReadinessResponse({required this.status, required this.dependencies});

  final HealthStatus status;
  final List<DependencyHealth> dependencies;

  factory ReadinessResponse.fromJson(Map<String, dynamic> json) => ReadinessResponse(
        status: _statusFrom(json['status']),
        dependencies: (json['dependencies'] as List<dynamic>? ?? [])
            .whereType<Map<String, dynamic>>()
            .map((d) => DependencyHealth(
                  name: d['name'] as String? ?? 'unknown',
                  status: _statusFrom(d['status']),
                ))
            .toList(),
      );
}
