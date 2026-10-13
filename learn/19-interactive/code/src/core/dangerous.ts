// 危险命令的识别：执行之前先问用户。交互模式和简单交互模式都要用，所以放在 core 里。
// 和 pi 的示例扩展 permission-gate.ts 一样，用正则表达式识别。
// 这只是一道"防止手滑"的保险，不是真正的安全措施：模型完全可以换一种写法绕过去（见里程碑 12）。
export const DANGEROUS_PATTERNS = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bgit\s+push\b/i,
	/\bgit\s+reset\s+--hard\b/i,
];

export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}
