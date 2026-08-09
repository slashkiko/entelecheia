import type { CodeProviderPort } from "../observe/index.js";

/**
 * GitHub 向けの CodeProviderPort。octokit を使う。
 *
 * design.md §3.4 のとおり webhook は使わず、ETag による conditional request で
 * ポーリングする。304 が返ればレート制限をほぼ消費しない。
 */

export interface GitHubOptions {
  owner: string;
  repo: string;
  token: string;
  /**
   * テストから注入する fetch。実運用では省略して octokit の既定に任せる。
   * ここを口にしておくことで、テストが実際の GitHub を叩かずに済む。
   */
  fetch?: typeof fetch;
}

/**
 * Port を組み立てる。
 *
 * 満たすべき性質:
 * - 対象が無ければ null を返し、取得に失敗したら throw する。
 *   observe がこの2つを Fact の不在に畳まないための前提（design.md §3.1）
 * - 404 は「存在しない」なので null。それ以外の失敗は throw
 * - 認証が無い・落ちているなど、待っても直るとは限らない失敗は
 *   PortError("unavailable") にする
 * - ETag を覚え、次の呼び出しで If-None-Match を送る。304 なら前回の値を返す
 * - evidence に載せるため、observe が組み立てる Port 呼び出し名ではなく
 *   `GET /repos/{owner}/{repo}/pulls/{n}` の形をエラーメッセージに残す
 */
export function githubCodeProvider(_options: GitHubOptions): CodeProviderPort {
  throw new Error("not implemented");
}
