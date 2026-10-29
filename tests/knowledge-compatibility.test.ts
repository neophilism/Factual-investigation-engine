import test from "node:test";
import assert from "node:assert/strict";
import * as k from "@accountability/knowledge-verification";
import type {
  Context,
  Ref,
} from "@accountability/knowledge-verification/contracts";
import * as f from "../src/index.ts";
import * as e from "../src/efforts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  purpose: "private-review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
function setup() {
  let knowledge = k.createKnowledgeState(c);
  const add = (id: string, value: k.KnowledgeValue) => {
    knowledge = k.reviseKnowledge(c, knowledge, {
      id,
      expectedRevision: 0,
      value,
    });
    return knowledge.records.at(-1)!.ref;
  };
  const person = add("person", {
    type: "entity",
    label: "Fictional person",
    category: "person",
    description: "Identity unresolved",
  });
  const event = add("meeting", {
    type: "event",
    label: "Fictional meeting",
    description: "Unverified",
    entityRefs: [],
    time: { earliest: null, latest: null },
  });
  const roleValue: Extract<k.KnowledgeValue, { type: "relationship" }> = {
    type: "relationship",
    relationshipType: "role_assertion",
    label: "Reported attendee",
    from: person,
    to: event,
    time: { earliest: null, latest: null },
    limitations: ["Unverified fixture"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  const role = add("attendance", roleValue);
  const claimValue: Extract<k.KnowledgeValue, { type: "claim" }> = {
    type: "claim",
    text: "A fictional account reports attendance.",
    subjectRefs: [role],
    time: { earliest: null, latest: null },
    accountType: "attributed_testimony",
    limitations: ["Not independently verified"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  const claim = add("account", claimValue);
  const value: f.Plan = {
    title: "Review reported attendance",
    intakeCaseRef: null,
    basisClaimRefs: [claim],
    questions: [
      {
        id: "attendance",
        parentId: null,
        text: "Was attendance recorded?",
        material: true,
        whyMaterial: "The role is unresolved",
        hypotheses: [
          {
            id: "reported",
            explanation: "Reported attendance",
            claimRefs: [claim],
            contraryTest: "Seek an independently authorized record of absence",
          },
        ],
        leads: [
          {
            id: "record",
            description: "Inspect a separately authorized fictional record",
          },
        ],
        stopCondition: "Remain unresolved if no authorized record exists",
      },
    ],
  };
  const plans = f.revisePlan(c, knowledge, f.createPlanningState(c), {
    id: "plan",
    expectedRevision: 0,
    value,
  });
  return { knowledge, role, roleValue, claim, claimValue, value, plans };
}
function withClaims(value: f.Plan, ref: Ref): f.Plan {
  return {
    ...value,
    basisClaimRefs: [ref],
    questions: value.questions.map((q) => ({
      ...q,
      hypotheses: q.hypotheses.map((h) => ({ ...h, claimRefs: [ref] })),
    })),
  };
}
test("accepted Knowledge relationships pass actual planning without truth promotion or input rewrites", () => {
  const x = setup(),
    before = structuredClone(x.knowledge);
  const view = f.inspectPlans(c, x.plans);
  assert.deepEqual(view[0]!.value.basisClaimRefs, [x.claim]);
  assert.deepEqual(view[0]!.value.questions[0]!.hypotheses[0]!.claimRefs, [
    x.claim,
  ]);
  assert.deepEqual(k.inspectKnowledge(c, x.knowledge), before.records);
  for (const r of before.records) {
    if (r.value.type !== "claim" && r.value.type !== "relationship") continue;
    assert.equal(r.value.assessment, null);
    assert.equal(r.value.proceduralPosture, null);
    assert.equal(r.value.editorialApproval, null);
  }
  Object.assign(view[0]!.value, { title: "Detached" });
  assert.equal(x.plans.records[0]!.value.title, x.value.title);
  assert.equal(Object.hasOwn(x.plans.records[0]!.value, "answer"), false);
});
test("relationship revisions retain old claim subjects; claim-current checks are not transitive freshness", () => {
  const x = setup();
  const changed = k.reviseKnowledge(c, x.knowledge, {
    id: x.role.id,
    expectedRevision: 1,
    value: { ...x.roleValue, label: "Revised reported role" },
  });
  const plans = f.revisePlan(c, changed, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: x.value,
  });
  assert.equal(plans.records.length, 2);
  const claim = changed.records.find((r) => r.ref.id === x.claim.id)!;
  assert.deepEqual((claim.value as typeof x.claimValue).subjectRefs, [x.role]);
  assert.equal(changed.records.at(-1)!.ref.revision, 2);
  assert.deepEqual(f.inspectPlans(c, plans)[0]!.value.basisClaimRefs, [
    x.claim,
  ]);
});
test("explicit claim revision binds new relationship; stale basis and hypothesis refs deny separately", () => {
  const x = setup();
  let changed = k.reviseKnowledge(c, x.knowledge, {
    id: x.role.id,
    expectedRevision: 1,
    value: x.roleValue,
  });
  changed = k.reviseKnowledge(c, changed, {
    id: x.claim.id,
    expectedRevision: 1,
    value: { ...x.claimValue, subjectRefs: [changed.records.at(-1)!.ref] },
  });
  const current = changed.records.at(-1)!.ref;
  const nextValue = withClaims(x.value, current);
  for (const value of [
    { ...nextValue, basisClaimRefs: [x.claim] },
    { ...x.value, basisClaimRefs: [current] },
  ])
    assert.throws(
      () =>
        f.revisePlan(c, changed, x.plans, {
          id: "plan",
          expectedRevision: 1,
          value,
        }),
      { code: "stale_claim" },
    );
  const plans = f.revisePlan(c, changed, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: nextValue,
  });
  assert.deepEqual(plans.records[1]!.supersedes, x.plans.records[0]!.ref);
  assert.deepEqual(plans.records[0]!.value.basisClaimRefs, [x.claim]);
  assert.deepEqual(plans.records[1]!.value.basisClaimRefs, [current]);
});
test("relationship records never substitute for typed claims; forged tracks or foreign endpoints deny", () => {
  const x = setup();
  assert.throws(
    () =>
      f.revisePlan(c, x.knowledge, x.plans, {
        id: "plan",
        expectedRevision: 1,
        value: withClaims(x.value, x.role),
      }),
    { code: "invalid_reference" },
  );
  for (const patch of [
    { assessment: "verified" },
    { from: { ...x.roleValue.from, projectId: "foreign" } },
  ]) {
    const bad = structuredClone(x.knowledge);
    Object.assign(bad.records[2]!.value, patch);
    assert.throws(() =>
      f.revisePlan(c, bad, x.plans, {
        id: "plan",
        expectedRevision: 1,
        value: x.value,
      }),
    );
  }
  assert.equal(x.plans.records.length, 1);
});
test("relationship-backed plan effort corrections retain exact historical plan and claim editions", () => {
  const x = setup();
  const input: e.EffortInput = {
    id: "attempt",
    expectedSequence: 0,
    plan: x.plans.records[0]!.ref,
    questionId: "attendance",
    leadId: "record",
    outcome: "unavailable",
    detail: "Synthetic record unavailable",
    corrects: null,
  };
  const efforts = e.recordEffort(c, x.plans, e.createEffortState(c), input);
  const knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: x.claim.id,
    expectedRevision: 1,
    value: x.claimValue,
  });
  const current = knowledge.records.at(-1)!.ref;
  const plans = f.revisePlan(c, knowledge, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: withClaims(x.value, current),
  });
  assert.throws(
    () =>
      e.recordEffort(c, plans, efforts, {
        ...input,
        id: "old-new",
        expectedSequence: 1,
      }),
    { code: "stale_plan" },
  );
  const corrected = e.recordEffort(c, plans, efforts, {
    ...input,
    id: "correction",
    expectedSequence: 1,
    corrects: efforts.records[0]!.ref,
    detail: "Corrected unresolved description",
  });
  assert.deepEqual(
    e.inspectEfforts(c, corrected).effective[0]!.plan,
    x.plans.records[0]!.ref,
  );
  assert.deepEqual(f.inspectPlans(c, plans)[0]!.value.basisClaimRefs, [
    x.claim,
  ]);
  assert.deepEqual(f.inspectPlans(c, plans)[1]!.value.basisClaimRefs, [
    current,
  ]);
  assert.equal(Object.hasOwn(corrected.records[1]!, "answer"), false);
});
