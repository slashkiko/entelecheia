import { describe, expect, it } from "vitest";
import { verifyIdToken } from "../src/id-token.js";
import { ISSUER, idToken, KEY_ID, OTHER_KEY, SIGNING_KEYS } from "./id-token-fixture.js";

const CLAIMS = {
  iss: ISSUER,
  aud: "ent-evidence:sha256:0000",
  repository: "example-owner/sample-shop",
  run_id: "100",
  run_attempt: "1",
  event_name: "pull_request",
  job_workflow_ref: `example-owner/entelecheia/.github/workflows/check.yml@${"c".repeat(40)}`,
  job_workflow_sha: "c".repeat(40),
  runner_environment: "github-hosted",
  // 読まない欄は残っていてよい
  exp: 946684800,
};

describe("OIDC トークンの署名", () => {
  it("一覧の鍵で RS256 の署名が合えば、中身を返す", () => {
    const { exp: _exp, ...read } = CLAIMS;

    expect(verifyIdToken(idToken(CLAIMS), SIGNING_KEYS)).toEqual({ ok: true, claims: read });
  });

  it("期限の切れたトークンも読む", () => {
    // governor が読むのはジョブが終わった後で、トークンはふつうそれまでに切れている
    expect(verifyIdToken(idToken({ ...CLAIMS, exp: 1 }), SIGNING_KEYS)).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["none", { alg: "none", kid: KEY_ID }],
    // 公開鍵を共有鍵として読ませる形
    ["HS256", { alg: "HS256", kid: KEY_ID }],
  ])("alg が %s なら受け取らない", (alg, header) => {
    expect(verifyIdToken(idToken(CLAIMS, { header }), SIGNING_KEYS)).toEqual({
      ok: false,
      reason: "invalid",
      detail: `the JWT is signed with ${alg}, not RS256`,
    });
  });

  it("一覧に無い鍵のトークンは、鍵が分からないと言う", () => {
    // GitHub が鍵を入れ替えた後の古いトークンもここに来る。回し直せば新しい鍵で取り直せる
    const header = { alg: "RS256", kid: "rotated-key" };

    expect(verifyIdToken(idToken(CLAIMS, { header }), SIGNING_KEYS)).toEqual({
      ok: false,
      reason: "unknown_key",
      kid: "rotated-key",
    });
  });

  it("鍵を名指ししないトークンは受け取らない", () => {
    // 鍵の入れ替えでは起きない。回し直しで済ませると、偽ったものを監査に残せない
    expect(verifyIdToken(idToken(CLAIMS, { header: { alg: "RS256" } }), SIGNING_KEYS)).toEqual({
      ok: false,
      reason: "invalid",
      detail: "the JWT header names no key (kid)",
    });
  });

  it("一覧の鍵 id を名乗って別の鍵で署名したものは受け取らない", () => {
    expect(verifyIdToken(idToken(CLAIMS, { key: OTHER_KEY }), SIGNING_KEYS)).toEqual({
      ok: false,
      reason: "invalid",
      detail: "the JWT signature does not match",
    });
  });

  it("署名の後で中身を書き換えたものは受け取らない", () => {
    const [header, , signature] = idToken(CLAIMS).split(".");
    const forged = Buffer.from(JSON.stringify({ ...CLAIMS, run_id: "101" })).toString("base64url");

    expect(verifyIdToken(`${header}.${forged}.${signature}`, SIGNING_KEYS)).toMatchObject({
      ok: false,
      detail: "the JWT signature does not match",
    });
  });

  it("発行元が違えば受け取らない", () => {
    const token = idToken({ ...CLAIMS, iss: "https://issuer.example.test" });

    expect(verifyIdToken(token, SIGNING_KEYS)).toMatchObject({
      ok: false,
      detail: `the JWT is issued by https://issuer.example.test, not ${ISSUER}`,
    });
  });

  it("読む欄が欠けていれば受け取らない", () => {
    const { job_workflow_sha: _sha, ...partial } = CLAIMS;

    expect(verifyIdToken(idToken(partial), SIGNING_KEYS)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("claims are malformed"),
    });
  });

  it.each([
    ["空", ""],
    ["2つに分かれる", "a.b"],
    ["base64url でない文字がある", "a.b.c=="],
    ["ヘッダが JSON でない", `${Buffer.from("{").toString("base64url")}.b.c`],
  ])("%s 文字列は JWT として読まない", (_label, token) => {
    expect(verifyIdToken(token, SIGNING_KEYS)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("末尾の改行は落として読む", () => {
    // ワークフローは jq の出力をそのままファイルに書く
    expect(verifyIdToken(`${idToken(CLAIMS)}\n`, SIGNING_KEYS)).toMatchObject({ ok: true });
  });
});
