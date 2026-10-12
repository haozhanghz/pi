function makeGreeting(name: string): string {
	return `你好，${name}`;
}

const user = undefined as unknown as { name: string };

console.log(makeGreeting("小明"));
console.log(makeGreeting(user.name));
