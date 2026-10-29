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
import { inspectPlans } from "./index.ts";
import type { PlanningState } from "./index.ts";
export type EffortInput = Readonly<{
  id: string;
  expectedSequence: number;
  plan: Ref;
  questionId: string;
  leadId: string | null;
  outcome: "attempted" | "unavailable" | "exhausted";
  detail: string;
  corrects: Ref | null;
}>;
export type EffortRecord = Omit<EffortInput, "id" | "expectedSequence"> &
  Readonly<{
    ref: Ref;
    sequence: number;
    visibility: "private";
    actorId: string;
    actorKind: Context["actor"]["kind"];
    createdAt: string;
    requestId: string;
    purpose: string;
  }>;
export type EffortState = Scope &
  Readonly<{
    schemaVersion: 1;
    visibility: "private";
    records: readonly EffortRecord[];
  }>;
function exact(v: unknown, keys: readonly string[]) {
  invariant(
    v !== null &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "invalid_effort",
    "Exact plain fields required",
  );
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function authorize(c: Context, s: Scope) {
  inspectPlans(c, {
    tenantId: s.tenantId,
    projectId: s.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  });
}
function ref(r: Ref, s: Scope, kind: string) {
  validateRef(r);
  requireScope(s, r);
  nonempty(r.id, "Reference", 128);
  invariant(
    r.kind === kind,
    "invalid_reference",
    "Exact typed reference required",
  );
}
function profile(
  r: Pick<
    EffortRecord,
    "plan" | "questionId" | "leadId" | "outcome" | "detail" | "corrects"
  >,
  s: Scope,
) {
  ref(r.plan, s, "investigation-plan");
  nonempty(r.questionId, "Question", 128);
  if (r.leadId !== null) nonempty(r.leadId, "Lead", 128);
  nonempty(r.detail, "Effort detail", 4000);
  invariant(
    ["attempted", "unavailable", "exhausted"].includes(r.outcome),
    "invalid_effort",
    "Literal unresolved effort outcome required",
  );
  if (r.corrects !== null) ref(r.corrects, s, "investigation-effort");
}
/** Captured private history only; metadata and outcomes are host assertions, not proof of research. */
export function assertEffortState(s: EffortState): void {
  exact(s, ["tenantId", "projectId", "schemaVersion", "visibility", "records"]);
  nonempty(s.tenantId, "Tenant", 128);
  nonempty(s.projectId, "Project", 128);
  invariant(
    s.schemaVersion === 1 &&
      s.visibility === "private" &&
      Array.isArray(s.records) &&
      s.records.length <= 512,
    "invalid_effort",
    "Bounded private effort history required",
  );
  invariant(
    Buffer.byteLength(canonical(s)) <= 2 * 1024 * 1024,
    "efforts_full",
    "Effort history byte budget exceeded",
  );
  const ids = new Set<string>(),
    corrected = new Set<string>();
  for (const [i, r] of s.records.entries()) {
    exact(r, [
      "ref",
      "sequence",
      "plan",
      "questionId",
      "leadId",
      "outcome",
      "detail",
      "corrects",
      "visibility",
      "actorId",
      "actorKind",
      "createdAt",
      "requestId",
      "purpose",
    ]);
    ref(r.ref, s, "investigation-effort");
    invariant(
      r.ref.revision === 1 &&
        r.sequence === i + 1 &&
        !ids.has(r.ref.id) &&
        r.visibility === "private",
      "invalid_effort",
      "Immutable unique sequential effort required",
    );
    ids.add(r.ref.id);
    profile(r, s);
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
    if (r.corrects !== null) {
      const old = s.records.slice(0, i).find((x) => same(x.ref, r.corrects));
      invariant(
        old &&
          !corrected.has(canonical(old.ref)) &&
          same(old.plan, r.plan) &&
          old.questionId === r.questionId &&
          old.leadId === r.leadId,
        "invalid_correction",
        "Correction requires an uncorrected exact earlier effort on the same plan/question/lead",
      );
      corrected.add(canonical(old.ref));
    }
  }
}
export function createEffortState(context: Context): EffortState {
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
/** Record explicit human/agent research metadata; never executes a lead, closes a question or verifies a claim. */
export function recordEffort(
  context: Context,
  planning: PlanningState,
  state: EffortState,
  input: EffortInput,
): EffortState {
  const c = structuredClone(context),
    s = structuredClone(state),
    q = structuredClone(input);
  authorize(c, s);
  assertEffortState(s);
  exact(q, [
    "id",
    "expectedSequence",
    "plan",
    "questionId",
    "leadId",
    "outcome",
    "detail",
    "corrects",
  ]);
  nonempty(q.id, "Effort", 128);
  profile(q, s);
  invariant(
    Number.isSafeInteger(q.expectedSequence) &&
      q.expectedSequence === s.records.length,
    "revision_conflict",
    "Exact current effort sequence required",
  );
  const plans = inspectPlans(c, planning),
    p = plans.find((x) => same(x.ref, q.plan));
  invariant(p, "missing_reference", "Exact stored plan edition required");
  const question = p.value.questions.find((x) => x.id === q.questionId);
  invariant(
    question &&
      (q.leadId === null || question.leads.some((l) => l.id === q.leadId)),
    "missing_reference",
    "Question/lead must belong to selected plan edition",
  );
  if (q.corrects === null)
    invariant(
      !plans.some(
        (x) => x.ref.id === q.plan.id && x.ref.revision > q.plan.revision,
      ),
      "stale_plan",
      "New efforts require the current plan; historical corrections are explicit",
    );
  const { id, expectedSequence, ...value } = q;
  const r: EffortRecord = {
    ...value,
    ref: {
      tenantId: s.tenantId,
      projectId: s.projectId,
      kind: "investigation-effort",
      id,
      revision: 1,
    },
    sequence: expectedSequence + 1,
    visibility: "private",
    actorId: c.actor.id,
    actorKind: c.actor.kind,
    createdAt: c.now,
    requestId: c.requestId,
    purpose: c.purpose,
  };
  const next: EffortState = { ...s, records: [...s.records, r] };
  assertEffortState(next);
  return next;
}
/** Historical inspection retains corrected records. Effective is descriptive, never an answer/closure decision. */
export function inspectEfforts(
  context: Context,
  state: EffortState,
): Readonly<{
  history: readonly EffortRecord[];
  effective: readonly EffortRecord[];
}> {
  const c = structuredClone(context),
    s = structuredClone(state);
  authorize(c, s);
  assertEffortState(s);
  const corrected = new Set(
    s.records
      .filter((r) => r.corrects !== null)
      .map((r) => canonical(r.corrects)),
  );
  return {
    history: s.records,
    effective: s.records.filter((r) => !corrected.has(canonical(r.ref))),
  };
}
