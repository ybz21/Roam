# Claude Code Project Instructions

规则的**唯一出处是 [AGENTS.md](AGENTS.md)**，这里不再抄第二份。抄两份必然走散：
改一条图标规则要改两处、改一条令牌规则要改两处，最后 Codex 按 `AGENTS.md`、
Claude Code 按 `CLAUDE.md`，两个 agent 照着不同版本的规则改同一个仓库。

@AGENTS.md

上面那行是 Claude Code 的文件导入语法，会把 `AGENTS.md` 全文并进上下文；
Codex 本来就直接读 `AGENTS.md`。两边拿到的是同一份。

**新增或修改规则一律写进 `AGENTS.md`，不要写在这个文件里。**
