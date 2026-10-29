import test from "node:test";
import assert from "node:assert/strict";
import * as f from "../src/index.ts";
import * as k from "@accountability/knowledge-verification";
import type { Context } from "@accountability/knowledge-verification/contracts";
const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const claim: k.KnowledgeValue = {
  type: "claim",
  text: "A fictional lamp was lit.",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "observation",
  limitations: ["Unverified fixture"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function setup() {
  const knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: claim,
  });
  const value: f.Plan = {
    title: "Fictional signal review",
    intakeCaseRef: null,
    basisClaimRefs: [knowledge.records[0]!.ref],
    questions: [
      {
        id: "time",
        parentId: null,
        text: "When was the lamp lit?",
        whyMaterial: "Distinguishes the alternative sequences",
        material: true,
        hypotheses: [
          {
            id: "early",
            explanation: "It was lit before the signal",
            claimRefs: [],
            contraryTest: "Seek a record showing the reverse sequence",
          },
        ],
        leads: [
          {
            id: "log",
            description: "Inspect a separately authorized fictional log",
          },
        ],
        stopCondition:
          "Pause if no authorized time source is available; remain unresolved",
      },
    ],
  };
  return {
    knowledge,
    state: f.createPlanningState(c),
    q: { id: "plan", expectedRevision: 0, value },
  };
}
const append = (x: ReturnType<typeof setup>) =>
  f.revisePlan(c, x.knowledge, x.state, x.q);
test("private question plan reuses actual Knowledge without promoting assertion or case status", () => {
  const x = setup(),
    s = append(x);
  assert.equal(s.records[0]!.visibility, "private");
  assert.equal(x.state.records.length, 0);
  assert.equal(
    (x.knowledge.records[0]!.value as { assessment: null }).assessment,
    null,
  );
  assert.equal(Object.hasOwn(s.records[0]!.value, "status"), false);
  assert.equal(f.inspectPlans(c, s).length, 1);
});
test("revisions retain exact predecessor, material questions and detached history", () => {
  const x = setup(),
    s = append(x),
    before = structuredClone(s);
  const value = structuredClone(x.q.value);
  (value.questions[0]!.hypotheses as f.Hypothesis[]).push({
    id: "later",
    explanation: "The reverse sequence",
    claimRefs: [],
    contraryTest: "Look for evidence of an earlier signal",
  });
  const next = f.revisePlan(c, x.knowledge, s, {
    ...x.q,
    expectedRevision: 1,
    value,
  });
  assert.deepEqual(next.records[1]!.supersedes, s.records[0]!.ref);
  assert.deepEqual(s, before);
  assert.throws(
    () => f.revisePlan(c, x.knowledge, next, { ...x.q, expectedRevision: 1 }),
    { code: "revision_conflict" },
  );
  const read = f.inspectPlans(c, next);
  Object.assign(read[0]!.value, { title: "Modified detached result" });
  assert.equal(next.records[0]!.value.title, x.q.value.title);
});
test("material questions cannot disappear or be demoted; case association is fixed", () => {
  const x = setup(),
    s = append(x);
  for (const value of [
    {
      ...x.q.value,
      questions: [{ ...x.q.value.questions[0]!, id: "replacement" }],
    },
    {
      ...x.q.value,
      questions: [{ ...x.q.value.questions[0]!, material: false }],
    },
  ])
    assert.throws(
      () =>
        f.revisePlan(c, x.knowledge, s, { ...x.q, expectedRevision: 1, value }),
      { code: "material_question_removed" },
    );
  assert.throws(
    () =>
      f.revisePlan(c, x.knowledge, s, {
        ...x.q,
        expectedRevision: 1,
        value: {
          ...x.q.value,
          intakeCaseRef: {
            tenantId: c.tenantId,
            projectId: c.projectId,
            kind: "case",
            id: "other",
            revision: 1,
          },
        },
      }),
    { code: "invalid_reference" },
  );
});
test("stale, missing and foreign claims reject; historical plan stays inspectable", () => {
  const x = setup(),
    s = append(x);
  const newer = k.reviseKnowledge(c, x.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: { ...claim, text: "Revised assertion" },
  });
  assert.throws(
    () => f.revisePlan(c, newer, s, { ...x.q, expectedRevision: 1 }),
    { code: "stale_claim" },
  );
  for (const ref of [
    { ...x.q.value.basisClaimRefs[0]!, id: "absent" },
    { ...x.q.value.basisClaimRefs[0]!, projectId: "foreign" },
  ])
    assert.throws(() =>
      f.revisePlan(c, x.knowledge, s, {
        ...x.q,
        expectedRevision: 1,
        value: { ...x.q.value, basisClaimRefs: [ref] },
      }),
    );
  assert.equal(f.inspectPlans(c, s).length, 1);
});
test("question tree and contrary route are explicit; closure/answer/evaluation injection rejects", () => {
  const x = setup();
  for (const patch of [
    { parentId: "time" },
    { parentId: "missing" },
    { hypotheses: [] },
    {
      hypotheses: [
        { ...x.q.value.questions[0]!.hypotheses[0]!, contraryTest: "" },
      ],
    },
    { answer: "verified" },
    { status: "closed" },
  ]) {
    const value = {
      ...x.q.value,
      questions: [{ ...x.q.value.questions[0]!, ...patch }],
    };
    assert.throws(() =>
      f.revisePlan(c, x.knowledge, x.state, { ...x.q, value }),
    );
  }
  const bad = { ...x.q.value, status: "closed" };
  assert.throws(() =>
    f.revisePlan(c, x.knowledge, x.state, { ...x.q, value: bad }),
  );
});
test("role/scope admission, exact profiles and tampered lineage fail closed", () => {
  const x = setup(),
    s = append(x);
  assert.throws(
    () => f.inspectPlans({ ...c, actor: { ...c.actor, roles: ["viewer"] } }, s),
    { code: "forbidden" },
  );
  assert.throws(() => f.inspectPlans({ ...c, projectId: "other" }, s), {
    code: "scope_denied",
  });
  for (const patch of [
    { visibility: "public" },
    { supersedes: s.records[0]!.ref },
    { createdAt: "2026-02-30T00:00:00Z" },
  ]) {
    const bad = structuredClone(s);
    Object.assign(bad.records[0]!, patch);
    assert.throws(() => f.assertPlanningState(bad));
  }
});
test("history capacity and UTF8 aggregate budget never evict older plans", () => {
  const x = setup(),
    s = append(x),
    r = s.records[0]!;
  const full: f.PlanningState = {
    ...s,
    records: Array.from({ length: 256 }, (_, i) => ({
      ...structuredClone(r),
      ref: { ...r.ref, revision: i + 1 },
      supersedes: i ? { ...r.ref, revision: i } : null,
    })),
  };
  f.assertPlanningState(full);
  assert.throws(
    () => f.revisePlan(c, x.knowledge, full, { ...x.q, expectedRevision: 256 }),
    { code: "invalid_plan" },
  );
  assert.equal(full.records.length, 256);
  const huge = structuredClone(full);
  for (const r of huge.records)
    Object.assign(r.value.questions[0]!, {
      text: "😀".repeat(2000),
      whyMaterial: "😀".repeat(2000),
    });
  assert.throws(() => f.assertPlanningState(huge), { code: "planning_full" });
});

test("ordered child questions and current hypothesis refs are captured without truth status", () => {
  const x = setup();
  const parent = x.q.value.questions[0]!;
  const child = {
    ...structuredClone(parent),
    id: "precision",
    parentId: parent.id,
    hypotheses: [
      { ...parent.hypotheses[0]!, claimRefs: [x.knowledge.records[0]!.ref] },
    ],
  };
  const value = { ...x.q.value, questions: [parent, child] };
  const s = f.revisePlan(c, x.knowledge, x.state, { ...x.q, value });
  assert.equal(s.records[0]!.value.questions[1]!.parentId, "time");
  const knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: claim,
  });
  assert.throws(
    () =>
      f.revisePlan(c, knowledge, s, {
        ...x.q,
        expectedRevision: 1,
        value: { ...value, basisClaimRefs: [] },
      }),
    { code: "stale_claim" },
  );
  assert.throws(
    () =>
      f.revisePlan(c, x.knowledge, x.state, {
        ...x.q,
        value: { ...value, questions: [child, parent] },
      }),
    { code: "invalid_tree" },
  );
});
