import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings } from "../src/core/settings.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

test("没有设置文件：全部用默认值", async (t) => {
	const dir = await makeTempDir(t);
	assert.deepEqual(loadSettings(dir), { settings: DEFAULT_SETTINGS, errors: [] });
});

test("只写了一部分：其他的保持默认，嵌套的设置也是", async (t) => {
	const dir = await makeTempDir(t);
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ defaultModel: "deepseek/deepseek-chat", retry: { maxRetries: 5 }, keybindings: { "input.submit": ["ctrl+s"] } }),
	);
	const { settings, errors } = loadSettings(dir);
	assert.deepEqual(errors, []);
	assert.equal(settings.defaultModel, "deepseek/deepseek-chat");
	assert.deepEqual(settings.retry, { enabled: true, maxRetries: 5, baseDelayMs: 2000 });
	assert.equal(settings.confirmDangerous, true);
	assert.deepEqual(settings.keybindings, { "input.submit": ["ctrl+s"] });
});

test("写错了：整个文件都不用，并且说清楚错在哪里", async (t) => {
	const dir = await makeTempDir(t);
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ confirmDanger: false, retry: { maxRetries: "5" } }));
	const { settings, errors } = loadSettings(dir);
	assert.deepEqual(settings, DEFAULT_SETTINGS);
	assert.match(errors[0], /设置文件有错误，已忽略/);
	assert.ok(errors.some((error) => error.includes("settings.confirmDanger：不认识的参数")));
	assert.ok(errors.some((error) => error.includes("settings.retry.maxRetries：必须是整数")));
});

test("不是合法的 JSON：忽略，并报告", async (t) => {
	const dir = await makeTempDir(t);
	writeFileSync(join(dir, "settings.json"), "{ defaultModel: deepseek }");
	const { settings, errors } = loadSettings(dir);
	assert.deepEqual(settings, DEFAULT_SETTINGS);
	assert.match(errors[0], /不是合法的 JSON/);
});
