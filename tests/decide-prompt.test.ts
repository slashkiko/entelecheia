import { describe, expect, it } from "vitest";
import {
  type BudgetUsage,
  type DecideDeps,
  type DecideTarget,
  decide,
  type LlmPort,
} from "../src/decide/index.js";
import type { Unresolved } from "../src/domain/fact.js";
import { criterionFactKey } from "../src/domain/fact-keys.js";
import type { Assessment, Gap } from "../src/domain/gap.js";
import type { AcceptanceCriterion, Budget } from "../src/domain/goal.js";

/**
 * DECIDE のプロンプトに同じ本文を2回入れない。
 *
 * `type: human` の criterion が pending のとき、`verify` は prompt 全文を
 * `Unresolved.detail` に積む。`assess` の `unknownDetail()` はそれを Gap の detail に
 * 丸ごと埋め込むので、`## Gap` と `## 結論が出ていない対象` の両方に同じ全文が入る。
 * 実際のティックでは数十行の確認事項が2回並んでいた。
 *
 * ただし単純に片方を消すと情報が落ちる。2つのセクションは役割が違い、重なり方も
 * 非対称になっている。
 *
 *   criterion に紐づく unresolved（key が `criteria.<id>.passed`）
 *     → 必ず対応する Gap があり、detail ごとそちらに現れる
 *   観測レベルの unresolved（`github.ci` の port_failed など）
 *     → Gap には現れず、このセクションにしか出ない
 *
 * したがって落としてよいのは前者の detail だけになる。判断材料の全文は Gap 側に
 * 一本化する。あちらは kind が付いていて、LLM が ACT と VERIFY を選び分ける材料になる。
 *
 * 末尾の指示行も二重になっている。`buildPrompt()` が
 * `JSON オブジェクトだけを返す。` で終わり、`claudeLlm` が `JSON_ONLY`
 * （`JSON オブジェクトだけを返す。前置きも説明も付けない。`）をさらに足す。
 * 出力形式の強制はトランスポートの責務なので adapter 側に一本化する。
 * `LlmPort` の契約は「戻り値を Zod で検証する」までしか言っていない。
 */

const NOW = new Date("2026-08-09T03:00:00.000Z");

/** 実物と同じく複数行にする。1行だと重複しても目立たない */
const HUMAN_PROMPT = `この Goal は総仕上げなので、機能そのものより経路を確認するものです。

次を確認してください。

  1. Actor が worktree の中だけで実装したか
  2. PR が controller によって立ち、進捗がコメントに積まれているか`;

const BUDGET: Budget = {
  max_actor_runs: 10,
  max_reconciles: 20,
  max_wall_clock: "2h",
  max_consecutive_failures: 3,
  max_unchanged_reconciles: 3,
};

const FRESH: BudgetUsage = {
  actorRuns: 0,
  reconciles: 1,
  consecutiveFailures: 0,
  elapsedSeconds: 60,
  trailingDigest: { digest: null, count: 0 },
};

const CRITERIA: AcceptanceCriterion[] = [
  {
    id: "ac-1",
    description: "テストが通る",
    verification: { type: "command", run: "mise run test" },
  },
  {
    id: "ac-5",
    description: "変更を載せた PR の CI が成功している",
    verification: { type: "fact", key: "github.ci.conclusion", equals: "success" },
  },
  {
    id: "ac-6",
    description: "人間が確認する",
    verification: { type: "human", prompt: HUMAN_PROMPT },
  },
];

/** criterion に紐づく unresolved。assess が同じ detail を Gap に埋め込む */
const HUMAN_UNRESOLVED: Unresolved = {
  key: criterionFactKey("ac-6"),
  reason: "pending",
  detail: HUMAN_PROMPT,
};

/** 観測レベルの unresolved。Gap には現れないので、このセクションが唯一の置き場 */
const PORT_UNRESOLVED: Unresolved = {
  key: "github.ci",
  reason: "port_failed",
  detail: "CodeProviderPort.getLatestCiRun(abc): 502 Bad Gateway",
};

const GAPS: Gap[] = [
  { criterionId: "ac-1", kind: "unmet", detail: "テストが通る が満たされていない（exit_code=1）" },
  {
    criterionId: "ac-6",
    kind: "unknown",
    detail: `${criterionFactKey("ac-6")} の結論が出ていない（pending: ${HUMAN_PROMPT}）`,
  },
];

function assessment(gaps: Gap[]): Assessment {
  return { assessedAt: NOW.toISOString(), gaps, satisfied: gaps.length === 0 };
}

function spyLlm(): LlmPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chooseAction: async (prompt: string) => {
      calls.push(prompt);
      return { type: "VERIFY" };
    },
  };
}

function target(over: Partial<DecideTarget> = {}): DecideTarget {
  return {
    criteria: CRITERIA,
    // レビュー役と WAIT を選択肢に載せてよいかを見る材料。この fixture では観測が無い。
    facts: [],
    // 今ティックの観測。`facts` と同じにしておく（この fixture では両方空）
    observedFacts: [],
    assessment: assessment(GAPS),
    unresolved: [HUMAN_UNRESOLVED, PORT_UNRESOLVED],
    observedDigest: "digest-1",
    budget: BUDGET,
    usage: FRESH,
    ...over,
  };
}

function deps(llm: LlmPort): DecideDeps {
  return { llm, now: () => NOW };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function promptOf(over: Partial<DecideTarget> = {}): Promise<string> {
  const llm = spyLlm();
  await decide(target(over), deps(llm));
  expect(llm.calls).toHaveLength(1);
  return llm.calls[0] ?? "";
}

describe("DECIDE のプロンプト", () => {
  it("criterion の prompt 全文は1回だけ現れる", async () => {
    const prompt = await promptOf();

    expect(occurrences(prompt, HUMAN_PROMPT)).toBe(1);
  });

  it("残すのは Gap 側。kind が付いていて選び分けの材料になる", async () => {
    const prompt = await promptOf();
    const gapSection = prompt.slice(
      prompt.indexOf("## Gap"),
      prompt.indexOf("## 結論が出ていない対象"),
    );

    expect(gapSection).toContain(HUMAN_PROMPT);
  });

  it("Gap に現れない unresolved の detail は落とさない", async () => {
    const prompt = await promptOf();

    expect(prompt).toContain("502 Bad Gateway");
  });

  it("重複を消しても、どの criterion が pending かは読める", async () => {
    const prompt = await promptOf();
    const unresolvedSection = prompt.slice(prompt.indexOf("## Targets with no conclusion yet"));

    expect(unresolvedSection).toContain(criterionFactKey("ac-6"));
    expect(unresolvedSection).toContain("pending");
  });

  it("Gap が無いティックでは全文を残す。Gap 側に置き場が無い", async () => {
    // guard が WAIT を返すので LLM は呼ばれない。rationale で確かめる。
    const llm = spyLlm();
    const decision = await decide(
      target({ assessment: assessment([]), unresolved: [HUMAN_UNRESOLVED] }),
      deps(llm),
    );

    expect(llm.calls).toHaveLength(0);
    expect(decision.rationale).toContain(HUMAN_PROMPT);
  });

  it("出力形式の指示は adapter 側に一本化する", async () => {
    const prompt = await promptOf();

    expect(prompt).not.toContain("Return only a JSON object");
  });

  it("行動の列挙と guard の境界は残す", async () => {
    const prompt = await promptOf();

    expect(prompt).toContain("## Actions you may choose");
    expect(prompt).toContain("COMPLETE and ESCALATE cannot be chosen");
    expect(prompt).toContain("## Budget remaining");
  });
});
