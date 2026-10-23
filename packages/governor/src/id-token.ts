import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

/**
 * GitHub Actions の OIDC トークン（JWT）の署名を確かめ、中身を返す。
 *
 * 再利用ワークフローの evidence のジョブは、evidence.json の digest を audience にした
 * トークンを取り、artifact に一緒に残す。トークンを出せるのは GitHub だけで、取れるのは
 * id-token: write を持つジョブだけになる。署名が通れば、中身（どのリポジトリの、どの run の、
 * どの sha の再利用ワークフローのジョブが取ったか）は GitHub が書いたものと言える。
 *
 * 依存を足さずに Node の crypto で確かめる。受け取るのは RS256 だけにする。`alg` を
 * トークンの言うままに選ぶと、`none` や鍵を共有鍵として読む形に倒されうる。
 *
 * 期限（exp）は見ない。governor が読むのはジョブが終わった後で、トークンはふつう
 * それまでに切れている。このトークンは何かを通す鍵としてではなく、誰が作ったかの記録として
 * 読む。古い attempt や別の run のものは、呼ぶ側が中身で落とす。
 */

/** 鍵の一覧（JWKS）のうちの RSA の公開鍵。ほかの種類の鍵は読む側で外す */
export interface SigningKey {
  kid: string;
  n: string;
  e: string;
}

/** GitHub が公開する、トークンを確かめる鍵（JWKS）と、そのトークンの発行元 */
export interface SigningKeys {
  /** github.com では `https://token.actions.githubusercontent.com` */
  issuer: string;
  keys: readonly SigningKey[];
}

/** ここで読む中身。ほかの欄は読まない */
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  repository: z.string(),
  run_id: z.string(),
  run_attempt: z.string(),
  event_name: z.string(),
  /** `<owner>/<repo>/<path>@<ref>`。再利用ワークフローの中のジョブでは、呼ばれた側の名前になる */
  job_workflow_ref: z.string(),
  job_workflow_sha: z.string(),
  runner_environment: z.string(),
});
export type IdTokenClaims = z.infer<typeof claimsSchema>;

export type IdTokenCheck =
  | { ok: true; claims: IdTokenClaims }
  /** 鍵の一覧に無い鍵で署名している。GitHub が鍵を入れ替えた後の古いトークンもここに来る */
  | { ok: false; reason: "unknown_key"; kid: string }
  /** 形が崩れている（鍵を名指ししないものを含む）、署名が合わない、発行元が違う */
  | { ok: false; reason: "invalid"; detail: string };

const headerSchema = z.object({ alg: z.string(), kid: z.string().optional() });
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function verifyIdToken(token: string, signing: SigningKeys): IdTokenCheck {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
    return invalid("not a JWT");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = headerSchema.safeParse(decodeJson(encodedHeader));
  if (!header.success) {
    return invalid("the JWT header is malformed");
  }
  if (header.data.alg !== "RS256") {
    return invalid(`the JWT is signed with ${header.data.alg}, not RS256`);
  }
  // GitHub のトークンはいつも鍵を名指しする。名指ししないものは、鍵の入れ替えでは説明できない
  const { kid } = header.data;
  if (kid === undefined) {
    return invalid("the JWT header names no key (kid)");
  }
  const jwk = signing.keys.find((key) => key.kid === kid);
  if (jwk === undefined) {
    return { ok: false, reason: "unknown_key", kid };
  }
  let signed: boolean;
  try {
    signed = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch (error) {
    return invalid(`could not verify the signature: ${String(error)}`);
  }
  if (!signed) {
    return invalid("the JWT signature does not match");
  }
  const claims = claimsSchema.safeParse(decodeJson(encodedClaims));
  if (!claims.success) {
    return invalid(`the JWT claims are malformed: ${claims.error.message}`);
  }
  if (claims.data.iss !== signing.issuer) {
    return invalid(`the JWT is issued by ${claims.data.iss}, not ${signing.issuer}`);
  }
  return { ok: true, claims: claims.data };
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function invalid(detail: string): IdTokenCheck {
  return { ok: false, reason: "invalid", detail };
}
