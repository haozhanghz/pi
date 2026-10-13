// 键盘输入：把终端送来的字节翻译成"按了哪个键"。
// 在原始模式下，每按一个键，终端就送来一小段文字：字母就是它自己，回车是 \r，方向键是 \x1b[A 这样的转义序列……
// 对应 pi 的 packages/tui/src/keys.ts 和 stdin-buffer.ts。

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export interface Key {
	/** 键名："a"、"enter"、"up"、"backspace"……普通字符就是字符本身 */
	name: string;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

/**
 * 找出 data 里从 start 开始的第一个完整的按键，返回它的长度。
 * 返回 0 表示这个按键还不完整（比如只收到了转义序列的前半段），要等后面的数据。
 */
function keyLength(data: string, start: number): number {
	if (data.startsWith(PASTE_START, start)) {
		const end = data.indexOf(PASTE_END, start);
		return end === -1 ? 0 : end + PASTE_END.length - start; // 粘贴的内容整体算一个"按键"
	}
	if (data[start] !== "\x1b") {
		return String.fromCodePoint(data.codePointAt(start) ?? 0).length; // 一个字符（汉字、emoji 可能占两个 UTF-16 单元）
	}
	const next = data[start + 1];
	if (next === undefined) return 0; // 单独一个 ESC：可能是 Esc 键，也可能是转义序列的开头，先等等
	if (next === "[") {
		// CSI：ESC [ 参数（数字、分号）… 结尾的字母
		for (let i = start + 2; i < data.length; i++) {
			const code = data.charCodeAt(i);
			if (code >= 0x40 && code <= 0x7e) return i + 1 - start;
		}
		return 0;
	}
	if (next === "O") return data.length >= start + 3 ? 3 : 0; // SS3：ESC O 字母（有的终端这样发方向键、Home、End）
	// ESC 加上一个字符：Alt + 这个字符
	return 1 + String.fromCodePoint(data.codePointAt(start + 1) ?? 0).length;
}

/**
 * 把收到的数据切成一个个按键。一次收到的数据可能包含好几个按键（打字很快、输入法一次输入好几个字），
 * 也可能只是一个按键的一部分（转义序列被拆开了）。不完整的部分留在缓冲区里，等下一块数据。
 */
export class KeyBuffer {
	private buffer = "";

	/** 放进新的数据，返回已经完整的按键 */
	push(data: string): string[] {
		this.buffer += data;
		const keys: string[] = [];
		let start = 0;
		while (start < this.buffer.length) {
			const length = keyLength(this.buffer, start);
			if (length === 0) break;
			keys.push(this.buffer.slice(start, start + length));
			start += length;
		}
		this.buffer = this.buffer.slice(start);
		return keys;
	}

	/** 是否有不完整的数据在等待 */
	get pending(): boolean {
		return this.buffer.length > 0;
	}

	/** 等了一会儿也没有后续数据：把剩下的内容当作按键交出去（单独的 ESC 就是 Esc 键） */
	flush(): string[] {
		if (!this.buffer) return [];
		const rest = this.buffer;
		this.buffer = "";
		if (rest.startsWith(PASTE_START)) return [rest]; // 粘贴没有收到结尾：把已有的内容交出去
		return rest === "\x1b" ? [rest] : [...rest];
	}
}

/** 常见的转义序列和它们代表的键 */
const SEQUENCES: Record<string, string> = {
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\x1b[H": "home",
	"\x1b[F": "end",
	"\x1bOH": "home",
	"\x1bOF": "end",
	"\x1b[1~": "home",
	"\x1b[4~": "end",
	"\x1b[7~": "home",
	"\x1b[8~": "end",
	"\x1b[2~": "insert",
	"\x1b[3~": "delete",
	"\x1b[5~": "pageUp",
	"\x1b[6~": "pageDown",
};

/** 解析一个按键 */
export function parseKey(sequence: string): Key {
	const key = (name: string, modifiers: Partial<Key> = {}): Key => ({
		name,
		ctrl: false,
		alt: false,
		shift: false,
		...modifiers,
	});

	switch (sequence) {
		case "\r":
			return key("enter");
		case "\n":
			return key("j", { ctrl: true }); // 原始模式下，回车键送来 \r，Ctrl+J 送来 \n
		case "\t":
			return key("tab");
		case "\x1b[Z":
			return key("tab", { shift: true });
		case "\x7f":
		case "\b":
			return key("backspace");
		case "\x1b":
			return key("escape");
		case "\x1b\r":
			return key("enter", { alt: true });
		case "\x1b\x7f":
			return key("backspace", { alt: true });
	}
	if (sequence in SEQUENCES) return key(SEQUENCES[sequence]);

	// 带修饰键的方向键等：ESC [ 1 ; 修饰 字母，比如 Ctrl+右方向键是 \x1b[1;5C
	const modified = sequence.match(/^\x1b\[1;(\d+)([A-DHF])$/);
	if (modified) {
		const bits = Number(modified[1]) - 1; // 修饰值减一后：第 1 位 Shift，第 2 位 Alt，第 3 位 Ctrl
		const name = SEQUENCES[`\x1b[${modified[2]}`];
		return key(name, { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 });
	}

	// Ctrl + 字母：\x01 是 Ctrl+A，\x02 是 Ctrl+B……
	const code = sequence.charCodeAt(0);
	if (sequence.length === 1 && code >= 1 && code <= 26) {
		return key(String.fromCharCode(code + 96), { ctrl: true });
	}

	// Alt + 字符：ESC 后面跟着这个字符
	if (sequence.length >= 2 && sequence[0] === "\x1b" && !sequence.startsWith("\x1b[") && !sequence.startsWith("\x1bO")) {
		return { ...parseKey(sequence.slice(1)), alt: true };
	}

	return key(sequence);
}

/** 把按键写成 "ctrl+c"、"alt+enter"、"shift+tab" 这样的名字 */
export function keyId(key: Key): string {
	return [key.ctrl && "ctrl", key.alt && "alt", key.shift && "shift", key.name].filter(Boolean).join("+");
}

/** 判断一个按键是不是指定的键，比如 matchesKey(data, "ctrl+c") */
export function matchesKey(sequence: string, id: string): boolean {
	return keyId(parseKey(sequence)) === id;
}

/** 是不是一段粘贴的内容 */
export function isPaste(sequence: string): boolean {
	return sequence.startsWith(PASTE_START);
}

/** 取出粘贴的内容（去掉开头和结尾的标记） */
export function pasteContent(sequence: string): string {
	const content = sequence.slice(PASTE_START.length);
	return content.endsWith(PASTE_END) ? content.slice(0, -PASTE_END.length) : content;
}

/** 是不是一个可以输入的字符（而不是控制键） */
export function isPrintable(sequence: string): boolean {
	return !sequence.startsWith("\x1b") && sequence.length > 0 && !/^[\x00-\x1f\x7f]$/.test(sequence);
}
