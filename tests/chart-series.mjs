import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./telemetry-policy" && context.parentURL?.endsWith("/chart-series.ts")) specifier += ".ts";
    return next(specifier, context);
  },
});
const { observedChartSeries } = await import("../src/lib/chart-series.ts");
const minute = 60000;
const data = [
  { ts: minute, ram: 50, loss: 0 },
  { ts: 2 * minute, ram: null, loss: null },
  { ts: 3 * minute, ram: null, loss: 100 },
  { ts: 5 * minute, ram: 55, loss: null },
  { ts: 16 * minute, ram: 60 },
  { ts: 17 * minute, ram: null },
];
const ram = observedChartSeries(data, "ram", { ram: 300 });
assert.deepEqual(ram.samples.map((p) => p.ts), [minute, 5 * minute, 16 * minute]);
assert.deepEqual(ram.points.map((p) => p.ram), [50, 55, null, 60]);
assert.equal(ram.points.at(-1).ts, 16 * minute, "Do not extend stale values to the present");
assert.deepEqual(observedChartSeries(data, "loss").points.map((p) => p.loss), [0, 100], "Keep real zeros and failures");
assert.deepEqual(observedChartSeries([{ ts: minute, ram: null }], "ram").points, []);
assert.equal(observedChartSeries([{ ts: minute, ram: 0 }], "ram").samples.length, 1);
assert.equal(observedChartSeries(data, "ram", { ram: 600 }).points.length, 3, "Use configured cadence");
assert.equal(observedChartSeries([{ ts: minute, availability: 0 }, { ts: 5 * minute, availability: 100 }], "availability").points[1].availability, null);
const traffic = [{ ts: minute, bandwidth: 0 }, { ts: 21 * minute, bandwidth: 5 }];
assert.equal(observedChartSeries(traffic, "bandwidth", { traffic: 300 }, "traffic").points.length, 3);
assert.deepEqual(observedChartSeries([...data].reverse(), "ram", { ram: 300 }).points, ram.points);
console.log("Chart regression checks passed");
