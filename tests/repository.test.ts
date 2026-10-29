import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped, verifyAudit } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import * as k from "@accountability/knowledge-verification";
import type { Context } from "@accountability/knowledge-verification/contracts";
import { FactualRepository } from "../src/repository.ts";
import type { PlanningCommand } from "../src/repository.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "factual",
  purpose: "private-review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  now: "2026-01-01T00:00:00Z",
  requestId: "r",
};
const claim: k.KnowledgeValue = {
  type: "claim",
  text: "A fictional signal may have occurred",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "observation",
  limitations: ["Unverified fixture"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function input() {
  const knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: claim,
  });
  const command: PlanningCommand = {
    id: "plan",
    expectedRevision: 0,
    value: {
      title: "Fictional signal review",
      intakeCaseRef: null,
      basisClaimRefs: [knowledge.records[0]!.ref],
      questions: [
        {
          id: "time",
          parentId: null,
          text: "When was the signal observed?",
          whyMaterial: "Distinguishes sequences",
          material: true,
          hypotheses: [
            {
              id: "early",
              explanation: "Before the lamp",
              claimRefs: [knowledge.records[0]!.ref],
              contraryTest: "Seek an authorized record of the reverse order",
            },
          ],
          leads: [
            {
              id: "log",
              description: "Inspect a separately authorized fictional log",
            },
          ],
          stopCondition: "Pause if no source is authorized; remain unresolved",
        },
      ],
    },
  };
  return { knowledge, command };
}
async function fixture(t: test.TestContext) {
  const pg = new PGlite();
  await pg.exec(
    await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence-sql/database"),
      ),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE factual_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO factual_login; SET SESSION AUTHORIZATION factual_login",
  );
  const hooks = { lost: false, rollback: false };
  const db: Database = {
    transaction: (fn) =>
      pg
        .transaction(async (query) => {
          const value = await fn({
            query: async <T>(sql: string, values?: unknown[]) => {
              const result = await query.query(sql, values);
              if (
                hooks.rollback &&
                sql.includes("INSERT INTO public.evidence_outbox")
              )
                throw Error("fixture rollback");
              return { rows: result.rows as T[] };
            },
          });
          return value;
        })
        .then((value) => {
          if (hooks.lost) {
            hooks.lost = false;
            throw Error("fixture lost COMMIT acknowledgement");
          }
          return value;
        }),
    close: () => pg.close(),
  };
  t.after(() => pg.close());
  const policy = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    humanIds: [c.actor.id],
    purpose: c.purpose,
  };
  return { db, pg, policy, hooks, repo: new FactualRepository(db, policy) };
}
test("own restricted migrated DB preserves private plan history and exact containing storage editions", async (t) => {
  const f = await fixture(t),
    x = input();
  assert.equal((await f.repo.load(c)).revision, 0);
  const first = await f.repo.append(c, 0, x.knowledge, x.command, "first");
  assert.equal(first.record.kind, "investigation-plan");
  assert.equal(first.storage.revision, 1);
  await new FactualRepository(f.db, f.policy).append(
    c,
    1,
    x.knowledge,
    {
      ...x.command,
      expectedRevision: 1,
      value: { ...x.command.value, title: "Revised fictional plan" },
    },
    "second",
  );
  const read = await f.repo.load(c);
  assert.equal(read.state.visibility, "private");
  assert.equal(read.revision, 2);
  assert.deepEqual(read.state.records[1]!.supersedes, first.record);
  assert.equal(read.state.records[0]!.value.title, x.command.value.title);
  Object.assign(read.state.records[0]!.value, {
    title: "Detached caller mutation",
  });
  assert.notDeepEqual(await f.repo.load(c), read);
  assert.equal(x.knowledge.records[0]!.value.type, "claim");
  await scoped(f.db, c, async (tx) => assert(verifyAudit(await tx.audits())));
});
test("lost COMMIT acknowledgement and later revisions allow only original historical replay without upstream attestation", async (t) => {
  const f = await fixture(t),
    x = input();
  f.hooks.lost = true;
  await assert.rejects(f.repo.append(c, 0, x.knowledge, x.command, "first"));
  const first = await new FactualRepository(f.db, f.policy).append(
    c,
    0,
    x.knowledge,
    x.command,
    "first",
  );
  await f.repo.append(
    c,
    1,
    x.knowledge,
    { ...x.command, expectedRevision: 1 },
    "second",
  );
  assert.deepEqual(
    await f.repo.append(c, 0, k.createKnowledgeState(c), x.command, "first"),
    first,
  );
  assert.equal((await f.repo.load(c)).revision, 2);
  await assert.rejects(
    f.repo.append(
      c,
      0,
      x.knowledge,
      { ...x.command, id: "different" },
      "first",
    ),
  );
});
test("post-outbox failure atomically rolls back plan audit and cached acknowledgement", async (t) => {
  const f = await fixture(t),
    x = input();
  const before = await scoped(
    f.db,
    c,
    async (tx) => (await tx.audits()).length,
  );
  f.hooks.rollback = true;
  await assert.rejects(f.repo.append(c, 0, x.knowledge, x.command, "first"));
  f.hooks.rollback = false;
  assert.equal(
    await scoped(f.db, c, async (tx) => (await tx.audits()).length),
    before,
  );
  assert.equal((await f.repo.load(c)).revision, 0);
  assert.equal(
    (await f.repo.append(c, 0, x.knowledge, x.command, "first")).storage
      .revision,
    1,
  );
});
test("new plans use actual pinned Knowledge validation and preserve material questions under storage CAS", async (t) => {
  const f = await fixture(t),
    x = input();
  const revised = k.reviseKnowledge(c, x.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: claim,
  });
  await assert.rejects(f.repo.append(c, 0, revised, x.command, "stale"), {
    code: "stale_claim",
  });
  await assert.rejects(
    f.repo.append(
      c,
      0,
      { ...x.knowledge, projectId: "foreign" },
      x.command,
      "foreign",
    ),
  );
  await assert.rejects(
    f.repo.append(c, 0, k.createKnowledgeState(c), x.command, "missing"),
  );
  const outcomes = await Promise.allSettled(
    ["one", "two"].map((id) => f.repo.append(c, 0, x.knowledge, x.command, id)),
  );
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const demoted = {
    ...x.command,
    expectedRevision: 1,
    value: {
      ...x.command.value,
      questions: x.command.value.questions.map((q) => ({
        ...q,
        material: false,
      })),
    },
  };
  await assert.rejects(f.repo.append(c, 1, x.knowledge, demoted, "demote"));
  await assert.rejects(
    f.repo.append(
      c,
      1,
      x.knowledge,
      {
        ...x.command,
        expectedRevision: 1,
        value: {
          ...x.command.value,
          status: "closed",
        } as unknown as PlanningCommand["value"],
      },
      "closure",
    ),
  );
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("current host authority precedes cached replay and rejects same-ID nonhuman kinds", async (t) => {
  const f = await fixture(t),
    x = input();
  await f.repo.append(c, 0, x.knowledge, x.command, "first");
  for (const bad of [
    { ...c, projectId: "foreign" },
    { ...c, purpose: "other" },
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
    { ...c, actor: { ...c.actor, id: "unlisted" } },
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
  ]) {
    await assert.rejects(f.repo.load(bad));
    await assert.rejects(
      f.repo.append(bad, 0, x.knowledge, x.command, "first"),
    );
  }
  const removed = new FactualRepository(f.db, {
    ...f.policy,
    humanIds: ["replacement"],
  });
  await assert.rejects(removed.append(c, 0, x.knowledge, x.command, "first"));
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("separate project histories and privileged login rejection apply to real migrated persistence", async (t) => {
  const f = await fixture(t),
    x = input();
  await f.repo.append(c, 0, x.knowledge, x.command, "first");
  const other = { ...c, projectId: "other" },
    repo = new FactualRepository(f.db, {
      ...f.policy,
      projectId: other.projectId,
    });
  assert.equal((await repo.load(other)).revision, 0);
  await assert.rejects(repo.append(other, 0, x.knowledge, x.command, "first"));
  assert.equal((await f.repo.load(c)).revision, 1);
  await f.pg.exec("SET SESSION AUTHORIZATION postgres");
  await assert.rejects(f.repo.load(c), { code: "unsafe_database_role" });
});
test("captured config inputs and corrupted stored sequence cannot rewrite history or admit cached results", async (t) => {
  const f = await fixture(t),
    x = input(),
    policy = structuredClone(f.policy),
    repo = new FactualRepository(f.db, policy),
    context = structuredClone(c),
    source = structuredClone(x.knowledge),
    command = structuredClone(x.command);
  const pending = repo.append(context, 0, source, command, "first");
  Object.assign(command.value, { title: "Changed caller title" });
  Object.assign(source.records[0]!.ref, { revision: 99 });
  Object.assign(context.actor, { id: "other" });
  policy.humanIds.length = 0;
  const ack = await pending,
    read = await repo.load(c);
  assert.equal(read.state.records[0]!.value.title, x.command.value.title);
  await scoped(f.db, c, async (tx) => {
    await tx.put(ack.storage.kind, ack.storage.id, 1, read.state);
  });
  await assert.rejects(repo.load(c), { code: "invalid_plan" });
  await assert.rejects(repo.append(c, 0, x.knowledge, x.command, "first"), {
    code: "invalid_plan",
  });
  await scoped(f.db, c, async (tx) =>
    assert.deepEqual(
      (await tx.get(ack.storage.kind, ack.storage.id, 1))?.value,
      read.state,
    ),
  );
});

test("storage CAS spans distinct logical plans while exact plan predecessors and case association stay independent", async (t) => {
  const f = await fixture(t),
    x = input();
  const first = await f.repo.append(c, 0, x.knowledge, x.command, "first");
  const second = await f.repo.append(
    c,
    1,
    x.knowledge,
    { ...x.command, id: "other-plan" },
    "other",
  );
  assert.equal(second.storage.revision, 2);
  assert.equal(second.record.revision, 1);
  const revised = await f.repo.append(
    c,
    2,
    x.knowledge,
    { ...x.command, expectedRevision: 1 },
    "revise",
  );
  assert.equal(revised.storage.revision, 3);
  assert.equal(revised.record.revision, 2);
  const read = await f.repo.load(c);
  assert.deepEqual(read.state.records[2]!.supersedes, first.record);
  assert.equal(read.state.records[1]!.supersedes, null);
  await assert.rejects(
    f.repo.append(
      c,
      2,
      x.knowledge,
      { ...x.command, id: "other-plan", expectedRevision: 1 },
      "stale-storage",
    ),
    { code: "revision_conflict" },
  );
  await assert.rejects(
    f.repo.append(
      c,
      3,
      x.knowledge,
      {
        ...x.command,
        expectedRevision: 2,
        value: {
          ...x.command.value,
          intakeCaseRef: {
            tenantId: c.tenantId,
            projectId: c.projectId,
            kind: "case",
            id: "fixture-unverified-case",
            revision: 1,
          },
        },
      },
      "change-case",
    ),
  );
  assert.deepEqual(
    await f.repo.append(c, 0, k.createKnowledgeState(c), x.command, "first"),
    first,
  );
  assert.equal((await f.repo.load(c)).revision, 3);
});
