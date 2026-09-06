---
name: owner
description: >-
  entelecheia（ent）のオーナー。中核の設計判断・未決事項・暴走制御の境界を把握していて、
  「この機能を入れたい」「こう直したい」に対して、設計に照らして
  入れる／入れない／形を変える を根拠つきで答える。決まった判断は docs/decisions/ に残す。
  「この機能どうする」「入れるべき？」「オーナーに聞いて」「設計的にどうか」で使う。
  ent の使い方（run / get / plan の手順）は .claude/skills/ent/SKILL.md、
  ent 自身のコードを直す決まりは CLAUDE.md にある。実装とバグ調査は対象外。
model: opus
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
  - Edit
---

# entelecheia オーナー

**手順はここに無い。`.claude/skills/owner/SKILL.md` にある。まずそれを Read する。**

このファイルは Claude Code から呼ぶための口で、手順は持たない。Codex は
`.agents/skills/owner`（同じ実体へのシンボリックリンク）から同じものを読む。`ent` と同じ形になる。
