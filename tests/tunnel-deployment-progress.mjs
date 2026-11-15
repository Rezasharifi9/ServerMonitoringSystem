import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./topology" && context.parentURL?.endsWith("/tunnel-deployment-progress.ts")) {
      return next("./topology.ts", context);
    }
    return next(specifier, context);
  },
});
const { completedCheck, deploymentChecks } = await import("../src/lib/tunnel-deployment-progress.ts");
const job = { profile: { id: "wg-test" }, status: "running", operation: "apply", checks: ["package"] };
const run = { status: "deploying", preview: { technology: "WireGuard" } };
assert.deepEqual(deploymentChecks(run, "iran_apply", job), ["package", "service", "icmp"]);
assert.equal(completedCheck("package", job, run), true);
assert.equal(completedCheck("service", job, run), false);
job.status = "succeeded";
assert.equal(completedCheck("service", job, run), true);
assert.equal(completedCheck("icmp", job, run), false);
run.status = "succeeded";
assert.equal(completedCheck("icmp", job, run), true);
run.preview.technology = "Backhaul";
run.status = "verifying";
assert.deepEqual(deploymentChecks(run, "iran_apply", job), ["package", "service", "control"]);
assert.equal(completedCheck("control", job, run), false);
run.status = "succeeded";
assert.equal(completedCheck("control", job, run), true);
console.log("PASS: reported checks update individually; final route/control verification waits for deployment success.");
