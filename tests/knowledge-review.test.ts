import test from "node:test";
import assert from "node:assert/strict";
import * as k from "@accountability/knowledge-verification";
import type {
  Context,
  Ref,
} from "@accountability/knowledge-verification/contracts";
import * as f from "../src/index.ts";
import { reviewPlanKnowledge } from "../src/knowledge-review.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  purpose: "private-review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  now: "2026-01-01T00:00:00Z",
  requestId: "r",
};
const entity: k.KnowledgeValue = {
  type: "entity",
  label: "Fictional person",
  description: "Unresolved",
  category: "person",
};
const claimValue: Extract<k.KnowledgeValue, { type: "claim" }> = {
  type: "claim",
  text: "Unverified fictional account",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "attributed_testimony",
  limitations: ["Unverified"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function planValue(refs: readonly Ref[]): f.Plan {
  return {
    title: "Fictional review",
    intakeCaseRef: null,
    basisClaimRefs: refs,
    questions: [
      {
        id: "q",
        parentId: null,
        text: "What can be established?",
        whyMaterial: "Account unresolved",
        material: true,
        hypotheses: [
          {
            id: "h",
            explanation: "A fictional account",
            claimRefs: refs,
            contraryTest: "Seek an authorized contrary account",
          },
        ],
        leads: [],
        stopCondition: "Remain unresolved if no authorized evidence",
      },
    ],
  };
}
function setup() {
  let knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "person",
    expectedRevision: 0,
    value: entity,
  });
  const person = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "event",
    expectedRevision: 0,
    value: {
      type: "event",
      label: "Fictional meeting",
      description: "Unverified fixture",
      entityRefs: [person],
      time: { earliest: null, latest: null },
    },
  });
  const event = knowledge.records.at(-1)!.ref;
  const roleValue: Extract<k.KnowledgeValue, { type: "relationship" }> = {
    type: "relationship",
    relationshipType: "role_assertion",
    label: "Reported attendee",
    from: person,
    to: event,
    time: { earliest: null, latest: null },
    limitations: ["Unverified"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "role",
    expectedRevision: 0,
    value: roleValue,
  });
  const role = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "claim",
    expectedRevision: 0,
    value: { ...claimValue, subjectRefs: [role] },
  });
  const claim = knowledge.records.at(-1)!.ref,
    value = planValue([claim]);
  const plans = f.revisePlan(c, knowledge, f.createPlanningState(c), {
    id: "plan",
    expectedRevision: 0,
    value,
  });
  return {
    knowledge,
    plans,
    selected: plans.records[0]!.ref,
    person,
    event,
    role,
    roleValue,
    claim,
    value,
  };
}
test("exact captured Knowledge graph is private, deduplicated, detached and does not assert truth", () => {
  const x = setup(),
    before = structuredClone(x);
  const r = reviewPlanKnowledge(c, x.knowledge, x.plans, x.selected);
  assert.equal(r.visibility, "private");
  assert.deepEqual(r.roots, [x.claim]);
  assert.deepEqual(
    r.nodes.map((n) => n.ref),
    [x.claim, x.role, x.person, x.event],
  );
  assert(r.nodes.every((n) => n.status === "current-edition"));
  assert.deepEqual(
    r.edges.map((e) => e.kind),
    ["claim-subject", "relationship-from", "relationship-to", "event-entity"],
  );
  assert.equal(Object.hasOwn(r, "verified"), false);
  assert.equal(Object.hasOwn(r, "allowed"), false);
  Object.assign(r.nodes[0]!.ref, { id: "detached" });
  assert.deepEqual(x, before);
});
test("changed relationship and endpoint editions remain visible even when plan claim is current", () => {
  const x = setup();
  let knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "person",
    expectedRevision: 1,
    value: entity,
  });
  const currentPerson = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "role",
    expectedRevision: 1,
    value: { ...x.roleValue, from: currentPerson },
  });
  const currentRole = knowledge.records.at(-1)!.ref;
  const r = reviewPlanKnowledge(c, knowledge, x.plans, x.selected);
  assert.equal(r.nodes[0]!.status, "current-edition");
  assert.deepEqual(
    r.nodes.find((n) => n.ref.kind === "relationship"),
    { ref: x.role, latestRef: currentRole, status: "changed-edition" },
  );
  assert.deepEqual(
    r.nodes.find((n) => n.ref.kind === "entity"),
    { ref: x.person, latestRef: currentPerson, status: "changed-edition" },
  );
  assert.deepEqual(
    r.edges.find((e) => e.kind === "relationship-from")!.to,
    x.person,
  );
  assert(!r.nodes.some((n) => n.ref.kind === "entity" && n.ref.revision === 2));
});
test("stale and missing exact claim editions are observations; latest children are never substituted", () => {
  const x = setup();
  const changed = k.reviseKnowledge(c, x.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: claimValue,
  });
  const current = changed.records.at(-1)!.ref;
  const old = reviewPlanKnowledge(c, changed, x.plans, x.selected);
  assert.deepEqual(old.nodes[0], {
    ref: x.claim,
    latestRef: current,
    status: "changed-edition",
  });
  assert.equal(old.edges[0]!.kind, "claim-subject");
  const absent = reviewPlanKnowledge(
    c,
    k.createKnowledgeState(c),
    x.plans,
    x.selected,
  );
  assert.deepEqual(absent.nodes, [
    { ref: x.claim, latestRef: null, status: "missing-edition" },
  ]);
  assert.deepEqual(absent.edges, []);
  // A valid partial snapshot with claim revision1 does not prove revision2 exists.
  const plans = f.revisePlan(c, changed, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: planValue([current]),
  });
  const missingEdition = reviewPlanKnowledge(
    c,
    x.knowledge,
    plans,
    plans.records[1]!.ref,
  );
  assert.deepEqual(missingEdition.nodes, [
    { ref: current, latestRef: x.claim, status: "missing-edition" },
  ]);
  assert.deepEqual(missingEdition.edges, []);
});
test("explicit plan selection exposes both selected and latest plan; unrelated records do not join graph", () => {
  const x = setup();
  const knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "unrelated",
    expectedRevision: 0,
    value: entity,
  });
  const plans = f.revisePlan(c, knowledge, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: { ...x.value, title: "Updated title" },
  });
  const old = reviewPlanKnowledge(c, knowledge, plans, x.selected);
  assert.deepEqual(old.plan, x.selected);
  assert.deepEqual(old.latestPlan, plans.records[1]!.ref);
  assert(!old.nodes.some((n) => n.ref.id === "unrelated"));
  assert.throws(
    () =>
      reviewPlanKnowledge(c, knowledge, plans, { ...x.selected, revision: 3 }),
    { code: "missing_reference" },
  );
  const empty = f.revisePlan(c, knowledge, plans, {
    id: "empty",
    expectedRevision: 0,
    value: planValue([]),
  });
  const r = reviewPlanKnowledge(c, knowledge, empty, empty.records.at(-1)!.ref);
  assert.deepEqual([r.roots, r.nodes, r.edges], [[], [], []]);
});
test("actual owning validators reject wrong scope roles types and hostile snapshots without mutation", () => {
  const x = setup();
  assert.throws(
    () =>
      reviewPlanKnowledge(
        { ...c, actor: { ...c.actor, roles: ["viewer"] } },
        x.knowledge,
        x.plans,
        x.selected,
      ),
    { code: "forbidden" },
  );
  assert.throws(
    () =>
      reviewPlanKnowledge(c, x.knowledge, x.plans, {
        ...x.selected,
        projectId: "foreign",
      }),
    { code: "scope_denied" },
  );
  assert.throws(() => reviewPlanKnowledge(c, x.knowledge, x.plans, x.claim), {
    code: "invalid_reference",
  });
  assert.throws(() =>
    reviewPlanKnowledge(
      c,
      { ...x.knowledge, projectId: "foreign" },
      x.plans,
      x.selected,
    ),
  );
  for (const patch of [
    { assessment: "verified" },
    { from: { ...x.person, projectId: "foreign" } },
  ]) {
    const bad = structuredClone(x.knowledge);
    Object.assign(bad.records[2]!.value, patch);
    assert.throws(() => reviewPlanKnowledge(c, bad, x.plans, x.selected));
  }
  assert.equal(x.plans.records.length, 1);
});
function large(entities: number, eventWidths: readonly number[]) {
  const x = setup(),
    template = x.knowledge.records[0]!;
  const records: k.KnowledgeRevision[] = Array.from(
    { length: entities },
    (_, i) => ({
      ...structuredClone(template),
      ref: { ...template.ref, id: "entity-" + i },
    }),
  );
  const eventRefs: Ref[] = [];
  for (let i = 0; i < eventWidths.length; i++) {
    const ref = { ...template.ref, kind: "event", id: "event-" + i };
    const start = entities > 128 ? i * 128 : 0;
    records.push({
      ...structuredClone(template),
      ref,
      value: {
        type: "event",
        label: "Fictional event",
        description: "Unverified",
        time: { earliest: null, latest: null },
        entityRefs: records
          .slice(start, start + eventWidths[i]!)
          .map((r) => r.ref),
      },
    });
    eventRefs.push(ref);
  }
  const claimRef = { ...template.ref, kind: "claim", id: "large-claim" };
  records.push({
    ...structuredClone(template),
    ref: claimRef,
    value: { ...claimValue, subjectRefs: eventRefs },
  });
  const knowledge: k.KnowledgeState = { ...x.knowledge, records };
  k.assertKnowledgeState(knowledge);
  const plans = f.revisePlan(c, knowledge, f.createPlanningState(c), {
    id: "large",
    expectedRevision: 0,
    value: planValue([claimRef]),
  });
  return { knowledge, plans, selected: plans.records[0]!.ref };
}
test("exact256 node budget accepts full report and denies257 without partial output or eviction", () => {
  const full = large(253, [128, 125]);
  const report = reviewPlanKnowledge(
    c,
    full.knowledge,
    full.plans,
    full.selected,
  );
  assert.equal(report.nodes.length, 256);
  const over = large(254, [128, 126]),
    before = structuredClone(over);
  assert.throws(
    () => reviewPlanKnowledge(c, over.knowledge, over.plans, over.selected),
    { code: "review_full" },
  );
  assert.deepEqual(over, before);
});
test("edge budget is independent from deduplicated node count and refuses oversized shared graphs", () => {
  const full = large(127, [127, 127, 127, 127]);
  assert.equal(
    reviewPlanKnowledge(c, full.knowledge, full.plans, full.selected).edges
      .length,
    512,
  );
  const over = large(128, [128, 128, 128, 128]);
  assert.throws(
    () => reviewPlanKnowledge(c, over.knowledge, over.plans, over.selected),
    { code: "review_full" },
  );
});

test("hypothesis-only roots and multiple captured editions retain each path without logical-ID collapse", () => {
  const x = setup();
  let knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "person",
    expectedRevision: 1,
    value: entity,
  });
  const person2 = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "role",
    expectedRevision: 1,
    value: { ...x.roleValue, from: person2 },
  });
  const role2 = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "second",
    expectedRevision: 0,
    value: { ...claimValue, subjectRefs: [role2] },
  });
  const second = knowledge.records.at(-1)!.ref;
  const value: f.Plan = {
    ...x.value,
    questions: x.value.questions.map((q) => ({
      ...q,
      hypotheses: q.hypotheses.map((h) => ({ ...h, claimRefs: [second] })),
    })),
  };
  const plans = f.revisePlan(c, knowledge, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value,
  });
  const report = reviewPlanKnowledge(
    c,
    knowledge,
    plans,
    plans.records.at(-1)!.ref,
  );
  assert.deepEqual(report.roots, [x.claim, second]);
  assert.equal(report.nodes.length, 7);
  assert.deepEqual(
    report.nodes
      .filter((n) => n.ref.kind === "relationship")
      .map((n) => [n.ref.revision, n.status]),
    [
      [1, "changed-edition"],
      [2, "current-edition"],
    ],
  );
  assert.deepEqual(
    report.edges
      .filter((e) => e.kind === "relationship-from")
      .map((e) => [e.from, e.to]),
    [
      [x.role, x.person],
      [role2, person2],
    ],
  );
  assert.equal(report.edges.filter((e) => e.kind === "event-entity").length, 1);
  assert.equal(report.nodes.filter((n) => n.ref.kind === "entity").length, 2);
});

test("snapshot comparison never expands an unrelated latest-role subtree or synthesizes event time", () => {
  const x = setup();
  let knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "new-person",
    expectedRevision: 0,
    value: entity,
  });
  const newPerson = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "role",
    expectedRevision: 1,
    value: {
      ...x.roleValue,
      from: newPerson,
      time: { earliest: "2026-01-01T00:00:00Z", latest: null },
    },
  });
  const before = structuredClone(knowledge);
  const report = reviewPlanKnowledge(c, knowledge, x.plans, x.selected);
  assert(!report.nodes.some((n) => n.ref.id === newPerson.id));
  assert.deepEqual(
    report.edges.find((e) => e.kind === "relationship-from")!.to,
    x.person,
  );
  assert(
    report.nodes.every(
      (n) => !Object.hasOwn(n, "time") && !Object.hasOwn(n, "actorId"),
    ),
  );
  assert.deepEqual(knowledge, before);
  assert.deepEqual((knowledge.records[2]!.value as typeof x.roleValue).time, {
    earliest: null,
    latest: null,
  });
});
