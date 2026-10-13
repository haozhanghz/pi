// 测试用的临时目录：每个测试一个，测试结束后自动删除
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function makeTempDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mini-pi-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
