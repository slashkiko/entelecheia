import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { SigningKeys } from "../src/id-token.js";

/**
 * テスト用の OIDC トークン。GitHub の代わりに、ここで作った RSA の鍵で署名する。
 * 発行元と鍵の id はダミーと分かる値にする。
 */

export const ISSUER = "https://token.actions.example.test";
export const KEY_ID = "test-key-1";

function keyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

const signer = keyPair();
/** 鍵の一覧に載らない鍵。署名が合わないトークンを作る */
export const OTHER_KEY = keyPair().privateKey;

function publicJwk(key: KeyObject, kid: string) {
  const { n, e } = key.export({ format: "jwk" });
  if (n === undefined || e === undefined) throw new Error("not an RSA key");
  return { kid, n, e };
}

export const SIGNING_KEYS: SigningKeys = {
  issuer: ISSUER,
  keys: [publicJwk(signer.publicKey, KEY_ID)],
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export interface TokenOptions {
  header?: Record<string, unknown>;
  /** 署名する鍵。既定は鍵の一覧に載っている鍵 */
  key?: KeyObject;
}

export function idToken(claims: Record<string, unknown>, options: TokenOptions = {}): string {
  const header = encode(options.header ?? { alg: "RS256", kid: KEY_ID, typ: "JWT" });
  const payload = encode(claims);
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    options.key ?? signer.privateKey,
  );
  return `${header}.${payload}.${signature.toString("base64url")}`;
}
