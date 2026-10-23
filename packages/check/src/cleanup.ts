import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * verify の子のプロセスグループと切り出しの後始末。終わったときと、止められたときの両方で使う。
 *
 * Actions がジョブを取り消すと、ent-check には SIGINT か SIGTERM が届く。Node の既定では
 * そのまま終わるので、verify の子（`detached` で別のプロセスグループに立てる）は親を失って
 * 動き続け、切り出しの一時ディレクトリも残る。手元で Ctrl-C したときも同じになる。
 * `exitOnInterrupt` は、両方を片付けてから、シグナルで止まったことを終了コードに残して終わる。
 *
 * 後始末は同期で行う。非同期にすると、片付けを待つ間に、止めた子の close を受けた検査が
 * 次の verify を立てうる。
 */

const groups = new Set<number>();
const scratches = new Set<string>();

/** 動いている子のプロセスグループを覚える。戻り値で忘れる */
export function trackGroup(pid: number): () => void {
  groups.add(pid);
  return () => {
    groups.delete(pid);
  };
}

/** 切り出しの置き場を覚える。戻り値で忘れる */
export function trackScratch(dir: string): () => void {
  scratches.add(dir);
  return () => {
    scratches.delete(dir);
  };
}

/** プロセスグループをまとめて止める。もう居なければ何もしない */
export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // もう居ない
  }
}

/**
 * 切り出しを消す。消せなくても投げない。
 *
 * 中には head のコードが作ったファイルがある。権限を外したディレクトリを残されると
 * `rm` は EACCES で投げ、その例外が出来上がった報告を押しのけて「検査できなかった」に
 * なる。head の不合格を head の側で取り消せてしまう。
 */
export function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // 権限を戻してもう一度試す
  }
  try {
    restoreWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`ent-check: could not remove ${dir}: ${String(error)}\n`);
  }
}

function restoreWritable(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      restoreWritable(join(dir, entry.name));
    }
  }
}

/** 覚えている子を止め、切り出しを消す */
export function cleanUp(): void {
  for (const pid of groups) killGroup(pid);
  groups.clear();
  for (const dir of scratches) removeScratch(dir);
  scratches.clear();
}

/** シグナルの番号。終了コードは 128 にこれを足したものにする（シェルと同じ） */
const SIGNALS = [
  ["SIGINT", 2],
  ["SIGTERM", 15],
] as const;

/**
 * SIGINT と SIGTERM を受けたら、後始末をしてから終わる。戻り値で受けるのをやめる
 */
export function exitOnInterrupt(): () => void {
  const removers = SIGNALS.map(([signal, number]) => {
    const handler = () => {
      process.stderr.write(`ent-check: stopped by ${signal}\n`);
      cleanUp();
      process.exit(128 + number);
    };
    process.on(signal, handler);
    return () => {
      process.off(signal, handler);
    };
  });
  return () => {
    for (const remove of removers) remove();
  };
}
