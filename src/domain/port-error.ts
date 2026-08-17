import { z } from "zod";

/**
 * Port が外部に触れて失敗したときに投げるエラー。
 *
 * Unresolved.reason（port_failed / pending）とは軸が違う。あれは
 * 「観測・検証の結果どうだったか」で、こちらは「なぜ Port が失敗したか」になる。
 * 前者は Fact の隣に積まれ、後者は呼び出し側の分岐に使われる。
 *
 * kind は、待てば直る `usage_limit`、外部障害の `unavailable`、応答形式が契約と
 * 合わない `shape_mismatch` に分ける。再開時刻を持つのは `usage_limit` だけになる。
 */

export const portErrorKindSchema = z.enum(["usage_limit", "unavailable", "shape_mismatch"]);
export type PortErrorKind = z.infer<typeof portErrorKindSchema>;

export class PortError extends Error {
  readonly kind: PortErrorKind;
  /** 再開してよい時刻。分からなければ null にして、guard の既定の待ちに任せる */
  readonly resumeAfter: string | null;

  constructor(kind: PortErrorKind, message: string, resumeAfter: string | null = null) {
    super(message);
    this.name = "PortError";
    this.kind = kind;
    this.resumeAfter = resumeAfter;
  }
}

/**
 * 使用量上限かどうか。
 *
 * instanceof だけで判定すると、SDK が別インスタンスの PortError を投げる構成
 * （多重インストールなど）で取りこぼす。name と kind も見る。
 */
export function isUsageLimit(error: unknown): error is PortError {
  return portErrorKindOf(error) === "usage_limit";
}

/**
 * PortError なら kind を、そうでなければ null を返す。
 *
 * `instanceof` だけで判定すると、SDK が別インスタンスの PortError を投げる構成
 * （多重インストールなど）で取りこぼす。name と kind も見る。この二段構えを
 * kind ごとに書き写していたので、片方だけ直すと挙動が食い違った。1箇所に置く。
 */
export function portErrorKindOf(error: unknown): PortErrorKind | null {
  if (error instanceof PortError) {
    return error.kind;
  }
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as { name?: unknown; kind?: unknown };
  if (candidate.name !== "PortError" || typeof candidate.kind !== "string") {
    return null;
  }
  const parsed = portErrorKindSchema.safeParse(candidate.kind);
  return parsed.success ? parsed.data : null;
}

/**
 * 待っても直るとは限らない失敗かどうか。
 *
 * 未ログイン、モデル名の誤り、認証切れはここに来る。呼び直しても同じ結果になるので、
 * 再試行の回数を消費させない。実際、初めて ent run を全周させたとき
 * 「Not logged in」を3回とも呼び直して同じ失敗を繰り返した。
 *
 * 一時的な 502 や 429 もこの kind に入るので、次のティックでは再試行される。
 * 抑止するのは1ティックの中での呼び直しだけになる。
 */
export function isUnavailable(error: unknown): error is PortError {
  return portErrorKindOf(error) === "unavailable";
}

/**
 * 応答は返ったが、こちらのスキーマで解釈できなかったか。
 *
 * 待っても直らないので、`unavailable` と同じ扱いにしない。observe はこれを
 * `Unresolved.reason: "shape_mismatch"` として残す。
 */
export function isShapeMismatch(error: unknown): error is PortError {
  return portErrorKindOf(error) === "shape_mismatch";
}

/** usage_limit なら resumeAfter を取り出す。持っていなければ null */
export function resumeAfterOf(error: unknown): string | null {
  if (!isUsageLimit(error)) {
    return null;
  }
  const resumeAfter = (error as { resumeAfter?: unknown }).resumeAfter;
  return typeof resumeAfter === "string" ? resumeAfter : null;
}
