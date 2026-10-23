import { z } from "zod";

/**
 * 変更の種別。Issue と PR の `kind:*` ラベルと同じ語を使う。
 *
 * 種別は「人がマージするか」を決める入力の1つになる。値は作業の出どころ（トリアージが
 * 受けた Issue）で決まるもので、Actor が名乗ったものを使ってはいけない。
 *
 * **種別で決まらないもの**は、パスで当てる承認ルール。どの種別を名乗っても、下限の
 * パスに触れた変更は人がマージする。**種別で決まるもの**は、求めるエビデンスの段と、
 * `kinds` で当てる承認ルール。種別が偽られると、こちらは低い側で判定される。lint・docs・
 * flaky でも型とスナップショットの差分は人に回すので、表に出る振る舞いの変化は拾うが、
 * 型を変えないソースの変更までは種別だけでは拾えない（`decideAutoMerge`）。
 *
 * `migration` はラベルには無いが、ポリシーの承認ルールが「永続データの形式」を
 * 種別で当てるために使う（設計の `policy.yaml` の例）。`harness` はハーネスの整備の
 * Goal が出す変更で、`verify/**` などを書くので、ふつうは下限の承認ルールに当たる。
 */
export const workKindSchema = z.enum([
  "fix",
  "feat",
  "refactor",
  "docs",
  "lint",
  "deps",
  "flaky",
  "harness",
  "migration",
]);
export type WorkKind = z.infer<typeof workKindSchema>;

/**
 * 自動マージを許してよい種別の全体。プロファイルの `max.auto_merge` も、ポリシーの
 * `auto_merge` も、この中からしか選べない。
 *
 * `harness` と `migration` を入れないのは、どちらも検査の正解か永続データの形式を
 * 動かす変更で、設計がいつも人のマージに回すため。下限の承認ルールには `kinds` で当てる
 * 規則が無く、プロファイルが足さない限り種別だけでは規則に当たらない。人に回るのは、
 * ここで外しているからで、規則に当たるからではない。
 */
export const AUTO_MERGEABLE_KINDS = [
  "deps",
  "lint",
  "docs",
  "flaky",
  "refactor",
  "fix",
  "feat",
] as const satisfies readonly WorkKind[];

export const autoMergeableKindSchema = z.enum(AUTO_MERGEABLE_KINDS);
export type AutoMergeableKind = z.infer<typeof autoMergeableKindSchema>;

/**
 * 種別がポリシーの `auto_merge` にあるか。`decideAutoMerge` とトリアージが同じ問いに使う。
 *
 * `AUTO_MERGEABLE_KINDS` の外の種別は、`auto_merge` に入っていても許さない。型と schema が
 * 入れさせないが、`EffectivePolicy` はただの値なので、別の経路で作った値（キャッシュから
 * 読み戻した、型を外して組み立てた）からは入りうる。承認ルールの下限を足し直すのと同じく、
 * 判定する側でも確かめる。
 */
export function allowsAutoMerge(
  autoMerge: readonly AutoMergeableKind[],
  kind: WorkKind,
): kind is AutoMergeableKind {
  return (
    (AUTO_MERGEABLE_KINDS as readonly WorkKind[]).includes(kind) &&
    (autoMerge as readonly WorkKind[]).includes(kind)
  );
}
