// 快捷键表：每个"动作"对应哪些按键。
// 组件只问"这个按键是不是'向左移动'"，不关心具体是哪个键。用户想换键位，只要改这张表（里程碑 20 从设置文件读取）。
// 对应 pi 的 packages/tui/src/keybindings.ts。
import { keyId, parseKey } from "./keys.ts";

export const DEFAULT_KEYBINDINGS = {
	"editor.cursorUp": ["up"],
	"editor.cursorDown": ["down"],
	"editor.cursorLeft": ["left", "ctrl+b"],
	"editor.cursorRight": ["right", "ctrl+f"],
	"editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
	"editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
	"editor.cursorLineStart": ["home", "ctrl+a"],
	"editor.cursorLineEnd": ["end", "ctrl+e"],
	"editor.deleteCharBackward": ["backspace"],
	"editor.deleteCharForward": ["delete", "ctrl+d"],
	"editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
	"editor.deleteToLineStart": ["ctrl+u"],
	"editor.deleteToLineEnd": ["ctrl+k"],
	"input.submit": ["enter"],
	// 大多数终端分不清 Shift+Enter 和 Enter，所以换行用 Alt+Enter 或 Ctrl+J
	"input.newLine": ["alt+enter", "ctrl+j"],
	"input.cancel": ["escape"],
	// 选择列表
	"select.up": ["up", "ctrl+p"],
	"select.down": ["down", "ctrl+n"],
	"select.confirm": ["enter"],
	"select.cancel": ["escape"],
	// 确认对话框
	"dialog.allow": ["y"],
	"dialog.deny": ["n", "escape"],
	// 交互模式的全局快捷键（不管焦点在哪个组件上都有效）
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.complete": ["tab"],
} satisfies Record<string, string[]>;

/** 所有动作的名字："editor.cursorUp" | "editor.cursorDown" | …… */
export type KeyAction = keyof typeof DEFAULT_KEYBINDINGS;

let keybindings: Record<KeyAction, string[]> = { ...DEFAULT_KEYBINDINGS };

/**
 * 把用户写的按键名整理成统一的格式：修饰键按 ctrl、alt、shift 的顺序排列，全部小写。
 * 比如 "Shift+Ctrl+Up" 变成 "ctrl+shift+up"，这样才能和 keyId() 的结果比较。
 */
export function normalizeKeyId(id: string): string {
	const parts = id.toLowerCase().split("+");
	const name = parts.pop() ?? "";
	const modifiers = ["ctrl", "alt", "shift"].filter((modifier) => parts.includes(modifier));
	// 键名大小写有意义的只有 pageUp、pageDown 这类，统一用 keys.ts 里的写法
	const names: Record<string, string> = { pageup: "pageUp", pagedown: "pageDown" };
	return [...modifiers, names[name] ?? name].join("+");
}

/** 把按键名显示得好看一点，用在界面的提示里："ctrl+c" → "Ctrl+C"，"escape" → "Esc"，单独的字母保持原样 */
export function formatKeyId(id: string): string {
	const parts = id.split("+");
	const name = parts.pop() ?? "";
	const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);
	const key = name === "escape" ? "Esc" : name.length === 1 ? (parts.length > 0 ? name.toUpperCase() : name) : capitalize(name);
	return [...parts.map(capitalize), key].join("+");
}

/** 修改快捷键：没有提到的动作保持默认 */
export function setKeybindings(overrides: Partial<Record<KeyAction, string[]>>): void {
	keybindings = { ...DEFAULT_KEYBINDINGS };
	for (const action of Object.keys(overrides) as KeyAction[]) {
		const keys = overrides[action];
		if (keys) keybindings[action] = keys.map(normalizeKeyId);
	}
}

/** 某个动作现在对应哪些按键（显示帮助信息时用） */
export function getKeys(action: KeyAction): string[] {
	return [...keybindings[action]];
}

/** 这个按键是不是触发了某个动作 */
export function matchesAction(data: string, action: KeyAction): boolean {
	return keybindings[action].includes(keyId(parseKey(data)));
}
