import { inspectKnowledge } from "@accountability/knowledge-verification";
import type { KnowledgeState } from "@accountability/knowledge-verification";
import {
  canonical,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Ref,
  Scope,
} from "@accountability/knowledge-verification/contracts";
export type Hypothesis = Readonly<{
  id: string;
  explanation: string;
  claimRefs: readonly Ref[];
  contraryTest: string;
}>;
export type Question = Readonly<{
  id: string;
  parentId: string | null;
  text: string;
  whyMaterial: string;
  material: boolean;
  hypotheses: readonly Hypothesis[];
  leads: readonly Readonly<{ id: string; description: string }>[];
  stopCondition: string;
}>;
export type Plan = Readonly<{
  title: string;
  intakeCaseRef: Ref | null;
  basisClaimRefs: readonly Ref[];
  questions: readonly Question[];
}>;
export type PlanRevision = Readonly<{
  ref: Ref;
  supersedes: Ref | null;
  visibility: "private";
  actorId: string;
  actorKind: Context["actor"]["kind"];
  createdAt: string;
  requestId: string;
  purpose: string;
  value: Plan;
}>;
export type PlanningState = Scope &
  Readonly<{
    schemaVersion: 1;
    visibility: "private";
    records: readonly PlanRevision[];
  }>;
function exact(v: unknown, keys: readonly string[]) {
  invariant(
    v !== null &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "invalid_plan",
    "Exact plain fields required",
  );
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function authorize(c: Context, s: Scope) {
  inspectKnowledge(c, {
    tenantId: s.tenantId,
    projectId: s.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  });
}
function reference(r: Ref, s: Scope, kind: string) {
  validateRef(r);
  requireScope(s, r);
  nonempty(r.id, "Reference", 128);
  invariant(
    r.kind === kind,
    "invalid_reference",
    "Exact typed reference required",
  );
}
function claims(refs: readonly Ref[], s: Scope) {
  invariant(
    Array.isArray(refs) && refs.length <= 64,
    "invalid_plan",
    "Bounded claim references required",
  );
  const seen = new Set<string>();
  for (const r of refs) {
    reference(r, s, "claim");
    invariant(
      !seen.has(canonical(r)),
      "duplicate",
      "Distinct claim editions required",
    );
    seen.add(canonical(r));
  }
}
function plan(p: Plan, s: Scope) {
  exact(p, ["title", "intakeCaseRef", "basisClaimRefs", "questions"]);
  nonempty(p.title, "Title", 500);
  if (p.intakeCaseRef !== null) reference(p.intakeCaseRef, s, "case");
  claims(p.basisClaimRefs, s);
  invariant(
    Array.isArray(p.questions) &&
      p.questions.length >= 1 &&
      p.questions.length <= 64,
    "invalid_plan",
    "One to64 explicit questions required",
  );
  const ids = new Set<string>();
  for (const q of p.questions) {
    exact(q, [
      "id",
      "parentId",
      "text",
      "whyMaterial",
      "material",
      "hypotheses",
      "leads",
      "stopCondition",
    ]);
    nonempty(q.id, "Question", 128);
    invariant(
      !ids.has(q.id) && (q.parentId === null || ids.has(q.parentId)),
      "invalid_tree",
      "Unique question IDs and earlier parents required",
    );
    ids.add(q.id);
    nonempty(q.text, "Question", 4000);
    nonempty(q.whyMaterial, "Materiality rationale", 4000);
    nonempty(q.stopCondition, "Stop condition", 4000);
    invariant(
      typeof q.material === "boolean",
      "invalid_plan",
      "Explicit materiality required",
    );
    invariant(
      Array.isArray(q.hypotheses) &&
        q.hypotheses.length >= 1 &&
        q.hypotheses.length <= 16 &&
        Array.isArray(q.leads) &&
        q.leads.length <= 32,
      "invalid_plan",
      "Bounded hypotheses/leads required",
    );
    const hs = new Set<string>(),
      ls = new Set<string>();
    for (const h of q.hypotheses) {
      exact(h, ["id", "explanation", "claimRefs", "contraryTest"]);
      nonempty(h.id, "Hypothesis", 128);
      invariant(!hs.has(h.id), "duplicate", "Distinct hypotheses required");
      hs.add(h.id);
      nonempty(h.explanation, "Explanation", 4000);
      nonempty(h.contraryTest, "Contrary testing route", 4000);
      claims(h.claimRefs, s);
    }
    for (const l of q.leads) {
      exact(l, ["id", "description"]);
      nonempty(l.id, "Lead", 128);
      invariant(!ls.has(l.id), "duplicate", "Distinct leads required");
      ls.add(l.id);
      nonempty(l.description, "Lead", 4000);
    }
  }
}
/** Serialized planning only; histories and references are not authentication or evaluated findings. */
export function assertPlanningState(s: PlanningState): void {
  exact(s, ["tenantId", "projectId", "schemaVersion", "visibility", "records"]);
  nonempty(s.tenantId, "Tenant", 128);
  nonempty(s.projectId, "Project", 128);
  invariant(
    s.schemaVersion === 1 &&
      s.visibility === "private" &&
      Array.isArray(s.records) &&
      s.records.length <= 256,
    "invalid_plan",
    "Bounded private history required",
  );
  invariant(
    Buffer.byteLength(canonical(s)) <= 2 * 1024 * 1024,
    "planning_full",
    "Planning byte budget exceeded",
  );
  const latest = new Map<string, PlanRevision>();
  for (const r of s.records) {
    exact(r, [
      "ref",
      "supersedes",
      "visibility",
      "actorId",
      "actorKind",
      "createdAt",
      "requestId",
      "purpose",
      "value",
    ]);
    reference(r.ref, s, "investigation-plan");
    invariant(
      r.visibility === "private",
      "invalid_plan",
      "Private record required",
    );
    authorize(
      {
        tenantId: s.tenantId,
        projectId: s.projectId,
        actor: { id: r.actorId, kind: r.actorKind, roles: ["researcher"] },
        now: r.createdAt,
        requestId: r.requestId,
        purpose: r.purpose,
      },
      s,
    );
    const old = latest.get(r.ref.id);
    invariant(
      r.ref.revision === (old?.ref.revision ?? 0) + 1 &&
        (old ? same(r.supersedes, old.ref) : r.supersedes === null),
      "invalid_revision",
      "Exact contiguous predecessor required",
    );
    plan(r.value, s);
    if (old) {
      invariant(
        same(r.value.intakeCaseRef, old.value.intakeCaseRef),
        "invalid_reference",
        "Plan cannot move to another intake case",
      );
      for (const q of old.value.questions)
        if (q.material)
          invariant(
            r.value.questions.some((n: Question) => n.id === q.id && n.material),
            "material_question_removed",
            "Material questions cannot silently disappear or lose materiality",
          );
    }
    latest.set(r.ref.id, r);
  }
}
export function createPlanningState(context: Context): PlanningState {
  const c = structuredClone(context);
  authorize(c, c);
  return {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  };
}
export function revisePlan(
  context: Context,
  knowledge: KnowledgeState,
  state: PlanningState,
  command: Readonly<{ id: string; expectedRevision: number; value: Plan }>,
): PlanningState {
  const c = structuredClone(context),
    s = structuredClone(state),
    q = structuredClone(command);
  authorize(c, s);
  assertPlanningState(s);
  exact(q, ["id", "expectedRevision", "value"]);
  nonempty(q.id, "Plan", 128);
  invariant(
    Number.isSafeInteger(q.expectedRevision) &&
      q.expectedRevision >= 0 &&
      q.expectedRevision < Number.MAX_SAFE_INTEGER,
    "invalid_revision",
    "Safe expected revision required",
  );
  plan(q.value, s);
  const records = inspectKnowledge(c, knowledge);
  const refs = [
    ...q.value.basisClaimRefs,
    ...q.value.questions.flatMap((x) =>
      x.hypotheses.flatMap((h) => h.claimRefs),
    ),
  ];
  for (const r of refs) {
    invariant(
      records.some((x) => same(x.ref, r)),
      "missing_reference",
      "Exact Knowledge claim missing",
    );
    invariant(
      !records.some(
        (x) =>
          x.ref.kind === "claim" &&
          x.ref.id === r.id &&
          x.ref.revision > r.revision,
      ),
      "stale_claim",
      "Select current Knowledge claim edition",
    );
  }
  const old = s.records.filter((r) => r.ref.id === q.id).at(-1);
  invariant(
    (old?.ref.revision ?? 0) === q.expectedRevision,
    "revision_conflict",
    "Plan edition changed",
  );
  const r: PlanRevision = {
    ref: {
      tenantId: s.tenantId,
      projectId: s.projectId,
      kind: "investigation-plan",
      id: q.id,
      revision: q.expectedRevision + 1,
    },
    supersedes: old?.ref ?? null,
    visibility: "private",
    actorId: c.actor.id,
    actorKind: c.actor.kind,
    createdAt: c.now,
    requestId: c.requestId,
    purpose: c.purpose,
    value: q.value,
  };
  const next: PlanningState = { ...s, records: [...s.records, r] };
  assertPlanningState(next);
  return next;
}
export function inspectPlans(
  context: Context,
  state: PlanningState,
): readonly PlanRevision[] {
  const c = structuredClone(context),
    s = structuredClone(state);
  authorize(c, s);
  assertPlanningState(s);
  return s.records;
}
