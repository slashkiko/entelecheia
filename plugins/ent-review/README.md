# ent-review plugin

レビュー役の Actor にだけ読ませる skill を入れる場所。`src/adapters/claude.ts` が
`plugins: [{ type: "local", path: ... }]` でここを指す。

`settingSources: []` を置いたまま skill を渡すための包み紙になる。ホストの
`~/.claude` とリポジトリの `.claude` は読ませないまま、ここに置いたものだけが
Agent から見える。

## 中の skill は ent に依存しない

`skills/semantic-review/` は、ent の外でも同じものが使われる汎用の skill で、
`~/.claude/skills/semantic-review/` にある実体のコピーになる。**Goal・criteria・
verdict といった ent の語彙をここに書かない。** ent 側の読み替え——PR ではなく
worktree の HEAD を見ること、意図の一次情報が Goal YAML であること、末尾に
`reviewed_sha:` と `verdict:` の2行を足すこと——は、すべて
`src/adapters/claude.ts` の `REVIEW_PROMPT` が持つ。

そうしておくと、skill を別リポジトリへ切り出すときに `cp` だけで済む。

## 更新するとき

`~/.claude/skills/semantic-review/` を直したら、こちらへコピーし直す。
手元で二重管理を避けたければ、`skills/semantic-review` を実体への symlink に
しても plugin として認識される（配布物には実体を入れる）。
