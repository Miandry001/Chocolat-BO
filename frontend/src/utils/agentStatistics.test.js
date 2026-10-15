import assert from "node:assert/strict";
import test from "node:test";
import { buildFilteredAgentRows } from "./agentStatistics.js";

test("agent statistics combine submissions and corrected returns across the selected days", () => {
  const rows = buildFilteredAgentRows([{
    actorId: "agent-1",
    daily: [
      { date: "2026-10-06", validatedLines: 2, correctedReturns: 0 },
      { date: "2026-10-07", validatedLines: 0, correctedReturns: 1 },
    ],
  }], [{
    id: "agent-1",
    fullName: "Haris Potte",
    role: "AGENT",
  }], { role: "", agent: "" });

  assert.deepEqual(rows, [{
    agentId: "agent-1",
    agent: "Haris Potte",
    lines: 2,
    returns: 1,
  }]);
});

test("agent statistics do not display the generic Agent placeholder when the profile is missing", () => {
  const rows = buildFilteredAgentRows([{
    actorId: "agent-42",
    daily: [{ date: "2026-10-06", validatedLines: 1, correctedReturns: 0 }],
  }], [], { role: "", agent: "" });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "agent-42");
});

test("agent and role filters apply to the aggregated agent row", () => {
  const performance = [
    { actorId: "agent-1", daily: [{ date: "2026-10-06", validatedLines: 2, correctedReturns: 1 }] },
    { actorId: "supervisor-1", daily: [{ date: "2026-10-06", validatedLines: 1, correctedReturns: 0 }] },
  ];
  const users = [
    { id: "agent-1", fullName: "Haris Potte", role: "AGENT" },
    { id: "supervisor-1", fullName: "Sam Supervisor", role: "SUPERVISEUR" },
  ];

  assert.deepEqual(
    buildFilteredAgentRows(performance, users, { role: "AGENT", agent: "haris" }).map(({ agent }) => agent),
    ["Haris Potte"],
  );
});
