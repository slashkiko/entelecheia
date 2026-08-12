# AGENTS.md

このリポジトリで `ent` を叩く手順は `.claude/skills/ent/SKILL.md` に書いてある。
Claude Code はそこを skill として拾う。Codex は `.agents/skills/ent` の symlink から
同じ正本を拾い、それ以外のエージェントはこのファイルから辿る。

手順はここに写さない。2箇所に同じことを書くと、片方だけ古くなったときに
どちらが正か分からなくなる。読むのは `.claude/skills/ent/SKILL.md` の1箇所だけにする。

**ent 自身のコードに手を入れるときの決まりは `CLAUDE.md` にある。** ent を使う手順
（SKILL.md）とは別で、回す口を mise の task に通すことと、同じディレクトリから
並列で回さないことが書いてある。ent を直す作業に入る前に読む。

人間向けの導入は `README.md`（英語。日本語は `README.ja.md` で、中身は同じ）、
設計の背景は `docs/design.md` にある。
