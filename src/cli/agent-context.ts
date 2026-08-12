import { DEFAULT_LIMIT } from "../usecase/inspect.js";

/**
 * `ent agent-context` が出す、CLI の構造そのもの（gist 3.2 Layer 2）。
 *
 * `tests/docs-contract.test.ts` が README と SKILL.md をここと突き合わせるので、
 * サブコマンドを足したら文書にも載るまで CI が通らない。
 */

/**
 * `ent agent-context` が出すもの（gist 3.2 Layer 2）。
 *
 * 散文の --help から「何が叩けるか」を推測させないための、機械可読な CLI の構造。
 * 読ませる前提のものなので短く保つ。長い説明文はそのままコンテキストを食う。
 */
export interface AgentContext {
  /** 増えたのか壊れたのかを読む側が区別できるように版を持たせる */
  schemaVersion: number;
  commands: {
    name: string;
    /**
     * 同じサブコマンドを指す、いま実際に叩ける別名。
     *
     * 通らなくなった名前はここに載せない。ここを読んで組み立てたコマンドが
     * 通らないなら、Layer 2 は --help より当てにならないものになる。
     * 打ち直す先は、不明なサブコマンドのエラーが有効値を並べることで伝わる。
     */
    aliases?: string[];
    summary: string;
    args: { name: string; required: boolean; type: string }[];
    flags: { name: string; type: string; summary: string }[];
    /**
     * 条件が揃ったときだけ出力 JSON に増える枝。常に出るキーは載せない。
     *
     * 常に出るものは1回叩けば読めるが、条件付きのものは条件を踏まない限り
     * 存在すら分からない。`publishHold` がその典型で、宣言を書いた Goal を
     * 回したときにしか出ない。ここに無ければ、読む側は毎ティック出るキーだけを
     * 見て分岐を組むことになる。
     */
    output?: { key: string; when: string; summary: string }[];
  }[];
  env: { name: string; required: boolean; summary: string }[];
  exitCodes: { code: number; meaning: string }[];
}

const JSON_FLAG = { name: "--json", type: "boolean", summary: "emit JSON" } as const;

const LIMIT_FLAG = {
  name: "--limit",
  type: "integer",
  summary: `how many entries to print (default ${String(DEFAULT_LIMIT)})`,
} as const;

export function agentContextPayload(): AgentContext {
  const slug = { name: "slug", required: true, type: "string" } as const;

  return {
    // 3 で commands[].output を足した。読む側から見れば増えただけになる。
    schemaVersion: 3,
    commands: [
      {
        name: "init",
        summary:
          "make the current repository runnable. Places .goals/, the gitignore line, and a Goal template. Idempotent",
        args: [],
        flags: [JSON_FLAG],
      },
      {
        name: "start",
        summary: "register a Goal and make it ACTIVE",
        args: [slug],
        flags: [JSON_FLAG],
      },
      {
        name: "run",
        summary: "run exactly one tick and exit. Nothing stays resident, so invoke it repeatedly",
        args: [slug],
        flags: [
          JSON_FLAG,
          {
            name: "--dry-run",
            type: "boolean",
            summary: "write nothing; see what the next tick would contain",
          },
          { name: "--pr", type: "integer", summary: "PR number to observe" },
          { name: "--issue", type: "integer", summary: "Issue number to observe" },
          {
            name: "--report",
            type: "string",
            summary:
              "send progress to stdout (report.body of the JSON) or to the given file instead of posting it to the PR. Only this destination carries an extra section holding the review role's text, so it never matches the PR comment. Files are appended to, so bodies accumulate. Not combined with --dry-run",
          },
        ],
        output: [
          {
            key: "publishHold",
            when: "ticks where policies.publish held the controller's publish",
            summary:
              "step (push_branch / open_pull_request) / reason / pushed / branch / base. When pushed is true the branch is on the remote, so the caller can open the PR instead",
          },
          {
            key: "dryRun",
            when: "--dry-run",
            summary: "wouldTransitionTo and observed are added too",
          },
          { key: "report", when: "--report", summary: "destination / written / error (/ body)" },
        ],
      },
      {
        name: "get",
        summary: "emit the declaration and the runtime state together",
        args: [slug],
        flags: [JSON_FLAG, LIMIT_FLAG],
      },
      {
        name: "abandon",
        summary:
          "declare it no longer pursued and make it ABANDONED. Completion is never self-declared, so there is no complete",
        args: [slug],
        flags: [
          JSON_FLAG,
          { name: "--reason", type: "string", summary: "why it is no longer pursued (required)" },
        ],
      },
      {
        name: "list",
        summary: "list registered Goals",
        args: [],
        flags: [JSON_FLAG, LIMIT_FLAG],
      },
      {
        name: "doctor",
        summary: "read-only check that the prerequisites for running are in place",
        args: [],
        flags: [],
      },
      {
        name: "agent-context",
        summary: "emit this structure itself",
        args: [],
        flags: [],
      },
    ],
    env: [
      {
        name: "GITHUB_TOKEN",
        required: false,
        summary:
          "falls back to GH_TOKEN then gh auth token. With none of them, GitHub observation stays unresolved",
      },
      {
        name: "ENT_ACTOR",
        required: false,
        summary: "default provider for every phase. claude-code / codex. Defaults to claude-code",
      },
      { name: "ENT_MODEL", required: false, summary: "default model for every phase" },
      { name: "ENT_EFFORT", required: false, summary: "default effort for every phase" },
      ...["DECIDE", "IMPLEMENT", "REVIEW", "INVESTIGATE"].flatMap((phase) => [
        {
          name: `ENT_${phase}_ACTOR`,
          required: false,
          summary: `override the provider for ${phase} only`,
        },
        {
          name: `ENT_${phase}_MODEL`,
          required: false,
          summary: `override the model for ${phase} only`,
        },
        {
          name: `ENT_${phase}_EFFORT`,
          required: false,
          summary: `override the effort for ${phase} only`,
        },
      ]),
    ],
    exitCodes: [
      {
        code: 0,
        meaning: "success. The tick ran all the way through (for doctor, nothing failed)",
      },
      {
        code: 1,
        meaning:
          "runtime error, or a state that cannot be run. Details on stderr (for doctor, in the JSON on stdout)",
      },
      { code: 2, meaning: "invalid arguments. Valid values are printed on stderr" },
    ],
  };
}
