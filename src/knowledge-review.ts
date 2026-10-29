import { inspectKnowledge } from "@accountability/knowledge-verification";
import type {
  KnowledgeState,
  KnowledgeRevision,
} from "@accountability/knowledge-verification";
import {
  canonical,
  invariant,
  requireScope,
  validateRef,
} from "@accountability/knowledge-verification/contracts";
import type {
  Context,
  Ref,
} from "@accountability/knowledge-verification/contracts";
import { inspectPlans } from "./index.ts";
import type { PlanningState } from "./index.ts";

export type KnowledgeDependencyNode = Readonly<{
  ref: Ref;
  latestRef: Ref | null;
  status: "current-edition" | "changed-edition" | "missing-edition";
}>;
export type KnowledgeDependencyEdge = Readonly<{
  from: Ref;
  to: Ref;
  kind:
    | "claim-subject"
    | "event-entity"
    | "relationship-from"
    | "relationship-to";
}>;
export type PlanKnowledgeReview = Readonly<{
  schemaVersion: 1;
  visibility: "private";
  tenantId: string;
  projectId: string;
  plan: Ref;
  latestPlan: Ref;
  roots: readonly Ref[];
  nodes: readonly KnowledgeDependencyNode[];
  edges: readonly KnowledgeDependencyEdge[];
}>;
const logicalKey = (r: Ref) => canonical([r.kind, r.id]);
const exactKey = (r: Ref) => canonical(r);
function children(r: KnowledgeRevision): readonly KnowledgeDependencyEdge[] {
  const v = r.value;
  if (v.type === "entity") return [];
  if (v.type === "claim")
    return v.subjectRefs.map((to) => ({
      from: r.ref,
      to,
      kind: "claim-subject",
    }));
  if (v.type === "event")
    return v.entityRefs.map((to) => ({
      from: r.ref,
      to,
      kind: "event-entity",
    }));
  return [
    { from: r.ref, to: v.from, kind: "relationship-from" },
    { from: r.ref, to: v.to, kind: "relationship-to" },
  ];
}
/** Snapshot edition comparison only. No authentication, source/permission proof, mutation or closure. */
export function reviewPlanKnowledge(
  context: Context,
  knowledge: KnowledgeState,
  planning: PlanningState,
  selectedPlan: Ref,
): PlanKnowledgeReview {
  const c = structuredClone(context),
    selected = structuredClone(selectedPlan);
  validateRef(selected);
  requireScope(c, selected);
  invariant(
    selected.kind === "investigation-plan",
    "invalid_reference",
    "Exact plan edition required",
  );
  // Actual owning public validators authorize and detach both supplied histories.
  const plans = inspectPlans(c, planning),
    records = inspectKnowledge(c, knowledge);
  const plan = plans.find((r) => exactKey(r.ref) === exactKey(selected));
  invariant(plan, "missing_reference", "Selected plan edition missing");
  const latestPlan = plans.filter((r) => r.ref.id === selected.id).at(-1)!.ref;
  const byEdition = new Map(records.map((r) => [exactKey(r.ref), r]));
  const latest = new Map<string, Ref>();
  for (const r of records) latest.set(logicalKey(r.ref), r.ref);
  const nodes = new Map<string, KnowledgeDependencyNode>();
  const queue: Ref[] = [],
    roots: Ref[] = [],
    edges: KnowledgeDependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  function visit(ref: Ref) {
    const key = exactKey(ref);
    if (nodes.has(key)) return;
    invariant(
      nodes.size < 256,
      "review_full",
      "Knowledge review node budget exceeded",
    );
    const found = byEdition.get(key),
      latestRef = latest.get(logicalKey(ref)) ?? null;
    nodes.set(key, {
      ref,
      latestRef,
      status: !found
        ? "missing-edition"
        : exactKey(latestRef!) === key
          ? "current-edition"
          : "changed-edition",
    });
    queue.push(ref);
  }
  const rootKeys = new Set<string>();
  const addRoot = (ref: Ref) => {
    const key = exactKey(ref);
    if (rootKeys.has(key)) return;
    rootKeys.add(key);
    roots.push(ref);
    visit(ref);
  };
  for (const ref of plan.value.basisClaimRefs) addRoot(ref);
  for (const question of plan.value.questions)
    for (const hypothesis of question.hypotheses)
      for (const ref of hypothesis.claimRefs) addRoot(ref);
  // Follow captured editions only, never substitute the latest record's children.
  // Each edition is visited once; every distinct captured edge is preserved.
  for (let i = 0; i < queue.length; i++) {
    const record = byEdition.get(exactKey(queue[i]!));
    if (!record) continue;
    for (const edge of children(record)) {
      const key = canonical(edge);
      if (edgeKeys.has(key)) continue;
      invariant(
        edges.length < 512,
        "review_full",
        "Knowledge review edge budget exceeded",
      );
      edgeKeys.add(key);
      edges.push(edge);
      visit(edge.to);
    }
  }
  return structuredClone({
    schemaVersion: 1,
    visibility: "private",
    tenantId: c.tenantId,
    projectId: c.projectId,
    plan: selected,
    latestPlan,
    roots,
    nodes: [...nodes.values()],
    edges,
  });
}
