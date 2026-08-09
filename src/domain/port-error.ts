/**
 * Port が外部に触れて失敗したときに投げるエラー。
 *
 * Unresolved.reason（port_failed / pending）とは軸が違う。あれは
 * 「観測・検証の結果どうだったか」で、こちらは「なぜ Port が失敗したか」になる。
 * 前者は Fact の隣に積まれ、後者は呼び出し側の分岐に使われる。
 *
 * kind を2値に絞ってあるのは、controller 側で意味のある分岐が2つしかないため。
 * 「待てば直る」（usage_limit）と「待っても直るとは限らない」（unavailable）で、
 * 前者だけが再開時刻を持つ。
 */

export type PortErrorKind =
  /** 使用量上限に達した。design.md §4.4 の WAITING_EXTERNAL(usage_limit) */
  | "usage_limit"
  /** 外部が落ちている、認証が無い、など。次のティックで再試行する */
  | "unavailable";

export class PortError extends Error {
  readonly kind: PortErrorKind;
  /** 再開してよい時刻。分からなければ null にして指数バックオフに任せる */
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
  if (error instanceof PortError) {
    return error.kind === "usage_limit";
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; kind?: unknown };
  return candidate.name === "PortError" && candidate.kind === "usage_limit";
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
  if (error instanceof PortError) {
    return error.kind === "unavailable";
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; kind?: unknown };
  return candidate.name === "PortError" && candidate.kind === "unavailable";
}

/** usage_limit なら resumeAfter を取り出す。持っていなければ null */
export function resumeAfterOf(error: unknown): string | null {
  if (!isUsageLimit(error)) {
    return null;
  }
  const resumeAfter = (error as { resumeAfter?: unknown }).resumeAfter;
  return typeof resumeAfter === "string" ? resumeAfter : null;
}
