// 测试用的临时目录：每个测试一个，测试结束后自动删除
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function makeTempDir(t: TestContext): Promise<string> {
	// macOS 的临时目录 /var/folders/... 是 /private/var/folders/... 的符号链接，
	// 在里面运行的程序用 process.cwd() 得到的是后者。用 realpath 换成真实的路径，比较路径时才不会出错
	const dir = await realpath(await mkdtemp(join(tmpdir(), "mini-pi-test-")));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
