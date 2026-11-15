export const telemetryIntervals = {
  cpu: 600, ram: 600, disk: 900, traffic: 3600, serverPing: 300,
  tunnelProbe: 120, tunnelTraffic: 3600, logs: 120, service: 20, proxy: 20,
};

export type TelemetryStream = keyof typeof telemetryIntervals;
export type TelemetryIntervals = Record<TelemetryStream, number>;
export const telemetryStreams = Object.keys(telemetryIntervals) as [TelemetryStream, ...TelemetryStream[]];
