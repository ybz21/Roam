// 终端里那一路 Claude 的探测结果：在跑没有、正在改哪个文件、工作目录是哪。
// 由 /sessions 的轮询填，终端面板与单终端页共用。
export interface ClaudeInfo { running: boolean; file?: string; dir?: string }
