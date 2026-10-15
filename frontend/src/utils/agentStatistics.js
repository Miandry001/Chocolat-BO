export function buildFilteredAgentRows(performance, users, filters) {
  const usersById = new Map(users.map((entry) => [String(entry.id), entry]));

  return performance.flatMap((agent) => {
    const profile = usersById.get(String(agent.actorId));
    const fullName = profile?.fullName
      || `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim()
      || profile?.login
      || String(agent.actorId);
    if (filters.role && profile?.role !== filters.role) return [];
    if (filters.agent && !fullName.toLowerCase().includes(filters.agent.trim().toLowerCase())) return [];

    return [{
      agentId: agent.actorId,
      agent: fullName,
      lines: agent.daily.reduce((total, day) => total + day.validatedLines, 0),
      returns: agent.daily.reduce((total, day) => total + (day.correctedReturns ?? 0), 0),
    }];
  }).sort((left, right) => left.agent.localeCompare(right.agent));
}
