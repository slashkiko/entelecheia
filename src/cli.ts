import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ActorPort } from "./act/index.js";
import { commandRunner, gitWorktree, localRepo, pendingApproval } from "./adapters/local.js";
import { type TickResult, tick } from "./controller/index.js";
import type { LlmPort } from "./decide/index.js";
import { loadGoalFile } from "./domain/goal-loader.js";
import type { CodeProviderPort } from "./observe/index.js";
import { openStore } from "./store/index.js";

/**
 * `ent` コマンド。常駐しない（design.md §3.6）。
 *
 * 引数の解釈は Node 24 標準の `node:util` の parseArgs で書く。citty は入れない
 * （理由は `.goals/persist-and-resume.yaml` の ac-6）。
 */

export const USAGE = `ent — Declare the end state; the controller converges to it.

  ent start <slug>   Goal を登録して ACTIVE にする
  ent run <slug>     1ティック回して終了する（--once は既定）
  ent show <slug>    宣言部と実行時状態をまとめて表示する
`;

export type Command =
  /** Goal を登録して ACTIVE にする */
  | { kind: "start"; slug: string }
  /** 1ティック回して終了する。--once は既定で、常駐する形は用意しない */
  | { kind: "run"; slug: string }
  /** 宣言部と実行時状態をマージして1枚で出す */
  | { kind: "show"; slug: string }
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * `ent` の引数を解釈する。
 *
 * 満たすべき性質:
 * - 実行はしない。解釈だけを返す。副作用のある部分と分けてテストするため
 * - 知らないサブコマンドと知らないオプションは error にする。黙って無視しない
 * - slug が無ければ error。どの Goal を回すかは既定値で埋められない
 * - 引数が無い、または --help なら help
 */
export function parseCommand(argv: readonly string[]): Command {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { kind: "help" };
  }
  if (sub !== "start" && sub !== "run" && sub !== "show") {
    // 黙って無視すると、打ち間違いが「何も起きなかった」に見える。
    return { kind: "error", message: `不明なサブコマンド: ${sub}` };
  }

  try {
    const { positionals } = parseArgs({
      args: [...rest],
      allowPositionals: true,
      // --once は既定の挙動を明示するだけで、受け取っても何も変えない。
      // 常駐する形は用意しない（design.md §3.6）。
      options: sub === "run" ? { once: { type: "boolean" } } : {},
      strict: true,
    });

    const slug = positionals[0];
    if (slug === undefined) {
      // どの Goal を回すかは既定値で埋められない。
      return { kind: "error", message: `${sub} には Goal の slug が要る` };
    }
    if (positionals.length > 1) {
      return { kind: "error", message: `引数が多い: ${positionals.join(" ")}` };
    }

    return { kind: sub, slug };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `ent` の本体。1ティック回して終了する。常駐しない（design.md §3.6）。
 *
 * GitHub と Actor の Port はまだ実装が無いので、呼ばれたら throw する形にしてある。
 * observe と act はそれを握って unresolved と failed に落とすので、
 * ティック自体は最後まで回り、状態が DB に残る。捏造した観測は作らない。
 */
export async function main(argv: readonly string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === "error") {
    process.stderr.write(`${command.message}\n\n${USAGE}`);
    return 2;
  }

  const repoRoot = process.cwd();
  const stateDir = join(repoRoot, ".goals", ".state");
  mkdirSync(join(stateDir, "worktrees"), { recursive: true });

  const goal = loadGoalFile(join(repoRoot, ".goals", `${command.slug}.yaml`));
  const store = openStore(join(stateDir, "goals.db"));

  try {
    store.upsertGoal(goal);

    if (command.kind === "start") {
      const now = new Date().toISOString();
      store.setStatus(goal.goal.id, "ACTIVE", null, now);
      process.stdout.write(`${goal.goal.id}: ACTIVE\n`);
      return 0;
    }

    if (command.kind === "show") {
      const state = store.getState(goal.goal.id);
      process.stdout.write(`${JSON.stringify({ goal: goal.goal, state }, null, 2)}\n`);
      return 0;
    }

    // SIGTERM を受けたら走行中の Actor に伝播する。Ctrl+C が効かない状態を作らない。
    const aborter = new AbortController();
    const stop = (): void => aborter.abort();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    const result = await tick(goal, {
      store,
      owner: `${hostname()}:${process.pid}`,
      leaseSeconds: 300,
      signal: aborter.signal,
      code: unavailable("CodeProviderPort"),
      local: localRepo(repoRoot),
      command: commandRunner(repoRoot),
      approval: pendingApproval(),
      worktree: gitWorktree(repoRoot, join(stateDir, "worktrees")),
      actor: unavailableActor(),
      llm: unavailableLlm(),
      now: () => new Date(),
    });

    process.stdout.write(`${JSON.stringify(summarize(result), null, 2)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

function summarize(result: TickResult): unknown {
  return {
    ran: result.ran,
    reclaimed: result.reclaimed,
    status: result.status,
    action: result.decision?.action ?? null,
    rationale: result.decision?.rationale ?? null,
    run: result.run === null ? null : { id: result.run.id, status: result.run.status },
  };
}

/** 未実装の Port。捏造した観測を返すより、落として unresolved に残す */
function unavailable(name: string): CodeProviderPort {
  const fail = async (): Promise<never> => {
    throw new Error(`${name} は未実装（次の Goal で octokit を入れる）`);
  };
  return { getPullRequest: fail, getLatestCiRun: fail, getIssue: fail };
}

function unavailableActor(): ActorPort {
  return {
    kind: "claude-code",
    run: async () => {
      throw new Error("ActorPort は未実装（次の Goal で Claude Agent SDK を入れる）");
    },
  };
}

function unavailableLlm(): LlmPort {
  return {
    chooseAction: async () => {
      throw new Error("LlmPort は未実装（次の Goal で Claude Agent SDK を入れる）");
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
