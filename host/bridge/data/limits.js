const GLOBAL_MAX_CONCURRENT = 64;
const PER_AGENT_MAX = 8;

const agentSem = new Map(); // agentId -> { active, wait }
let globalActive = 0;

const getSlot = (agentId) => {
  const id = agentId || "_anon";
  if (!agentSem.has(id)) {
    agentSem.set(id, { active: 0, wait: [] });
  }
  return agentSem.get(id);
};

/**
 * Acquire concurrency slot. Throws if would block too long / overloaded.
 */
export const acquire = async (agentId, { timeoutMs = 30_000 } = {}) => {
  const start = Date.now();
  const slot = getSlot(agentId);

  const tryTake = () => {
    if (globalActive < GLOBAL_MAX_CONCURRENT && slot.active < PER_AGENT_MAX) {
      globalActive += 1;
      slot.active += 1;
      return true;
    }
    return false;
  };

  if (tryTake()) return;

  return new Promise((resolve, reject) => {
    const entry = {
      resolve: () => {
        if (tryTake()) resolve();
        else reject(Object.assign(new Error("Data plane overloaded"), { code: "EBUSY" }));
      },
      reject,
      timer: null,
    };
    entry.timer = setTimeout(() => {
      const idx = slot.wait.indexOf(entry);
      if (idx >= 0) slot.wait.splice(idx, 1);
      reject(Object.assign(new Error("Data plane busy (timeout)"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    slot.wait.push(entry);
  });
};

export const release = (agentId) => {
  const slot = getSlot(agentId);
  if (slot.active > 0) slot.active -= 1;
  if (globalActive > 0) globalActive -= 1;
  const next = slot.wait.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  }
};

export const limitsSnapshot = () => ({
  globalActive,
  globalMax: GLOBAL_MAX_CONCURRENT,
  perAgentMax: PER_AGENT_MAX,
  agents: [...agentSem.entries()].map(([id, s]) => ({
    id,
    active: s.active,
    waiting: s.wait.length,
  })),
});
