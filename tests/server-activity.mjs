import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { serverActivities } from "../src/server/server-activity.ts";

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE provision_jobs (server_id TEXT, operation TEXT, status TEXT, queue_until INTEGER, created_at INTEGER);
    CREATE TABLE tunnel_deployments (iran_id TEXT, foreign_id TEXT, status TEXT);
    CREATE TABLE ssh_operation_leases (server_id TEXT, owner TEXT, expires_at INTEGER);
    INSERT INTO provision_jobs VALUES ('queued','remove-v2bx','queued',2000,1),
      ('expired','apply','queued',999,2), ('finished','apply','succeeded',2000,3),
      ('running','reboot','running',999,4);
    INSERT INTO tunnel_deployments VALUES ('iran','foreign','verifying');
    INSERT INTO ssh_operation_leases VALUES ('agent','agent/owner',2000), ('expired-ssh','agent/old',999);
  `);
  const active = serverActivities(db, 1000);
  assert.equal(active.get("queued"), "remove-v2bx");
  assert.equal(active.get("running"), "reboot");
  assert.equal(active.get("iran"), "tunnel");
  assert.equal(active.get("foreign"), "tunnel");
  assert.equal(active.get("agent"), "agent");
  for (const id of ["expired", "finished", "expired-ssh"]) assert.equal(active.has(id), false);
  db.exec("DELETE FROM ssh_operation_leases; UPDATE provision_jobs SET status='failed'; UPDATE tunnel_deployments SET status='succeeded'");
  assert.equal(serverActivities(db, 1000).size, 0);
  console.log("PASS: queued/running activity, paired tunnel locks, SSH expiry and release after completion/failure.");
} finally {
  db.close();
}
