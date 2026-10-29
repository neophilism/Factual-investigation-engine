import test from "node:test";
import assert from "node:assert/strict";
import * as f from "../src/index.ts";
import * as e from "../src/efforts.ts";
import { createKnowledgeState } from "@accountability/knowledge-verification";
import type { Context } from "@accountability/knowledge-verification/contracts";
const c: Context = {
  tenantId: "fixture",
  projectId: "review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
function setup() {
  const value: f.Plan = {
    title: "Fictional signal",
    intakeCaseRef: null,
    basisClaimRefs: [],
    questions: [
      {
        id: "q",
        parentId: null,
        text: "What happened?",
        material: true,
        whyMaterial: "Timing is unresolved",
        hypotheses: [
          {
            id: "h",
            explanation: "An early signal",
            claimRefs: [],
            contraryTest: "Look for a later signal",
          },
        ],
        leads: [{ id: "log", description: "Check authorized log" }],
        stopCondition: "Pause if unavailable; no inferred answer",
      },
    ],
  };
  const knowledge = createKnowledgeState(c),
    plans = f.revisePlan(c, knowledge, f.createPlanningState(c), {
      id: "plan",
      expectedRevision: 0,
      value,
    });
  const q: e.EffortInput = {
    id: "effort",
    expectedSequence: 0,
    plan: plans.records[0]!.ref,
    questionId: "q",
    leadId: "log",
    outcome: "unavailable",
    detail: "Synthetic authorized log was unavailable",
    corrects: null,
  };
  return { plans, q, state: e.createEffortState(c), knowledge, value };
}
test("private unavailable/exhausted efforts preserve planning without answers or closure", () => {
  const x = setup(),
    before = structuredClone(x.plans);
  let s = e.recordEffort(c, x.plans, x.state, x.q);
  s = e.recordEffort(c, x.plans, s, {
    ...x.q,
    id: "second",
    expectedSequence: 1,
    outcome: "exhausted",
  });
  assert.deepEqual(x.plans, before);
  assert.equal(s.records[0]!.visibility, "private");
  assert.equal(e.inspectEfforts(c, s).effective.length, 2);
  assert.equal(Object.hasOwn(s.records[1]!, "answer"), false);
  assert.equal(x.state.records.length, 0);
});
test("explicit correction chains retain every prior record and refuse correction forks", () => {
  const x = setup(),
    s = e.recordEffort(c, x.plans, x.state, x.q);
  const corrected = e.recordEffort(c, x.plans, s, {
    ...x.q,
    id: "correction",
    expectedSequence: 1,
    corrects: s.records[0]!.ref,
    outcome: "attempted",
    detail: "Corrected description; outcome unresolved",
  });
  const view = e.inspectEfforts(c, corrected);
  assert.equal(view.history.length, 2);
  assert.deepEqual(
    view.effective.map((r) => r.ref.id),
    ["correction"],
  );
  assert.equal(s.records.length, 1);
  assert.throws(
    () =>
      e.recordEffort(c, x.plans, corrected, {
        ...x.q,
        id: "fork",
        expectedSequence: 2,
        corrects: s.records[0]!.ref,
      }),
    { code: "invalid_correction" },
  );
  const chain = e.recordEffort(c, x.plans, corrected, {
    ...x.q,
    id: "chain",
    expectedSequence: 2,
    corrects: corrected.records[1]!.ref,
  });
  assert.equal(e.inspectEfforts(c, chain).effective[0]!.ref.id, "chain");
});
test("new efforts require current plan; explicit historical corrections keep their exact old context", () => {
  const x = setup(),
    s = e.recordEffort(c, x.plans, x.state, x.q);
  const plans = f.revisePlan(c, x.knowledge, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: { ...x.value, title: "Updated plan" },
  });
  assert.throws(
    () =>
      e.recordEffort(c, plans, s, {
        ...x.q,
        id: "new-old",
        expectedSequence: 1,
      }),
    { code: "stale_plan" },
  );
  const old = e.recordEffort(c, plans, s, {
    ...x.q,
    id: "fix-old",
    expectedSequence: 1,
    corrects: s.records[0]!.ref,
  });
  assert.equal(old.records[1]!.plan.revision, 1);
  assert.throws(
    () =>
      e.recordEffort(c, plans, s, {
        ...x.q,
        id: "cross-edition",
        expectedSequence: 1,
        plan: plans.records[1]!.ref,
        corrects: s.records[0]!.ref,
      }),
    { code: "invalid_correction" },
  );
});
test("foreign/missing question lead plan and untrusted closure fields deny", () => {
  const x = setup();
  for (const patch of [
    { questionId: "missing" },
    { leadId: "missing" },
    { plan: { ...x.q.plan, projectId: "foreign" } },
    { plan: { ...x.q.plan, id: "absent" } },
    { outcome: "answered" },
    { status: "closed" },
    { answer: "verified" },
    { corrects: { ...x.q.plan, kind: "investigation-effort", id: "absent" } },
  ])
    assert.throws(() =>
      e.recordEffort(c, x.plans, x.state, {
        ...x.q,
        ...patch,
      } as e.EffortInput),
    );
  assert.equal(x.state.records.length, 0);
});
test("current sequence, role/scope, private shape and detached results are enforced", () => {
  const x = setup(),
    s = e.recordEffort(c, x.plans, x.state, x.q);
  assert.throws(() => e.recordEffort(c, x.plans, s, { ...x.q, id: "new" }), {
    code: "revision_conflict",
  });
  assert.throws(
    () => e.recordEffort(c, x.plans, s, { ...x.q, expectedSequence: 1 }),
    { code: "invalid_effort" },
  );
  assert.throws(() => e.inspectEfforts({ ...c, projectId: "foreign" }, s), {
    code: "scope_denied",
  });
  assert.throws(
    () =>
      e.inspectEfforts({ ...c, actor: { ...c.actor, roles: ["viewer"] } }, s),
    { code: "forbidden" },
  );
  const view = e.inspectEfforts(c, s);
  Object.assign(view.history[0]!, { detail: "Detached" });
  assert.notEqual(s.records[0]!.detail, "Detached");
  for (const patch of [
    { visibility: "public" },
    { sequence: 4 },
    { ref: { ...s.records[0]!.ref, revision: 2 } },
    { createdAt: "2026-02-30T00:00:00Z" },
  ]) {
    const bad = structuredClone(s);
    Object.assign(bad.records[0]!, patch);
    assert.throws(() => e.assertEffortState(bad));
  }
});
test("512-record and UTF8 budgets preserve earlier efforts without eviction", () => {
  const x = setup(),
    s = e.recordEffort(c, x.plans, x.state, x.q),
    r = s.records[0]!;
  const full: e.EffortState = {
    ...s,
    records: Array.from({ length: 512 }, (_, i) => ({
      ...structuredClone(r),
      sequence: i + 1,
      ref: { ...r.ref, id: "e" + i },
    })),
  };
  e.assertEffortState(full);
  assert.throws(
    () =>
      e.recordEffort(c, x.plans, full, {
        ...x.q,
        id: "extra",
        expectedSequence: 512,
      }),
    { code: "invalid_effort" },
  );
  assert.equal(full.records.length, 512);
  const huge = structuredClone(full);
  for (const r of huge.records) Object.assign(r, { detail: "😀".repeat(2000) });
  assert.throws(() => e.assertEffortState(huge), { code: "efforts_full" });
});

test("question-wide records remain separate from leads and cannot be corrected into another context", () => {
  const x = setup();
  const s = e.recordEffort(c, x.plans, x.state, {
    ...x.q,
    leadId: null,
    outcome: "attempted",
  });
  assert.equal(s.records[0]!.leadId, null);
  assert.throws(
    () =>
      e.recordEffort(c, x.plans, s, {
        ...x.q,
        id: "wrong-lead",
        expectedSequence: 1,
        corrects: s.records[0]!.ref,
      }),
    { code: "invalid_correction" },
  );
  const detail = x.q.detail;
  const input = { ...x.q, id: "lead-effort", expectedSequence: 1 };
  const next = e.recordEffort(c, x.plans, s, input);
  Object.assign(input, { detail: "Mutated caller input" });
  assert.equal(next.records[1]!.detail, detail);
  assert.equal(e.inspectEfforts(c, next).effective.length, 2);
});
