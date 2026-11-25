import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acquireFreePiQueueLock,
  isFreePiSlotAvailable,
  getFreePiQueueStats,
  reserveFreePiSlot,
  evictFreePiSlot,
} from "../../open-sse/executors/freepi.js";
import {
  deriveConversationKey,
  getAffinityConnectionId,
  setAffinityConnection,
  clearAffinity,
} from "../../src/sse/services/conversationAffinity.js";

describe("FreePI Parallel Stream Slot & Concurrency Tests", () => {
  it("reports slot as available when idle and busy when locked", async () => {
    const testId = "conn-test-slot-1";
    evictFreePiSlot(testId);

    assert.equal(isFreePiSlotAvailable(testId), true, "Slot should be available initially");
    const stats0 = getFreePiQueueStats(testId);
    assert.equal(stats0.running, false);
    assert.equal(stats0.waitingCount, 0);

    const release = await acquireFreePiQueueLock(testId);
    assert.equal(isFreePiSlotAvailable(testId), false, "Slot should be busy after acquire");
    const stats1 = getFreePiQueueStats(testId);
    assert.equal(stats1.running, true);
    assert.equal(stats1.waitingCount, 0);

    await release();
    // After release and settling delay, slot should be available again
    assert.equal(isFreePiSlotAvailable(testId), true, "Slot should be idle after release");
    evictFreePiSlot(testId);
  });

  it("handles concurrent requests across distinct account slots in parallel", async () => {
    const acc1 = "conn-acc-1";
    const acc2 = "conn-acc-2";
    evictFreePiSlot(acc1);
    evictFreePiSlot(acc2);

    // Both should be idle
    assert.equal(isFreePiSlotAvailable(acc1), true);
    assert.equal(isFreePiSlotAvailable(acc2), true);

    // Acc 1 starts streaming
    const release1 = await acquireFreePiQueueLock(acc1);
    assert.equal(isFreePiSlotAvailable(acc1), false, "Acc 1 should be busy");
    assert.equal(isFreePiSlotAvailable(acc2), true, "Acc 2 should remain idle and ready for parallel request");

    // Acc 2 starts streaming in parallel without blocking
    const release2 = await acquireFreePiQueueLock(acc2);
    assert.equal(isFreePiSlotAvailable(acc1), false);
    assert.equal(isFreePiSlotAvailable(acc2), false);

    // Release both
    await Promise.all([release1(), release2()]);

    assert.equal(isFreePiSlotAvailable(acc1), true);
    assert.equal(isFreePiSlotAvailable(acc2), true);

    evictFreePiSlot(acc1);
    evictFreePiSlot(acc2);
  });

  it("enforces FIFO queue on the same account and delegates next upon release", async () => {
    const testId = "conn-fifo-test";
    evictFreePiSlot(testId);

    const release1 = await acquireFreePiQueueLock(testId);
    assert.equal(isFreePiSlotAvailable(testId), false);

    let req2Acquired = false;
    let release2 = null;

    // Request 2 queues behind Request 1
    const p2 = acquireFreePiQueueLock(testId).then((rel) => {
      req2Acquired = true;
      release2 = rel;
    });

    const statsDuringQueue = getFreePiQueueStats(testId);
    assert.equal(statsDuringQueue.running, true);
    assert.equal(statsDuringQueue.waitingCount, 1, "Request 2 should be waiting in queue");
    assert.equal(req2Acquired, false, "Request 2 should not have acquired yet");

    // Release request 1
    await release1();

    // Await request 2 acquiring the slot
    await p2;
    assert.equal(req2Acquired, true, "Request 2 should now have acquired the slot");

    if (release2) await release2();
    evictFreePiSlot(testId);
  });

  it("triggers circuit breaker fast-fail when queue capacity is overwhelmed (MAX_QUEUE_SIZE = 10)", async () => {
    const testId = "conn-circuit-breaker";
    evictFreePiSlot(testId);

    const rootRelease = await acquireFreePiQueueLock(testId);
    const waitingPromises = [];

    // Fill queue to MAX_QUEUE_SIZE (10)
    for (let i = 0; i < 10; i++) {
      waitingPromises.push(acquireFreePiQueueLock(testId));
    }

    const stats = getFreePiQueueStats(testId);
    assert.equal(stats.waitingCount, 10);

    // 11th request should be immediately rejected with circuit breaker error
    await assert.rejects(
      async () => {
        await acquireFreePiQueueLock(testId);
      },
      (err) => {
        assert.match(err.message, /FreePI queue full/);
        return true;
      }
    );

    // Cleanup root release and waiting items
    await rootRelease();
    for (const p of waitingPromises) {
      const rel = await p;
      if (rel) await rel();
    }
    evictFreePiSlot(testId);
  });

  it("splices waiting item from queue immediately when client aborts", async () => {
    const testId = "conn-abort-test";
    evictFreePiSlot(testId);

    const rootRelease = await acquireFreePiQueueLock(testId);
    const ac = new AbortController();

    const queuedPromise = acquireFreePiQueueLock(testId, ac.signal);
    const statsBefore = getFreePiQueueStats(testId);
    assert.equal(statsBefore.waitingCount, 1);

    // Client cancels
    ac.abort();

    await assert.rejects(
      async () => {
        await queuedPromise;
      },
      (err) => {
        assert.match(err.message, /aborted/i);
        return true;
      }
    );

    const statsAfter = getFreePiQueueStats(testId);
    assert.equal(statsAfter.waitingCount, 0, "Aborted request should be removed from queue array");

    await rootRelease();
    evictFreePiSlot(testId);
  });

  it("isolates conversation affinity keys across arbitrarily many models with identical prompt (Arena N-contenders)", () => {
    const prompt = "Risiko: flash sale menyebabkan oversell jika desain stok tidak idempoten";
    const models = [
      "fp/glm-5.3-flash",
      "fp/deepseek-v4.1-flash",
      "fp/qwen-2.5-72b",
      "fp/kimi-k1.5",
      "fp/llama-3.3-70b",
      "fp/gpt-4o-mini"
    ];

    const keys = models.map((model) =>
      deriveConversationKey({
        body: { model, messages: [{ role: "user", content: prompt }] },
        clientIp: "127.0.0.1"
      })
    );

    // Every contender must produce a valid non-null key
    for (let i = 0; i < keys.length; i++) {
      assert.ok(keys[i], `Contender ${i + 1} (${models[i]}) must have a valid conversation key`);
    }

    // Every key must be completely unique (no collisions among all N contenders)
    const uniqueKeys = new Set(keys);
    assert.equal(uniqueKeys.size, models.length, `All ${models.length} contenders must have completely distinct keys`);
  });

  it("releases sticky affinity for single-turn FreePI when pinned account slot is busy", async () => {
    const accBusy = "conn-acc-busy";
    const accIdle = "conn-acc-idle";
    evictFreePiSlot(accBusy);
    evictFreePiSlot(accIdle);

    const convKey = "prefix:ip:127.0.0.1:single-turn-test";
    setAffinityConnection("freepi", convKey, accBusy);
    assert.equal(getAffinityConnectionId("freepi", convKey), accBusy);

    // Lock the busy account
    const releaseBusy = await acquireFreePiQueueLock(accBusy);
    assert.equal(isFreePiSlotAvailable(accBusy), false);
    assert.equal(isFreePiSlotAvailable(accIdle), true);

    // Simulate affinity check for single turn
    const body = {
      model: "fp/glm-5.3-flash",
      messages: [{ role: "user", content: "Halo bot" }]
    };
    const isMultiTurn = Array.isArray(body?.messages) && body.messages.some((m) => m?.role === "assistant");
    const hasExplicitSession = Boolean(body?.session_id || body?.conversation_id);
    const mustStaySticky = isMultiTurn || hasExplicitSession;
    assert.equal(mustStaySticky, false, "Single-turn prompt should not be forced sticky");

    let useAffinity = true;
    if (!mustStaySticky && !isFreePiSlotAvailable(accBusy)) {
      clearAffinity("freepi", convKey);
      useAffinity = false;
    }

    assert.equal(useAffinity, false, "Should bypass busy affinity");
    assert.equal(getAffinityConnectionId("freepi", convKey), null, "Affinity should be cleared");

    // Clean up
    await releaseBusy();
    evictFreePiSlot(accBusy);
    evictFreePiSlot(accIdle);
  });

  it("instantly reserves in-flight slot to distribute concurrent Arena requests evenly", async () => {
    const accA = "conn-acc-nauppp";
    const accB = "conn-acc-naummi";
    evictFreePiSlot(accA);
    evictFreePiSlot(accB);

    const availableConnections = [
      { id: accA, name: "nauppp@github", priority: 1 },
      { id: accB, name: "naummi@github", priority: 2 },
    ];

    // Helper simulating the dispatch logic in auth.js
    const dispatchAccount = () => {
      const idleConn = availableConnections.find((c) => isFreePiSlotAvailable(c.id));
      let selected;
      if (idleConn) {
        selected = idleConn;
      } else {
        const sorted = [...availableConnections].sort((a, b) => {
          return getFreePiQueueStats(a.id).totalLoad - getFreePiQueueStats(b.id).totalLoad;
        });
        selected = sorted[0];
      }
      reserveFreePiSlot(selected.id);
      return selected.id;
    };

    // 4 concurrent requests arrive at the same millisecond
    const assigned1 = dispatchAccount();
    const assigned2 = dispatchAccount();
    const assigned3 = dispatchAccount();
    const assigned4 = dispatchAccount();

    assert.equal(assigned1, accA, "Request 1 should take idle Account A");
    assert.equal(assigned2, accB, "Request 2 MUST take Account B because Account A was reserved (no race condition)");
    assert.equal(assigned3, accA, "Request 3 should distribute to Account A");
    assert.equal(assigned4, accB, "Request 4 should distribute to Account B");

    // Check stats: both accounts have totalLoad of 2
    assert.equal(getFreePiQueueStats(accA).totalLoad, 2);
    assert.equal(getFreePiQueueStats(accB).totalLoad, 2);

    // Request 1 and 2 start execution
    const release1 = await acquireFreePiQueueLock(accA);
    const release2 = await acquireFreePiQueueLock(accB);

    // Both should be running simultaneously in parallel!
    assert.equal(getFreePiQueueStats(accA).running, true);
    assert.equal(getFreePiQueueStats(accB).running, true);

    // Cleanup
    await Promise.all([release1(), release2()]);
    evictFreePiSlot(accA);
    evictFreePiSlot(accB);
  });
});
