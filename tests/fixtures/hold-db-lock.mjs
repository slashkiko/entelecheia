// SQLite の書き込みロックを一定時間だけ握ったまま離さない子プロセス。
//
// 「別の ent プロセスが同じ goals.db を掴んでいる」状況を、テストから決定的に
// 作るために使う。同じプロセス内の2本目の接続では再現できない。openStore は
// 同期なので、ロックの解放をタイマーに任せると自分がイベントループを塞いで
// 永久に待つ。掴む側を別プロセスに出すのはそのため。
//
// node:sqlite しか使わない。src/ を import しないので、ビルドも loader も要らない。
//
// 引数: <dbPath> <holdMs>
import { DatabaseSync } from "node:sqlite";

const [dbPath, holdMs] = process.argv.slice(2);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("CREATE TABLE IF NOT EXISTS holder (i INTEGER)");
// journal_mode を WAL に変える側とぶつかるロックを握る。
db.exec("BEGIN EXCLUSIVE");
db.exec("INSERT INTO holder (i) VALUES (1)");

// 親は この1行を読んでから openStore する。握る前に開かれるとテストが素通りする。
process.stdout.write("locked\n");

setTimeout(() => {
  db.exec("COMMIT");
  db.close();
  process.stdout.write("released\n");
}, Number(holdMs));
