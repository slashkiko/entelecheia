import { VERIFY_WITHHELD_ENV, withheldEnv } from "@entelecheia/core/domain/withheld-env.js";

/**
 * 検査が子プロセスに渡す環境変数。
 *
 * ent の VERIFY と同じ除去リストに、Actions と mise が置くトークンと、Actions のファイル
 * コマンドの置き場を足す。どれもこのワークフローでは渡していないか、渡しても使わない。
 * 呼ぶ側が書き足したときにも、head のコードへそのまま引き継がれないようにする。
 *
 * git の置き場を指す変数（`GIT_DIR` など）も落とす。git は cwd よりこれを優先するので、
 * git の hook から呼ばれたときのように呼ぶ側が持っていると、検査は `--dir` ではなく
 * そのリポジトリを読み、切り出しの checkout でその HEAD と index を書き換える。
 *
 * 防げるのは引き継ぎまでになる。head のコードは同じユーザーで動くので、狙えば親の環境
 * （`/proc/<pid>/environ`）や `$RUNNER_TEMP` の下のファイルコマンドの置き場を見つけて、
 * job summary や後ろのステップの環境に書ける。E1 を head が偽れるのと同じ穴で、
 * E1 だけでは自動マージにならないことで受けている。
 */
const CHECK_WITHHELD_ENV = [
  ...VERIFY_WITHHELD_ENV,
  "MISE_GITHUB_TOKEN",
  "GITHUB_API_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
] as const;

export function checkEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...withheldEnv(process.env, CHECK_WITHHELD_ENV), ...extra };
}
