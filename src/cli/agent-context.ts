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

const JSON_FLAG = { name: "--json", type: "boolean", summary: "JSON で出す" } as const;

const LIMIT_FLAG = {
  name: "--limit",
  type: "integer",
  summary: `出力の件数（既定 ${String(DEFAULT_LIMIT)}）`,
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
          "いまのリポジトリを回せる状態にする。.goals/ と gitignore の行と Goal の雛形を置く。冪等",
        args: [],
        flags: [JSON_FLAG],
      },
      {
        name: "start",
        summary: "Goal を登録して ACTIVE にする",
        args: [slug],
        flags: [JSON_FLAG],
      },
      {
        name: "run",
        summary: "1ティックだけ回して終了する。常駐しないので繰り返し叩く",
        args: [slug],
        flags: [
          JSON_FLAG,
          { name: "--dry-run", type: "boolean", summary: "書かずに次のティックの中身を見る" },
          { name: "--pr", type: "integer", summary: "観測する PR 番号" },
          { name: "--issue", type: "integer", summary: "観測する Issue 番号" },
          {
            name: "--report",
            type: "string",
            summary:
              "進捗を PR に投稿せず、stdout（JSON の report.body）か指定したファイルに出す。この宛先にだけレビュー役の本文が1節付くので、PR コメントとは同じ内容にならない。ファイルは追記なので同じ本文が積まれる。--dry-run とは併用しない",
          },
        ],
        output: [
          {
            key: "publishHold",
            when: "policies.publish で controller の publish を止めたティック",
            summary:
              "step（push_branch / open_pull_request）/ reason / pushed / branch / base。pushed が true なら branch は remote にあるので、叩いた側が代わりに PR を立てられる",
          },
          { key: "dryRun", when: "--dry-run", summary: "wouldTransitionTo と observed も付く" },
          { key: "report", when: "--report", summary: "destination / written / error（/ body）" },
        ],
      },
      {
        name: "get",
        summary: "宣言部と実行時状態をまとめて出す",
        args: [slug],
        flags: [JSON_FLAG, LIMIT_FLAG],
      },
      {
        name: "abandon",
        summary: "もう追わないと宣言して ABANDONED にする。完了は名乗らせないので complete は無い",
        args: [slug],
        flags: [
          JSON_FLAG,
          { name: "--reason", type: "string", summary: "なぜ追わないのか（必須）" },
        ],
      },
      {
        name: "list",
        summary: "登録済みの Goal を一覧する",
        args: [],
        flags: [JSON_FLAG, LIMIT_FLAG],
      },
      {
        name: "doctor",
        summary: "回す前の前提が揃っているかを読み取り専用で調べる",
        args: [],
        flags: [],
      },
      {
        name: "agent-context",
        summary: "この構造そのものを出す",
        args: [],
        flags: [],
      },
    ],
    env: [
      {
        name: "GITHUB_TOKEN",
        required: false,
        summary:
          "無ければ GH_TOKEN と gh auth token に落ちる。どれも無いと GitHub の観測が unresolved",
      },
      {
        name: "ENT_ACTOR",
        required: false,
        summary: "全phaseの既定provider。claude-code / codex。既定はclaude-code",
      },
      { name: "ENT_MODEL", required: false, summary: "全phaseの既定モデル" },
      { name: "ENT_EFFORT", required: false, summary: "全phaseの既定effort" },
      ...["DECIDE", "IMPLEMENT", "REVIEW", "INVESTIGATE"].flatMap((phase) => [
        {
          name: `ENT_${phase}_ACTOR`,
          required: false,
          summary: `${phase}だけproviderを上書き`,
        },
        {
          name: `ENT_${phase}_MODEL`,
          required: false,
          summary: `${phase}だけモデルを上書き`,
        },
        {
          name: `ENT_${phase}_EFFORT`,
          required: false,
          summary: `${phase}だけeffortを上書き`,
        },
      ]),
    ],
    exitCodes: [
      { code: 0, meaning: "成功。ティックが最後まで回った（doctor では failed が1件も無い）" },
      {
        code: 1,
        meaning:
          "実行時エラー、または実行できない状態。詳細は stderr（doctor では stdout の JSON）",
      },
      { code: 2, meaning: "引数が不正。stderr に有効値が出る" },
    ],
  };
}
